//! gRPC over HTTP/2: unary and all three streaming kinds.
//!
//! Message shapes come from the user's `.proto` files, or from the server's own
//! reflection service when none are given. Either way there is no build step —
//! type a body, press send — and no protoc on the machine.
//!
//! The transport is tonic rather than a hand-rolled framing layer over reqwest.
//! That is not a tidying exercise: `grpc-status` travels in HTTP/2 *trailers*
//! for every call that is not an immediate failure, and reqwest does not expose
//! trailers at all. The old code read the status out of the response headers,
//! which only ever caught the trailers-only error case — a call that failed
//! partway through looked like a success with a short reply. tonic surfaces the
//! real `Status`, and gives streaming for free.

use std::time::Duration;

use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::transport::{Channel, ClientTlsConfig};
use tonic::{Request, Status};

/// Reflection is itself a gRPC service; these are the two messages of it that
/// matter, hand-written so the build needs no protoc.
mod reflection {
    use prost::Message;

    #[derive(Clone, PartialEq, Message)]
    pub struct ServerReflectionRequest {
        #[prost(string, tag = "1")]
        pub host: String,
        #[prost(string, tag = "4")]
        pub file_containing_symbol: String,
        #[prost(string, tag = "3")]
        pub list_services: String,
    }

    #[derive(Clone, PartialEq, Message)]
    pub struct FileDescriptorResponse {
        #[prost(bytes = "vec", repeated, tag = "1")]
        pub file_descriptor_proto: Vec<Vec<u8>>,
    }

    #[derive(Clone, PartialEq, Message)]
    pub struct ServiceResponse {
        #[prost(string, tag = "1")]
        pub name: String,
    }

    #[derive(Clone, PartialEq, Message)]
    pub struct ListServiceResponse {
        #[prost(message, repeated, tag = "1")]
        pub service: Vec<ServiceResponse>,
    }

    #[derive(Clone, PartialEq, Message)]
    pub struct ServerReflectionResponse {
        #[prost(string, tag = "1")]
        pub valid_host: String,
        #[prost(message, optional, tag = "4")]
        pub file_descriptor_response: Option<FileDescriptorResponse>,
        #[prost(message, optional, tag = "6")]
        pub list_services_response: Option<ListServiceResponse>,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcSpec {
    /// Host and port, with or without a scheme: `localhost:50051`.
    pub target: String,
    /// Fully qualified, e.g. `helloworld.Greeter/SayHello`.
    pub method: String,
    /// The request message as JSON.
    pub body: String,
    #[serde(default)]
    pub metadata: Vec<crate::http_client::Header>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Plaintext h2c rather than TLS; the default for local servers.
    #[serde(default)]
    pub plaintext: bool,
    /// Local `.proto` files to compile, instead of asking the server for its
    /// descriptors. Reflection is off by default in most production servers,
    /// which leaves this as the only way to reach them.
    #[serde(default)]
    pub proto_files: Vec<String>,
    /// Directories `import` statements are resolved against. The directory of
    /// each file is always searched, so a self-contained proto needs none.
    #[serde(default)]
    pub import_paths: Vec<String>,
    /// Tags the `grpc://message` events of a streaming call, so a pane can tell
    /// its own stream from one started in another tab.
    #[serde(default)]
    pub call_id: Option<String>,
}

/// One message of a server stream, as it arrives.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcStreamMessage {
    pub call_id: String,
    pub index: u32,
    pub body: String,
}

/// One method of a service, as the UI needs to describe it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMethod {
    pub name: String,
    /// `package.Service/Method`, ready to paste into the method field.
    pub full_name: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    pub input_type: String,
    pub output_type: String,
    /// A JSON skeleton of the request message.
    pub input_template: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcResponse {
    /// The reply message as JSON.
    pub body: String,
    pub status: String,
    pub time_ms: u64,
    pub metadata: Vec<crate::http_client::Header>,
}

fn endpoint(target: &str, plaintext: bool) -> String {
    let trimmed = target.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if plaintext {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    }
}

// --- codecs ------------------------------------------------------------------
//
// tonic handles gRPC framing, compression and trailers; a codec only has to say
// how one message turns into bytes and back. tonic 0.14 moved its own prost
// codec into a separate crate, so both of these are written here.

/// Encodes and decodes `DynamicMessage`, whose shape is only known at runtime.
#[derive(Clone)]
struct DynamicCodec {
    output: MessageDescriptor,
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.output.clone())
    }
}

