//! MITM proxy engine built on `hudsucker`.
//!
//! Starts a local HTTP/HTTPS intercepting proxy. Every request/response pair
//! that flows through it is captured into a `Flow`, stored in shared state, and
//! emitted to the frontend as a `proxy://flow` event for a live traffic view.
//!
//! TLS interception works by generating a local Certificate Authority the first
//! time the proxy runs. The user installs/trusts that CA so the proxy can sign
//! per-host leaf certificates on the fly.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{header, Request, Response},
    rustls::crypto::aws_lc_rs,
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::http_client::Header;

/// Maximum number of body characters we retain for display. The full body is
/// still forwarded to the destination; this only caps what we keep in memory
/// for the UI.
const MAX_CAPTURED_BODY: usize = 200_000;

/// A captured request/response exchange.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: u64,
    pub method: String,
    pub url: String,
    pub host: String,
    /// The application that made the request, or the device address for
    /// clients elsewhere on the network.
    pub app: String,
    pub request_headers: Vec<Header>,
    pub request_body: String,
    pub status: Option<u16>,
    pub status_text: String,
    pub response_headers: Vec<Header>,
    pub response_body: String,
    /// Original bytes when the body is not valid UTF-8 — an image, a protobuf
    /// payload. Without this the capture is lossy and cannot be rendered.
    pub response_body_base64: Option<String>,
    /// Epoch milliseconds when the request was seen.
    pub started_ms: u64,
    /// Round-trip duration in milliseconds (filled in on response).
    pub duration_ms: u64,
}

/// Data shared between the Tauri commands and the running proxy task.
pub struct ProxyShared {
    flows: Mutex<Vec<Flow>>,
    counter: AtomicU64,
    /// Hold matching requests until the user decides what to do with them.
    intercept: Mutex<Intercept>,
    /// Held requests, keyed by id, waiting on a decision from the UI.
    waiting: Mutex<std::collections::HashMap<u64, oneshot::Sender<Decision>>>,
}

#[derive(Default)]
struct Intercept {
    enabled: bool,
    /// Substring the URL must contain; empty holds everything.
    filter: String,
    /// Hold responses on the way back as well as requests on the way out.
    responses: bool,
}

/// What the user chose for a held request.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// "forward" sends it (with any edits), "abort" answers 502 instead.
    pub action: String,
    /// Replacement status, for a held response.
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub body: String,
}

/// A request paused at a breakpoint, sent to the UI to edit.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeldRequest {
    pub id: u64,
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: String,
    /// "request" on the way out, "response" on the way back. A response has a
    /// status instead of a method, and dropping it is not an option — the
    /// request has already been made.
    pub kind: String,
    pub status: Option<u16>,
}

impl ProxyShared {
    fn next_id(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }
}

struct RunningProxy {
    shutdown: oneshot::Sender<()>,
    port: u16,
    /// Bound to every interface rather than loopback only.
    lan: bool,
}

/// Top-level proxy state managed by Tauri.
pub struct ProxyState {
    running: Mutex<Option<RunningProxy>>,
    shared: Arc<ProxyShared>,
    /// Cached (cert_pem, key_pem) once the CA has been loaded/created.
    ca: Mutex<Option<(String, String)>>,
}

