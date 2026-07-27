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
use serde::Serialize;
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
    pub request_headers: Vec<Header>,
    pub request_body: String,
    pub status: Option<u16>,
    pub status_text: String,
    pub response_headers: Vec<Header>,
    pub response_body: String,
    /// Epoch milliseconds when the request was seen.
    pub started_ms: u64,
    /// Round-trip duration in milliseconds (filled in on response).
    pub duration_ms: u64,
}

/// Data shared between the Tauri commands and the running proxy task.
pub struct ProxyShared {
    flows: Mutex<Vec<Flow>>,
    counter: AtomicU64,
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
        _ctx: &HttpContext,
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

        let bytes = collect_body(body).await;

        let flow = Flow {
            id: self.shared.next_id(),
            method: parts.method.to_string(),
            url,
            host,
            request_headers: headers_to_vec(&parts.headers),
            request_body: truncate_body(&bytes),
            status: None,
            status_text: String::new(),
            response_headers: Vec::new(),
            response_body: String::new(),
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
        let (parts, body) = res.into_parts();
        let bytes = collect_body(body).await;

        if let Some(mut flow) = self.pending.take() {
            flow.status = Some(parts.status.as_u16());
            flow.status_text = parts
                .status
                .canonical_reason()
                .unwrap_or("")
                .to_string();
            flow.response_headers = headers_to_vec(&parts.headers);
            flow.response_body = truncate_body(&bytes);
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