struct DynamicEncoder;

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("could not encode the request: {e}")))
    }
}

struct DynamicDecoder(MessageDescriptor);

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Status> {
        DynamicMessage::decode(self.0.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("could not decode the reply: {e}")))
    }
}

/// The same for a statically known prost message — used by reflection, which is
/// itself a gRPC service and so needs a codec of its own.
struct PbCodec<T, U>(std::marker::PhantomData<fn() -> (T, U)>);

impl<T, U> PbCodec<T, U> {
    fn new() -> Self {
        Self(std::marker::PhantomData)
    }
}

impl<T, U> Codec for PbCodec<T, U>
where
    T: Message + Send + 'static,
    U: Message + Default + Send + 'static,
{
    type Encode = T;
    type Decode = U;
    type Encoder = PbEncoder<T>;
    type Decoder = PbDecoder<U>;

    fn encoder(&mut self) -> Self::Encoder {
        PbEncoder(std::marker::PhantomData)
    }

    fn decoder(&mut self) -> Self::Decoder {
        PbDecoder(std::marker::PhantomData)
    }
}

struct PbEncoder<T>(std::marker::PhantomData<fn() -> T>);

impl<T: Message> Encoder for PbEncoder<T> {
    type Item = T;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("could not encode the request: {e}")))
    }
}

struct PbDecoder<U>(std::marker::PhantomData<fn() -> U>);

impl<U: Message + Default> Decoder for PbDecoder<U> {
    type Item = U;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Status> {
        U::decode(src)
            .map(Some)
            .map_err(|e| Status::internal(format!("could not decode the reply: {e}")))
    }
}

// --- connection --------------------------------------------------------------

/// Opens a channel to the target.
///
/// The proxy is deliberately not honoured. This app can itself be the system
/// proxy, and routing a gRPC call through an HTTP proxy that does not speak h2
/// end to end fails in a way that looks like the server is broken.
async fn connect(endpoint: &str, plaintext: bool, timeout: Duration) -> Result<Channel, String> {
    let mut builder = Channel::from_shared(endpoint.to_string())
        .map_err(|e| format!("`{endpoint}` is not a usable gRPC target: {e}"))?
        .connect_timeout(timeout)
        .timeout(timeout);

    if !plaintext {
        builder = builder
            .tls_config(ClientTlsConfig::new().with_enabled_roots())
            .map_err(|e| format!("cannot set up TLS: {e}"))?;
    }

    builder
        .connect()
        .await
        .map_err(|e| format!("cannot reach {endpoint}: {}", chain(&e)))
}

/// The cause chain of an error. tonic's outer message is often just
/// "transport error", with the real reason one or two levels down.
fn chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.dedup();
    parts.join(": ")
}

/// `/package.Service/Method`, as a path tonic accepts.
fn grpc_path(service: &str, method: &str) -> Result<http::uri::PathAndQuery, String> {
    format!("/{service}/{method}")
        .parse()
        .map_err(|e| format!("`{service}/{method}` is not a valid method path: {e}"))
}

/// Copies user metadata onto a request.
///
/// A `-bin` suffixed key takes raw bytes and a different setter; anything else
/// must be ASCII. An invalid name is reported rather than dropped, because a
/// silently missing auth header looks exactly like a rejected credential.
fn apply_metadata<T>(
    request: &mut Request<T>,
    metadata: &[crate::http_client::Header],
) -> Result<(), String> {
    for entry in metadata {
        let name = entry.name.trim();
        if name.is_empty() {
            continue;
        }
        if name.ends_with("-bin") {
            let key: tonic::metadata::MetadataKey<tonic::metadata::Binary> = name
                .parse()
                .map_err(|_| format!("`{name}` is not a valid metadata key"))?;
            request
                .metadata_mut()
                .insert_bin(key, tonic::metadata::MetadataValue::from_bytes(entry.value.as_bytes()));
            continue;
        }
        let key: tonic::metadata::MetadataKey<tonic::metadata::Ascii> = name
            .parse()
            .map_err(|_| format!("`{name}` is not a valid metadata key"))?;
        let value: tonic::metadata::MetadataValue<tonic::metadata::Ascii> = entry
            .value
            .parse()
            .map_err(|_| format!("`{name}` has a value that is not valid ASCII; use a -bin key for raw bytes"))?;
        request.metadata_mut().insert(key, value);
    }
    Ok(())
}

