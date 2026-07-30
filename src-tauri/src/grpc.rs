//! gRPC over HTTP/2, driven by server reflection.
//!
//! No `.proto` file is required: the server is asked for its own descriptors,
//! which are used to build a dynamic message from the JSON the user typed and
//! to turn the reply back into JSON. That keeps gRPC feeling like the rest of
//! the app — type a body, press send — rather than a build step.
//!
//! Unary calls only. Streaming methods are listed but refused, because a single
//! request/response pane cannot honestly represent a stream.

use std::time::Duration;

use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MethodDescriptor, SerializeOptions};
use serde::{Deserialize, Serialize};

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

/// Frames a message the way gRPC does: a compression byte, a big-endian length,
/// then the payload.
fn frame(payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(payload.len() + 5);
    framed.push(0);
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);
    framed
}

/// Strips that framing. Returns the first message only, which is all a unary
/// call has.
fn unframe(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 5 {
        return Err("the reply was too short to be a gRPC message".into());
    }
    let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
    body.get(5..5 + length)
        .map(|slice| slice.to_vec())
        .ok_or_else(|| "the reply was truncated".into())
}

/// One raw gRPC call over HTTP/2. Used for both reflection and the user's own
/// method, since they differ only in path and payload.
async fn call_raw(
    client: &reqwest::Client,
    endpoint: &str,
    path: &str,
    payload: Vec<u8>,
    metadata: &[crate::http_client::Header],
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<crate::http_client::Header>), String> {
    let mut request = client
        .post(format!("{endpoint}/{path}"))
        .header("content-type", "application/grpc+proto")
        .header("te", "trailers")
        .timeout(timeout)
        .body(frame(&payload));

    for entry in metadata {
        if !entry.name.trim().is_empty() {
            request = request.header(entry.name.trim(), entry.value.clone());
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("cannot reach {endpoint}: {e}"))?;

    let headers: Vec<crate::http_client::Header> = response
        .headers()
        .iter()
        .map(|(name, value)| crate::http_client::Header {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect();

    // gRPC reports failure in a header, not the HTTP status, which stays 200.
    let status = headers
        .iter()
        .find(|header| header.name == "grpc-status")
        .map(|header| header.value.clone());
    let message = headers
        .iter()
        .find(|header| header.name == "grpc-message")
        .map(|header| header.value.clone())
        .unwrap_or_default();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("could not read the reply: {e}"))?;

    if let Some(code) = status {
        if code != "0" {
            return Err(format!(
                "gRPC status {code}{}",
                if message.is_empty() {
                    String::new()
                } else {
                    format!(": {message}")
                }
            ));
        }
    }

    Ok((bytes.to_vec(), headers))
}

/// Asks the server for the descriptors covering `symbol`, and builds a pool.
async fn reflect(
    client: &reqwest::Client,
    endpoint: &str,
    symbol: &str,
    metadata: &[crate::http_client::Header],
    timeout: Duration,
) -> Result<DescriptorPool, String> {
    let request = reflection::ServerReflectionRequest {
        host: String::new(),
        file_containing_symbol: symbol.to_string(),
        list_services: String::new(),
    };
    let (body, _) = call_raw(
        client,
        endpoint,
        "grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
        request.encode_to_vec(),
        metadata,
        timeout,
    )
    .await
    // The older package name is still what many servers expose.
    .or(
        call_raw(
            client,
            endpoint,
            "grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
            request.encode_to_vec(),
            metadata,
            timeout,
        )
        .await,
    )?;

    let decoded = reflection::ServerReflectionResponse::decode(unframe(&body)?.as_slice())
        .map_err(|e| format!("could not read the reflection reply: {e}"))?;
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
async fn descriptors(
    spec: &GrpcSpec,
    client: &reqwest::Client,
    endpoint: &str,
    symbol: &str,
    timeout: Duration,
) -> Result<DescriptorPool, String> {
    if spec.proto_files.iter().any(|f| !f.trim().is_empty()) {
        return compile_protos(&spec.proto_files, &spec.import_paths);
    }
    reflect(client, endpoint, symbol, &spec.metadata, timeout)
        .await
        // Reflection being absent is the common case, not an exotic failure, so
        // the message points at the alternative rather than just reporting it.
        .map_err(|e| {
            format!(
                "{e}\n\nThis server may not expose reflection — most production \
                 servers do not. Add the service's .proto files instead."
            )
        })
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
    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let request = reflection::ServerReflectionRequest {
        host: String::new(),
        file_containing_symbol: String::new(),
        list_services: "*".into(),
    };
    let (body, _) = call_raw(
        &client,
        &endpoint,
        "grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
        request.encode_to_vec(),
        &spec.metadata,
        timeout,
    )
    .await
    .or(
        call_raw(
            &client,
            &endpoint,
            "grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
            request.encode_to_vec(),
            &spec.metadata,
            timeout,
        )
        .await,
    )?;

    let decoded = reflection::ServerReflectionResponse::decode(unframe(&body)?.as_slice())
        .map_err(|e| format!("could not read the reflection reply: {e}"))?;
    Ok(decoded
        .list_services_response
        .map(|list| list.service.into_iter().map(|item| item.name).collect())
        .unwrap_or_default())
}

/// The methods of one service, with the shape of each request.
///
/// The UI uses this to fill the method picker and to seed the request body, so a
/// user does not have to know the message shape to make a first call.
#[tauri::command]
pub async fn grpc_methods(spec: GrpcSpec, service: String) -> Result<Vec<GrpcMethod>, String> {
    let endpoint = endpoint(&spec.target, spec.plaintext);
    let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let pool = descriptors(&spec, &client, &endpoint, &service, timeout).await?;
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

/// Invokes a unary method, converting JSON in and out via the server's own
/// descriptors.
#[tauri::command]
pub async fn grpc_call(spec: GrpcSpec) -> Result<GrpcResponse, String> {
    let started = std::time::Instant::now();
    let endpoint = endpoint(&spec.target, spec.plaintext);
    let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let (service, name) = split_method(&spec.method)?;

    let client = reqwest::Client::builder()
        // gRPC is HTTP/2 only, and a local server has no TLS to negotiate over.
        .http2_prior_knowledge()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let pool = descriptors(&spec, &client, &endpoint, &service, timeout).await?;
    let service_descriptor = pool
        .get_service_by_name(&service)
        .ok_or_else(|| format!("the server does not expose `{service}`"))?;
    let method: MethodDescriptor = service_descriptor
        .methods()
        .find(|candidate| candidate.name() == name)
        .ok_or_else(|| format!("`{service}` has no method `{name}`"))?;

    if method.is_client_streaming() || method.is_server_streaming() {
        return Err(format!(
            "`{name}` is a streaming method, and only unary calls are supported"
        ));
    }

    let input = spec.body.trim();
    let json = if input.is_empty() { "{}" } else { input };
    let mut deserializer = serde_json::Deserializer::from_str(json);
    let message = DynamicMessage::deserialize(method.input(), &mut deserializer)
        .map_err(|e| format!("the request body does not match {}: {e}", method.input().full_name()))?;
    deserializer
        .end()
        .map_err(|e| format!("trailing content after the request body: {e}"))?;

    let (body, metadata) = call_raw(
        &client,
        &endpoint,
        &format!("{service}/{name}"),
        message.encode_to_vec(),
        &spec.metadata,
        timeout,
    )
    .await?;

    let reply = DynamicMessage::decode(method.output(), unframe(&body)?.as_slice())
        .map_err(|e| format!("could not read the reply: {e}"))?;

    let mut serializer = serde_json::Serializer::pretty(Vec::new());
    reply
        .serialize_with_options(
            &mut serializer,
            // Field names as written in the .proto, and defaults included, so
            // the shape of the reply is visible rather than implied.
            &SerializeOptions::new()
                .use_proto_field_name(true)
                .skip_default_fields(false),
        )
        .map_err(|e| format!("could not render the reply: {e}"))?;

    Ok(GrpcResponse {
        body: String::from_utf8(serializer.into_inner()).unwrap_or_default(),
        status: "OK".into(),
        time_ms: started.elapsed().as_millis() as u64,
        metadata,
    })
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
        let (dir, file) = write_proto("template", GREETER);
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
        };
        let services = grpc_services(spec).await.unwrap();
        assert_eq!(services, vec!["demo.Greeter".to_string()]);
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

    #[test]
    fn framing_round_trips() {
        let payload = b"hello world".to_vec();
        let framed = frame(&payload);
        // Compression byte, 4-byte length, then the payload itself.
        assert_eq!(framed[0], 0);
        assert_eq!(&framed[1..5], &(payload.len() as u32).to_be_bytes());
        assert_eq!(unframe(&framed).unwrap(), payload);
    }

    #[test]
    fn a_truncated_reply_is_an_error() {
        assert!(unframe(&[0, 0, 0, 0]).is_err());
        // Claims 100 bytes, carries 2.
        assert!(unframe(&[0, 0, 0, 0, 100, 1, 2]).is_err());
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