impl Default for ProxyState {
    fn default() -> Self {
        Self {
            running: Mutex::new(None),
            shared: Arc::new(ProxyShared {
                flows: Mutex::new(Vec::new()),
                counter: AtomicU64::new(1),
                intercept: Mutex::new(Intercept::default()),
                waiting: Mutex::new(std::collections::HashMap::new()),
            }),
            ca: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub flow_count: usize,
    /// Addresses clients can point at; loopback only unless LAN mode is on.
    pub addresses: Vec<String>,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn headers_to_vec(map: &header::HeaderMap) -> Vec<Header> {
    map.iter()
        .map(|(k, v)| Header {
            name: k.to_string(),
            value: v.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect()
}

fn truncate_body(bytes: &Bytes) -> String {
    let s = String::from_utf8_lossy(bytes);
    if s.len() > MAX_CAPTURED_BODY {
        format!("{}\n… [truncated {} bytes]", &s[..MAX_CAPTURED_BODY], s.len() - MAX_CAPTURED_BODY)
    } else {
        s.into_owned()
    }
}

/// Applies the user's edits to a held request. Anything left blank is kept,
/// so an untouched field cannot be lost by resuming.
fn apply_edits(
    parts: &mut hudsucker::hyper::http::request::Parts,
    url: &mut String,
    bytes: &mut Bytes,
    decision: Decision,
) {
    if !decision.method.trim().is_empty() {
        if let Ok(method) = decision.method.trim().parse() {
            parts.method = method;
        }
    }
    if !decision.url.trim().is_empty() && decision.url != *url {
        if let Ok(uri) = decision.url.trim().parse::<hudsucker::hyper::Uri>() {
            // The Host header has to follow the URI, or the request is sent to
            // one server addressed to another.
            if let Some(authority) = uri.authority().map(|a| a.to_string()) {
                if let Ok(value) = authority.parse() {
                    parts.headers.insert(header::HOST, value);
                }
            }
            parts.uri = uri;
            *url = decision.url.trim().to_string();
        }
    }
    if !decision.headers.is_empty() {
        let mut map = header::HeaderMap::new();
        for entry in &decision.headers {
            if entry.name.trim().is_empty() {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                entry.name.parse::<header::HeaderName>(),
                entry.value.parse::<header::HeaderValue>(),
            ) {
                map.append(name, value);
            }
        }
        parts.headers = map;
    }
    if decision.body != truncate_body(bytes) {
        *bytes = Bytes::from(decision.body);
        // Content-Length must match what is actually sent.
        if let Ok(value) = bytes.len().to_string().parse() {
            parts.headers.insert(header::CONTENT_LENGTH, value);
        }
    }
}

/// Applies edits to a held response: status, headers, body. Blank fields are
/// kept, so resuming an untouched response changes nothing.
fn apply_response_edits(
    parts: &mut hudsucker::hyper::http::response::Parts,
    bytes: &mut Bytes,
    decision: Decision,
) {
    if let Some(status) = decision.status {
        if let Ok(value) = hudsucker::hyper::StatusCode::from_u16(status) {
            parts.status = value;
        }
    }
    if !decision.headers.is_empty() {
        let mut map = header::HeaderMap::new();
        for entry in &decision.headers {
            if entry.name.trim().is_empty() {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                entry.name.parse::<header::HeaderName>(),
                entry.value.parse::<header::HeaderValue>(),
            ) {
                map.append(name, value);
            }
        }
        parts.headers = map;
    }
    if decision.body != truncate_body(bytes) {
        *bytes = Bytes::from(decision.body);
        if let Ok(value) = bytes.len().to_string().parse() {
            parts.headers.insert(header::CONTENT_LENGTH, value);
        }
        // A rewritten body is no longer whatever the server compressed.
        parts.headers.remove(header::CONTENT_ENCODING);
    }
}

/// The hudsucker handler. Cloned once per connection; because HTTP/1.1 requests
/// are serialized on a connection we can stash the in-flight request in `self`
/// and pair it with the matching response.
#[derive(Clone)]
struct CaptureHandler {
    app: AppHandle,
    shared: Arc<ProxyShared>,
    pending: Option<Flow>,
    started_at: Option<u64>,
}

impl HttpHandler for CaptureHandler {
    async fn handle_request(
        &mut self,
        ctx: &HttpContext,
        req: Request<Body>,
    ) -> RequestOrResponse {
        let (parts, body) = req.into_parts();

        let uri = parts.uri.clone();
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| uri.host().map(|h| h.to_string()))
            .unwrap_or_default();

        // Reconstruct a full URL. Plain HTTP proxied requests arrive in
        // absolute form; MITM'd HTTPS requests arrive in origin form (path
        // only) so we synthesize an https:// URL from the Host header.
        let url = if uri.scheme().is_some() {
            uri.to_string()
        } else {
            let pq = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
            format!("https://{host}{pq}")
        };

        let mut bytes = collect_body(body).await;
        let mut parts = parts;
        let mut url = url;

        // Breakpoint: hold the request and let the user edit or drop it. The
        // await blocks only this connection's task, so other traffic is
        // unaffected.
        let held = {
            let guard = self.shared.intercept.lock().unwrap();
            guard.enabled && (guard.filter.is_empty() || url.contains(&guard.filter))
        };
        if held {
            let id = self.shared.next_id();
            let (tx, rx) = oneshot::channel::<Decision>();
            self.shared.waiting.lock().unwrap().insert(id, tx);
            let _ = self.app.emit(
                "proxy://hold",
                HeldRequest {
                    id,
                    method: parts.method.to_string(),
                    url: url.clone(),
                    headers: headers_to_vec(&parts.headers),
                    body: truncate_body(&bytes),
                    kind: "request".into(),
                    status: None,
                },
            );

            // A window closed mid-breakpoint must not wedge the connection
            // forever, so the hold expires.
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(decision)) if decision.action == "abort" => {
                    self.shared.waiting.lock().unwrap().remove(&id);
                    return Response::builder()
                        .status(502)
                        .header("content-type", "application/json")
                        .body(Body::from(Full::new(Bytes::from(
                            r#"{"error":"dropped at a proxy breakpoint"}"#,
                        ))))
                        .unwrap()
                        .into();
                }
                Ok(Ok(decision)) => {
                    self.shared.waiting.lock().unwrap().remove(&id);
                    apply_edits(&mut parts, &mut url, &mut bytes, decision);
                }
                // Cancelled or timed out: forward untouched rather than drop.
                _ => {
                    self.shared.waiting.lock().unwrap().remove(&id);
                }
            }
        }

        let flow = Flow {
            id: self.shared.next_id(),
            method: parts.method.to_string(),
            url,
            host,
            app: crate::client_app::describe(ctx.client_addr),
            request_headers: headers_to_vec(&parts.headers),
            request_body: truncate_body(&bytes),
            status: None,
            status_text: String::new(),
            response_headers: Vec::new(),
            response_body: String::new(),
            response_body_base64: None,
            started_ms: epoch_ms(),
            duration_ms: 0,
        };

        self.started_at = Some(flow.started_ms);
        self.pending = Some(flow);

        let new_req = Request::from_parts(parts, Body::from(Full::new(bytes)));
        new_req.into()
    }

    async fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> Response<Body> {
        let (mut parts, body) = res.into_parts();
        let mut bytes = collect_body(body).await;

        // The same breakpoint, on the way back. A response cannot be dropped:
        // the request has already been made, and the client is owed an answer.
        let held = {
            let guard = self.shared.intercept.lock().unwrap();
            guard.enabled
                && guard.responses
                && self
                    .pending
                    .as_ref()
                    .map(|flow| guard.filter.is_empty() || flow.url.contains(&guard.filter))
                    .unwrap_or(false)
        };
        if held {
            let id = self.shared.next_id();
            let (tx, rx) = oneshot::channel::<Decision>();
            self.shared.waiting.lock().unwrap().insert(id, tx);
            let _ = self.app.emit(
                "proxy://hold",
                HeldRequest {
                    id,
                    method: String::new(),
                    url: self
                        .pending
                        .as_ref()
                        .map(|flow| flow.url.clone())
                        .unwrap_or_default(),
                    headers: headers_to_vec(&parts.headers),
                    body: truncate_body(&bytes),
                    kind: "response".into(),
                    status: Some(parts.status.as_u16()),
                },
            );
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(decision)) => {
                    self.shared.waiting.lock().unwrap().remove(&id);
                    apply_response_edits(&mut parts, &mut bytes, decision);
                }
                _ => {
                    self.shared.waiting.lock().unwrap().remove(&id);
                }
            }
        }

        if let Some(mut flow) = self.pending.take() {
            flow.status = Some(parts.status.as_u16());
            flow.status_text = parts
                .status
                .canonical_reason()
                .unwrap_or("")
                .to_string();
            flow.response_headers = headers_to_vec(&parts.headers);
            flow.response_body = truncate_body(&bytes);
            flow.response_body_base64 = if std::str::from_utf8(&bytes).is_ok() {
                None
            } else {
                Some(crate::github::base64_encode(&bytes))
            };
            flow.duration_ms = epoch_ms().saturating_sub(self.started_at.unwrap_or(flow.started_ms));

            if let Ok(mut flows) = self.shared.flows.lock() {
                flows.push(flow.clone());
            }
            let _ = self.app.emit("proxy://flow", &flow);
        }

        Response::from_parts(parts, Body::from(Full::new(bytes)))
    }
}