/// Response metadata, flattened for display.
fn read_metadata(map: &tonic::metadata::MetadataMap) -> Vec<crate::http_client::Header> {
    map.iter()
        .filter_map(|entry| match entry {
            tonic::metadata::KeyAndValueRef::Ascii(key, value) => {
                Some(crate::http_client::Header {
                    name: key.to_string(),
                    value: value.to_str().unwrap_or("<invalid>").to_string(),
                })
            }
            tonic::metadata::KeyAndValueRef::Binary(key, _) => Some(crate::http_client::Header {
                name: key.to_string(),
                value: "<binary>".to_string(),
            }),
        })
        .collect()
}

/// A gRPC failure, said in full: the code's name, the server's message, and any
/// detail it attached.
fn describe(status: &Status) -> String {
    let mut text = format!("{:?} ({})", status.code(), status.code() as i32);
    if !status.message().is_empty() {
        text.push_str(": ");
        text.push_str(status.message());
    }
    text
}

fn to_json(message: &DynamicMessage) -> Result<String, String> {
    let mut serializer = serde_json::Serializer::pretty(Vec::new());
    message
        .serialize_with_options(
            &mut serializer,
            // Field names as written in the .proto, and defaults included, so
            // the shape of the reply is visible rather than implied.
            &SerializeOptions::new()
                .use_proto_field_name(true)
                .skip_default_fields(false),
        )
        .map_err(|e| format!("could not render the reply: {e}"))?;
    String::from_utf8(serializer.into_inner())
        .map_err(|e| format!("the reply was not valid UTF-8 once rendered: {e}"))
}

/// Parses the request body into one or more messages.
///
/// A client-streaming method takes a JSON array, one element per message; a
/// single object is also accepted and sent as one. A unary method takes an
/// object, and an empty body means the default message.
fn parse_messages(
    body: &str,
    input: &MessageDescriptor,
    client_streaming: bool,
) -> Result<Vec<DynamicMessage>, String> {
    let text = body.trim();
    if text.is_empty() {
        return Ok(vec![DynamicMessage::new(input.clone())]);
    }

    let one = |value: &serde_json::Value| -> Result<DynamicMessage, String> {
        DynamicMessage::deserialize(input.clone(), value).map_err(|e| {
            format!("the request body does not match {}: {e}", input.full_name())
        })
    };

    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("the request body is not valid JSON: {e}"))?;

    match value {
        serde_json::Value::Array(items) if client_streaming => {
            if items.is_empty() {
                return Err("a client-streaming call needs at least one message".into());
            }
            items.iter().map(one).collect()
        }
        serde_json::Value::Array(_) => Err(format!(
            "{} is not a client-streaming method, so its body must be a single \
             JSON object rather than an array",
            input.full_name()
        )),
        other => Ok(vec![one(&other)?]),
    }
}

/// One reflection round trip.
///
/// ServerReflectionInfo is declared bidirectional streaming, so it is called as
/// a stream of exactly one request. Half-closing tells a well-behaved server
/// that nothing more is coming, and it answers and completes.
///
/// Both package names are tried: `v1` is current, `v1alpha` is still what many
/// deployed servers expose, and there is no way to tell without asking.
async fn reflection_call(
    channel: &Channel,
    request: reflection::ServerReflectionRequest,
    metadata: &[crate::http_client::Header],
) -> Result<reflection::ServerReflectionResponse, String> {
    let mut last: Option<String> = None;
    for package in ["grpc.reflection.v1", "grpc.reflection.v1alpha"] {
        let path = grpc_path(
            &format!("{package}.ServerReflection"),
            "ServerReflectionInfo",
        )?;

        let mut outbound = Request::new(tokio_stream::once(request.clone()));
        apply_metadata(&mut outbound, metadata)?;

        let mut client = tonic::client::Grpc::new(channel.clone());
        let codec = PbCodec::<
            reflection::ServerReflectionRequest,
            reflection::ServerReflectionResponse,
        >::new();

        match client.streaming(outbound, path, codec).await {
            Ok(response) => {
                let mut stream = response.into_inner();
                match stream.message().await {
                    Ok(Some(message)) => return Ok(message),
                    Ok(None) => {
                        last = Some("the reflection service closed without replying".into());
                    }
                    Err(status) => last = Some(describe(&status)),
                }
            }
            Err(status) => last = Some(describe(&status)),
        }
    }
    Err(last.unwrap_or_else(|| "reflection failed".into()))
}

