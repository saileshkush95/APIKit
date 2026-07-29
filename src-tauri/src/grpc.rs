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

/// Lists the services a server exposes, so the UI can offer them.
#[tauri::command]
pub async fn grpc_services(spec: GrpcSpec) -> Result<Vec<String>, String> {
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

    let pool = reflect(&client, &endpoint, &service, &spec.metadata, timeout).await?;
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