async fn collect_body(body: Body) -> Bytes {
    match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => Bytes::new(),
    }
}

/// Directory where the CA cert/key are persisted.
fn ca_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// Load the CA from disk, or generate and persist a new one.
fn ensure_ca(app: &AppHandle, state: &ProxyState) -> Result<(String, String), String> {
    if let Some(pair) = state.ca.lock().unwrap().clone() {
        return Ok(pair);
    }

    let dir = ca_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let cert_path = dir.join("wrk-ca.pem");
    let key_path = dir.join("wrk-ca.key");

    let pair = if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path).map_err(|e| e.to_string())?;
        let key_pem = std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?;
        (cert_pem, key_pem)
    } else {
        let (cert_pem, key_pem) = generate_ca()?;
        std::fs::write(&cert_path, &cert_pem).map_err(|e| e.to_string())?;
        std::fs::write(&key_path, &key_pem).map_err(|e| e.to_string())?;
        (cert_pem, key_pem)
    };

    *state.ca.lock().unwrap() = Some(pair.clone());
    Ok(pair)
}

/// Generate a fresh self-signed CA certificate and private key (PEM encoded).
fn generate_ca() -> Result<(String, String), String> {
    let mut params =
        CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    params
        .distinguished_name
        .push(DnType::CommonName, "APIKit CA");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "APIKit");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];

    let key_pair = KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;
    Ok((cert.pem(), key_pair.serialize_pem()))
}