/// Asks the server for the descriptors covering `symbol`, and builds a pool.
async fn reflect(
    channel: &Channel,
    symbol: &str,
    metadata: &[crate::http_client::Header],
) -> Result<DescriptorPool, String> {
    let request = reflection::ServerReflectionRequest {
        host: String::new(),
        file_containing_symbol: symbol.to_string(),
        list_services: String::new(),
    };
    let decoded = reflection_call(channel, request, metadata).await?;
    let files = decoded
        .file_descriptor_response
        .ok_or_else(|| format!("the server does not know the symbol `{symbol}`"))?;

    let mut pool = DescriptorPool::new();
    for file in files.file_descriptor_proto {
        pool.decode_file_descriptor_set(file.as_slice())
            .map_err(|e| format!("could not read a descriptor: {e}"))?;
    }
    Ok(pool)
}

/// Compiles `.proto` files into a descriptor pool.
///
/// protox is a protobuf compiler in pure Rust, so this works with no protoc on
/// the machine — which matters because requiring one would put a C++ toolchain
/// between the user and their own API.
fn compile_protos(files: &[String], imports: &[String]) -> Result<DescriptorPool, String> {
    let paths: Vec<&String> = files.iter().filter(|f| !f.trim().is_empty()).collect();
    if paths.is_empty() {
        return Err("no .proto files given".into());
    }

    // Every file's own directory is an include path. Without it a plain
    // `protox::compile` rejects the file it was just handed, because the file
    // must be reachable *through* an include path — which is a confusing first
    // experience for a single self-contained proto.
    let mut includes: Vec<std::path::PathBuf> = imports
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    for path in &paths {
        if let Some(parent) = std::path::Path::new(path.as_str()).parent() {
            let parent = parent.to_path_buf();
            if !includes.contains(&parent) {
                includes.push(parent);
            }
        }
    }

    let set = protox::compile(paths.iter().map(|p| p.as_str()), includes)
        // protox errors already name the file and line; the prefix says which
        // stage failed, since a bad import reads much like a bad syntax error.
        .map_err(|e| format!("could not compile the .proto files: {e}"))?;

    DescriptorPool::from_file_descriptor_set(set)
        .map_err(|e| format!("the compiled descriptors are not usable: {e}"))
}

/// Where the message shapes come from: the user's own `.proto` files if they
/// gave any, otherwise the server's reflection service.
///
/// Returns the channel too, so a caller that goes on to make the call does not
/// open a second connection.
async fn descriptors(
    spec: &GrpcSpec,
    symbol: &str,
) -> Result<(DescriptorPool, Option<Channel>), String> {
    if spec.proto_files.iter().any(|f| !f.trim().is_empty()) {
        // No connection is opened at all: the method list has to work before
        // the server is running.
        return Ok((compile_protos(&spec.proto_files, &spec.import_paths)?, None));
    }

    let endpoint = endpoint(&spec.target, spec.plaintext);
    let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let channel = connect(&endpoint, spec.plaintext, timeout).await?;
    let pool = reflect(&channel, symbol, &spec.metadata)
        .await
        // Reflection being absent is the common case, not an exotic failure, so
        // the message points at the alternative rather than just reporting it.
        .map_err(|e| {
            format!(
                "{e}\n\nThis server may not expose reflection — most production \
                 servers do not. Add the service's .proto files instead."
            )
        })?;
    Ok((pool, Some(channel)))
}

fn split_method(method: &str) -> Result<(String, String), String> {
    let cleaned = method.trim().trim_start_matches('/');
    let (service, name) = cleaned
        .rsplit_once('/')
        .or_else(|| cleaned.rsplit_once('.').map(|(s, n)| (s, n)))
        .ok_or_else(|| {
            "write the method as package.Service/Method".to_string()
        })?;
    Ok((service.to_string(), name.to_string()))
}

