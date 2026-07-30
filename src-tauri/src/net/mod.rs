//! Making requests: the HTTP client and everything layered on it.
//!
//! `http_client` is the one round trip the client pane makes; `load` drives many
//! of them at once; `stream` holds the long-lived protocols (WebSocket, SSE,
//! Socket.IO, MQTT); `grpc` speaks HTTP/2 over tonic. `tls` and `cookies` are
//! shared by all of them.

pub mod cookies;
pub mod grpc;
pub mod http_client;
pub mod load;
pub mod stream;
pub mod tls;