fn build_authority(cert_pem: &str, key_pem: &str) -> Result<RcgenAuthority, String> {
    let key_pair = KeyPair::from_pem(key_pem).map_err(|e| e.to_string())?;
    let ca_cert = CertificateParams::from_ca_cert_pem(cert_pem)
        .map_err(|e| e.to_string())?
        .self_signed(&key_pair)
        .map_err(|e| e.to_string())?;
    Ok(RcgenAuthority::new(
        key_pair,
        ca_cert,
        1_000,
        aws_lc_rs::default_provider(),
    ))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_proxy(
    app: AppHandle,
    state: State<'_, ProxyState>,
    port: u16,
    all_interfaces: bool,
) -> Result<u16, String> {
    if state.running.lock().unwrap().is_some() {
        return Err("proxy is already running".into());
    }

    let (cert_pem, key_pem) = ensure_ca(&app, &state)?;
    let ca = build_authority(&cert_pem, &key_pem)?;

    let (tx, rx) = oneshot::channel::<()>();

    let handler = CaptureHandler {
        app: app.clone(),
        shared: state.shared.clone(),
        pending: None,
        started_at: None,
    };

    // LAN mode lets phones and other machines on the network use the proxy;
    // anyone on the network can then send traffic through this machine, so
    // it is opt-in per start.
    let addr = if all_interfaces {
        SocketAddr::from(([0, 0, 0, 0], port))
    } else {
        SocketAddr::from(([127, 0, 0, 1], port))
    };
    let proxy = Proxy::builder()
        .with_addr(addr)
        .with_ca(ca)
        .with_rustls_client(aws_lc_rs::default_provider())
        .with_http_handler(handler)
        .with_graceful_shutdown(async move {
            let _ = rx.await;
        })
        .build()
        .map_err(|e| format!("failed to build proxy: {e}"))?;

    tokio::spawn(async move {
        if let Err(e) = proxy.start().await {
            eprintln!("proxy stopped with error: {e}");
        }
    });

    *state.running.lock().unwrap() = Some(RunningProxy {
        shutdown: tx,
        port,
        lan: all_interfaces,
    });
    Ok(port)
}

#[tauri::command]
pub fn stop_proxy(state: State<'_, ProxyState>) -> Result<(), String> {
    let mut guard = state.running.lock().unwrap();
    match guard.take() {
        Some(running) => {
            let _ = running.shutdown.send(());
            Ok(())
        }
        None => Err("proxy is not running".into()),
    }
}

#[tauri::command]
pub fn proxy_status(state: State<'_, ProxyState>) -> ProxyStatus {
    let running = state.running.lock().unwrap();
    let flow_count = state.shared.flows.lock().unwrap().len();
    match &*running {
        Some(r) => ProxyStatus {
            running: true,
            port: Some(r.port),
            flow_count,
            addresses: if r.lan {
                crate::sync::local_addresses()
            } else {
                vec!["127.0.0.1".to_string()]
            },
        },
        None => ProxyStatus {
            running: false,
            port: None,
            flow_count,
            addresses: Vec::new(),
        },
    }
}

#[tauri::command]
pub fn get_flows(state: State<'_, ProxyState>) -> Vec<Flow> {
    state.shared.flows.lock().unwrap().clone()
}

/// Turns breakpoints on or off. Disabling releases anything already held, so
/// the toggle can never strand a paused request.
#[tauri::command]
pub fn set_intercept(
    state: State<'_, ProxyState>,
    enabled: bool,
    filter: String,
    responses: bool,
) {
    {
        let mut guard = state.shared.intercept.lock().unwrap();
        guard.enabled = enabled;
        guard.filter = filter.trim().to_string();
        guard.responses = responses;
    }
    if !enabled {
        let waiting: Vec<_> = state
            .shared
            .waiting
            .lock()
            .unwrap()
            .drain()
            .map(|(_, sender)| sender)
            .collect();
        for sender in waiting {
            let _ = sender.send(Decision {
                action: "forward".into(),
                status: None,
                method: String::new(),
                url: String::new(),
                headers: Vec::new(),
                body: String::new(),
            });
        }
    }
}

/// Releases one held request, with the user's edits.
#[tauri::command]
pub fn resume_request(
    state: State<'_, ProxyState>,
    id: u64,
    decision: Decision,
) -> Result<(), String> {
    let sender = state
        .shared
        .waiting
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| "that request is no longer waiting".to_string())?;
    sender
        .send(decision)
        .map_err(|_| "the connection went away".to_string())
}

#[tauri::command]
pub fn clear_flows(state: State<'_, ProxyState>) {
    state.shared.flows.lock().unwrap().clear();
}

#[tauri::command]
pub fn get_ca_certificate_pem(
    app: AppHandle,
    state: State<'_, ProxyState>,
) -> Result<String, String> {
    let (cert_pem, _key) = ensure_ca(&app, &state)?;
    Ok(cert_pem)
}

/// Returns the on-disk path of the CA certificate so the user can install it.
#[tauri::command]
pub fn ca_certificate_path(
    app: AppHandle,
    state: State<'_, ProxyState>,
) -> Result<String, String> {
    ensure_ca(&app, &state)?;
    let path = ca_dir(&app)?.join("wrk-ca.pem");
    Ok(path.to_string_lossy().into_owned())
}