/// Lists the services available, so the UI can offer them.
///
/// With `.proto` files this needs no server at all, which is the point: the
/// method list works before anything is running.
#[tauri::command]
pub async fn grpc_services(spec: GrpcSpec) -> Result<Vec<String>, String> {
    if spec.proto_files.iter().any(|f| !f.trim().is_empty()) {
        let pool = compile_protos(&spec.proto_files, &spec.import_paths)?;
        let mut names: Vec<String> = pool
            .services()
            .map(|service| service.full_name().to_string())
            .collect();
        // A compiled pool lists in file order; the reflection path returns
        // whatever the server sends. Sorting makes both predictable.
        names.sort();
        return Ok(names);
    }

    let endpoint = endpoint(&spec.target, spec.plaintext);
    let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let channel = connect(&endpoint, spec.plaintext, timeout).await?;

    let request = reflection::ServerReflectionRequest {
        host: String::new(),
        file_containing_symbol: String::new(),
        list_services: "*".into(),
    };
    let decoded = reflection_call(&channel, request, &spec.metadata).await?;

    let mut names: Vec<String> = decoded
        .list_services_response
        .map(|list| list.service.into_iter().map(|item| item.name).collect())
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

/// The methods of one service, with the shape of each request.
///
/// The UI uses this to fill the method picker and to seed the request body, so a
/// user does not have to know the message shape to make a first call.
#[tauri::command]
pub async fn grpc_methods(spec: GrpcSpec, service: String) -> Result<Vec<GrpcMethod>, String> {
    let (pool, _channel) = descriptors(&spec, &service).await?;
    let descriptor = pool
        .get_service_by_name(&service)
        .ok_or_else(|| format!("`{service}` is not in these descriptors"))?;

    Ok(descriptor
        .methods()
        .map(|method| GrpcMethod {
            name: method.name().to_string(),
            full_name: format!("{service}/{}", method.name()),
            client_streaming: method.is_client_streaming(),
            server_streaming: method.is_server_streaming(),
            input_type: method.input().full_name().to_string(),
            output_type: method.output().full_name().to_string(),
            input_template: template_for(&method.input()),
        })
        .collect())
}

/// A JSON skeleton of a message, so the body field starts from the right shape
/// rather than an empty object.
///
/// One level deep only: a recursive message type would not terminate, and a
/// deeply nested skeleton is harder to read than the field it stands for.
fn template_for(descriptor: &prost_reflect::MessageDescriptor) -> String {
    let mut object = serde_json::Map::new();
    for field in descriptor.fields() {
        object.insert(field.name().to_string(), example_value(&field));
    }
    serde_json::to_string_pretty(&object).unwrap_or_else(|_| "{}".into())
}

fn example_value(field: &prost_reflect::FieldDescriptor) -> serde_json::Value {
    use prost_reflect::Kind;
    if field.is_list() {
        return serde_json::Value::Array(vec![]);
    }
    if field.is_map() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    match field.kind() {
        Kind::Bool => serde_json::Value::Bool(false),
        Kind::String => serde_json::Value::String(String::new()),
        Kind::Bytes => serde_json::Value::String(String::new()),
        Kind::Double | Kind::Float => serde_json::json!(0.0),
        Kind::Int32
        | Kind::Int64
        | Kind::Uint32
        | Kind::Uint64
        | Kind::Sint32
        | Kind::Sint64
        | Kind::Fixed32
        | Kind::Fixed64
        | Kind::Sfixed32
        | Kind::Sfixed64 => serde_json::json!(0),
        // The first value is the proto3 default, and naming it is more useful
        // than a number.
        Kind::Enum(descriptor) => descriptor
            .values()
            .next()
            .map(|value| serde_json::Value::String(value.name().to_string()))
            .unwrap_or(serde_json::Value::Null),
        Kind::Message(_) => serde_json::Value::Object(serde_json::Map::new()),
    }
}

/// Invokes a method — unary, or any of the three streaming kinds.
///
/// A server-streaming reply is emitted message by message on `grpc://message` as
/// it arrives, so a long-lived stream shows progress instead of appearing to
/// hang, and the collected messages are also returned when it ends.
#[tauri::command]
pub async fn grpc_call(app: tauri::AppHandle, spec: GrpcSpec) -> Result<GrpcResponse, String> {
    let started = std::time::Instant::now();
    let endpoint = endpoint(&spec.target, spec.plaintext);
    let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let (service, name) = split_method(&spec.method)?;

    let (pool, existing) = descriptors(&spec, &service).await?;
    let service_descriptor = pool
        .get_service_by_name(&service)
        .ok_or_else(|| format!("`{service}` is not in these descriptors"))?;
    let method: MethodDescriptor = service_descriptor
        .methods()
        .find(|candidate| candidate.name() == name)
        .ok_or_else(|| format!("`{service}` has no method `{name}`"))?;

    // Reflection already opened one; .proto files open none.
    let channel = match existing {
        Some(channel) => channel,
        None => connect(&endpoint, spec.plaintext, timeout).await?,
    };

    let messages = parse_messages(&spec.body, &method.input(), method.is_client_streaming())?;
    let path = grpc_path(&service, &name)?;
    let codec = DynamicCodec { output: method.output() };
    let mut client = tonic::client::Grpc::new(channel);

    let call_id = spec.call_id.clone().unwrap_or_default();

    let (bodies, metadata) = match (method.is_client_streaming(), method.is_server_streaming()) {
        (false, false) => {
            let mut request = Request::new(messages.into_iter().next().unwrap());
            apply_metadata(&mut request, &spec.metadata)?;
            let response = client
                .unary(request, path, codec)
                .await
                .map_err(|status| describe(&status))?;
            let metadata = read_metadata(response.metadata());
            (vec![to_json(response.get_ref())?], metadata)
        }
        (true, false) => {
            let mut request = Request::new(tokio_stream::iter(messages));
            apply_metadata(&mut request, &spec.metadata)?;
            let response = client
                .client_streaming(request, path, codec)
                .await
                .map_err(|status| describe(&status))?;
            let metadata = read_metadata(response.metadata());
            (vec![to_json(response.get_ref())?], metadata)
        }
        (false, true) => {
            let mut request = Request::new(messages.into_iter().next().unwrap());
            apply_metadata(&mut request, &spec.metadata)?;
            let response = client
                .server_streaming(request, path, codec)
                .await
                .map_err(|status| describe(&status))?;
            let metadata = read_metadata(response.metadata());
            (drain(&app, &call_id, response.into_inner()).await?, metadata)
        }
        (true, true) => {
            let mut request = Request::new(tokio_stream::iter(messages));
            apply_metadata(&mut request, &spec.metadata)?;
            let response = client
                .streaming(request, path, codec)
                .await
                .map_err(|status| describe(&status))?;
            let metadata = read_metadata(response.metadata());
            (drain(&app, &call_id, response.into_inner()).await?, metadata)
        }
    };

    // A stream's messages are returned as a JSON array so the response pane has
    // one document to show; a unary reply stays the bare object it was.
    let body = if method.is_server_streaming() {
        format!("[\n{}\n]", bodies.join(",\n"))
    } else {
        bodies.into_iter().next().unwrap_or_else(|| "{}".into())
    };

    Ok(GrpcResponse {
        body,
        status: "OK".into(),
        time_ms: started.elapsed().as_millis() as u64,
        metadata,
    })
}

/// Reads a server stream to its end, emitting each message as it arrives.
///
/// The error case is the whole reason this module moved to tonic: a stream that
/// fails partway through ends with a `Status` in the trailers, and the messages
/// already received are still worth keeping — so they are returned alongside the
/// failure rather than being thrown away with it.
async fn drain(
    app: &tauri::AppHandle,
    call_id: &str,
    mut stream: tonic::Streaming<DynamicMessage>,
) -> Result<Vec<String>, String> {
    let mut bodies: Vec<String> = Vec::new();
    loop {
        match stream.message().await {
            Ok(Some(message)) => {
                let json = to_json(&message)?;
                let _ = app.emit(
                    "grpc://message",
                    GrpcStreamMessage {
                        call_id: call_id.to_string(),
                        index: bodies.len() as u32,
                        body: json.clone(),
                    },
                );
                bodies.push(json);
            }
            Ok(None) => return Ok(bodies),
            Err(status) => {
                return Err(format!(
                    "{} (after {} message{})",
                    describe(&status),
                    bodies.len(),
                    if bodies.len() == 1 { "" } else { "s" }
                ))
            }
        }
    }
}

#[cfg(test)]
mod proto_tests {
    use super::*;

    /// Writes a proto into a fresh directory and returns both paths.
    fn write_proto(name: &str, body: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("apikit-proto-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{name}.proto"));
        std::fs::write(&file, body).unwrap();
        (dir, file)
    }

    const GREETER: &str = r#"
syntax = "proto3";
package demo;

enum Tier { TIER_FREE = 0; TIER_PAID = 1; }

message HelloRequest {
  string name = 1;
  int32 times = 2;
  bool loud = 3;
  Tier tier = 4;
  repeated string tags = 5;
  map<string, string> labels = 6;
}
message HelloReply { string message = 1; }

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc StreamHello (HelloRequest) returns (stream HelloReply);
  rpc UploadHellos (stream HelloRequest) returns (HelloReply);
  rpc Chat (stream HelloRequest) returns (stream HelloReply);
}
"#;

    #[test]
    fn a_self_contained_proto_compiles_with_no_include_paths() {
        // The whole point: protox needs the file reachable through an include
        // path, and a user handing over one file should not have to know that.
        let (dir, file) = write_proto("selfcontained", GREETER);
        let pool = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap();
        assert!(pool.get_service_by_name("demo.Greeter").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn streaming_kinds_are_reported_per_method() {
        let (dir, file) = write_proto("streamkinds", GREETER);
        let pool = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap();
        let service = pool.get_service_by_name("demo.Greeter").unwrap();
        let kind = |name: &str| {
            let method = service.methods().find(|m| m.name() == name).unwrap();
            (method.is_client_streaming(), method.is_server_streaming())
        };
        assert_eq!(kind("SayHello"), (false, false));
        assert_eq!(kind("StreamHello"), (false, true));
        assert_eq!(kind("UploadHellos"), (true, false));
        assert_eq!(kind("Chat"), (true, true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_request_template_matches_the_message_shape() {
        let (_dir, file) = write_proto("template", GREETER);
        let pool = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap();
        let message = pool.get_message_by_name("demo.HelloRequest").unwrap();
        let template: serde_json::Value =
            serde_json::from_str(&template_for(&message)).unwrap();

        assert_eq!(template["name"], serde_json::json!(""));
        assert_eq!(template["times"], serde_json::json!(0));
        assert_eq!(template["loud"], serde_json::json!(false));
        // An enum reads better as its first name than as 0.
        assert_eq!(template["tier"], serde_json::json!("TIER_FREE"));
        assert_eq!(template["tags"], serde_json::json!([]));
        assert_eq!(template["labels"], serde_json::json!({}));
    }

    #[test]
    fn the_template_is_valid_input_for_its_own_message() {
        // A skeleton the server would reject is worse than no skeleton.
        let (dir, file) = write_proto("roundtrip", GREETER);
        let pool = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap();
        let message = pool.get_message_by_name("demo.HelloRequest").unwrap();
        let template = template_for(&message);
        let mut deserializer = serde_json::Deserializer::from_str(&template);
        DynamicMessage::deserialize(message, &mut deserializer)
            .expect("the generated template should parse as its own message");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_resolve_against_the_files_own_directory() {
        let dir = std::env::temp_dir().join("apikit-proto-imports");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("common.proto"),
            "syntax = \"proto3\";\npackage demo;\nmessage Id { string value = 1; }\n",
        )
        .unwrap();
        let main = dir.join("main.proto");
        std::fs::write(
            &main,
            "syntax = \"proto3\";\npackage demo;\nimport \"common.proto\";\n\
             service Lookup { rpc Get (Id) returns (Id); }\n",
        )
        .unwrap();

        let pool = compile_protos(&[main.to_string_lossy().into()], &[]).unwrap();
        assert!(pool.get_service_by_name("demo.Lookup").is_some());
        assert!(pool.get_message_by_name("demo.Id").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The offline path: with .proto files the service list must not touch the
    /// network at all. The target here is unroutable, so anything that reached
    /// for reflection would hang or fail rather than pass.
    #[tokio::test]
    async fn services_are_listed_from_files_without_a_server() {
        let (dir, file) = write_proto("offline", GREETER);
        let spec = GrpcSpec {
            target: "192.0.2.1:1".into(),
            method: String::new(),
            body: String::new(),
            metadata: vec![],
            timeout_ms: Some(500),
            plaintext: true,
            proto_files: vec![file.to_string_lossy().into()],
            import_paths: vec![],
            call_id: None,
        };
        let services = grpc_services(spec).await.unwrap();
        assert_eq!(services, vec!["demo.Greeter".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_body_becomes_one_message_or_many_by_streaming_kind() {
        let (dir, file) = write_proto("bodies", GREETER);
        let pool = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap();
        let input = pool.get_message_by_name("demo.HelloRequest").unwrap();

        // Unary: one object, one message.
        let one = parse_messages(r#"{"name":"a"}"#, &input, false).unwrap();
        assert_eq!(one.len(), 1);

        // An empty body is the default message, not an error — pressing send on
        // a method with no required fields should just work.
        assert_eq!(parse_messages("   ", &input, false).unwrap().len(), 1);

        // Client streaming: an array is one message per element.
        let many = parse_messages(r#"[{"name":"a"},{"name":"b"}]"#, &input, true).unwrap();
        assert_eq!(many.len(), 2);

        // A single object is still accepted for a streaming method.
        assert_eq!(parse_messages(r#"{"name":"a"}"#, &input, true).unwrap().len(), 1);

        // An array sent to a non-streaming method is a mistake worth naming
        // rather than silently sending only the first element.
        let error = parse_messages(r#"[{"name":"a"}]"#, &input, false).unwrap_err();
        assert!(error.contains("not a client-streaming method"), "{error}");

        // An empty array for a streaming call has nothing to send.
        assert!(parse_messages("[]", &input, true).is_err());

        // Malformed JSON and a field that is not in the message are both errors,
        // and both name what went wrong.
        assert!(parse_messages("{oops", &input, false)
            .unwrap_err()
            .contains("not valid JSON"));
        assert!(parse_messages(r#"{"nope":1}"#, &input, false)
            .unwrap_err()
            .contains("does not match demo.HelloRequest"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_files_and_bad_syntax_both_report_rather_than_panic() {
        assert!(compile_protos(&[], &[]).is_err());
        assert!(compile_protos(&["  ".into()], &[]).is_err());
        assert!(compile_protos(&["/nonexistent/x.proto".into()], &[]).is_err());

        let (dir, file) = write_proto("broken", "syntax = \"proto3\";\nmessage {{{");
        let error = compile_protos(&[file.to_string_lossy().into()], &[]).unwrap_err();
        assert!(error.contains("could not compile"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Framing, length prefixes and truncation are tonic's responsibility now,
    // so the tests that covered the hand-rolled versions are gone with them.

    #[test]
    fn a_method_path_starts_with_a_slash() {
        // tonic rejects a path without one, and the failure is opaque.
        assert_eq!(
            grpc_path("demo.Greeter", "SayHello").unwrap().as_str(),
            "/demo.Greeter/SayHello"
        );
    }

    #[test]
    fn a_status_reads_as_a_name_a_number_and_the_servers_message() {
        let status = Status::new(tonic::Code::NotFound, "no such user");
        let text = describe(&status);
        assert!(text.contains("NotFound"), "{text}");
        assert!(text.contains("(5)"), "{text}");
        assert!(text.contains("no such user"), "{text}");

        // A code with no message must not leave a dangling colon.
        let bare = describe(&Status::new(tonic::Code::Unavailable, ""));
        assert_eq!(bare, "Unavailable (14)");
    }

    #[test]
    fn methods_are_split_either_way_round() {
        assert_eq!(
            split_method("helloworld.Greeter/SayHello").unwrap(),
            ("helloworld.Greeter".into(), "SayHello".into())
        );
        // A leading slash is what a copied path looks like.
        assert_eq!(
            split_method("/helloworld.Greeter/SayHello").unwrap(),
            ("helloworld.Greeter".into(), "SayHello".into())
        );
        // Dotted form, as gRPC docs often write it.
        assert_eq!(
            split_method("helloworld.Greeter.SayHello").unwrap(),
            ("helloworld.Greeter".into(), "SayHello".into())
        );
        assert!(split_method("nonsense").is_err());
    }

    #[test]
    fn endpoints_get_a_scheme_that_matches_the_mode() {
        assert_eq!(endpoint("localhost:50051", true), "http://localhost:50051");
        assert_eq!(endpoint("api.example.com", false), "https://api.example.com");
        // An explicit scheme is left alone.
        assert_eq!(endpoint("https://api.example.com/", true), "https://api.example.com");
    }
}
