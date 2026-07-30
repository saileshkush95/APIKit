//! HTTP client used by the "API Client" side of the app.
//!
//! Exposes a single `send_request` Tauri command that performs an outbound
//! HTTP request and returns a structured response (status, headers, body,
//! timing and size) back to the frontend.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use futures::future::{AbortHandle, Abortable};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cookies::CookieState;
use crate::store::Db;

/// Abort handles for in-flight requests, keyed by the caller's cancel id.
#[derive(Default)]
pub struct CancelState(pub Mutex<HashMap<String, AbortHandle>>);

/// Aborts an in-flight `send_request` carrying this cancel id. A miss is fine:
/// the request may have just finished.
#[tauri::command]
pub fn cancel_request(id: String, cancels: State<'_, CancelState>) {
    if let Some(handle) = cancels.0.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

/// A single header entry. Kept as a list (rather than a map) so the UI can
/// preserve ordering and allow duplicate header names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// One part of a multipart body. `file_path` turns it into a file upload;
/// without it the part carries `value` as text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

/// Request payload sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    /// Raw request body. Ignored for methods that don't carry one.
    #[serde(default)]
    pub body: Option<String>,
    /// Optional request timeout in milliseconds.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// "auto" (ALPN negotiation), "http1", "http2" or "http3".
    #[serde(default)]
    pub http_version: Option<String>,
    /// When false, invalid or self-signed certificates are accepted.
    #[serde(default)]
    pub verify_tls: Option<bool>,
    #[serde(default)]
    pub follow_redirects: Option<bool>,
    /// When present the body is built as `multipart/form-data`, and `body` is
    /// ignored. Reading files here (rather than in the webview) keeps binary
    /// content intact.
    #[serde(default)]
    pub multipart: Option<Vec<MultipartPart>>,
    /// A file sent as the entire request body, byte for byte. Read here for the
    /// same reason as multipart parts: the webview would have to base64 it.
    #[serde(default)]
    pub body_file_path: Option<String>,
    /// When set, `cancel_request` with the same id aborts this request.
    #[serde(default)]
    pub cancel_id: Option<String>,
    /// Cap on redirects to follow; only used when redirects are followed.
    #[serde(default)]
    pub max_redirects: Option<u32>,
    /// Do not send a Referer header when following redirects.
    #[serde(default)]
    pub no_referer: Option<bool>,
    /// Skip the shared cookie jar for this request, both directions.
    #[serde(default)]
    pub no_cookie_jar: Option<bool>,
    /// Client certificate for mutual TLS, already matched to this request's host
    /// by the caller — the host patterns live in settings, not here.
    #[serde(default)]
    pub client_cert: Option<crate::tls::ClientCertSpec>,
    /// Extra certificate authorities to trust, on top of the system roots.
    #[serde(default)]
    pub ca_cert_paths: Option<Vec<String>>,
}

/// Response returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseData {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<Header>,
    pub body: String,
    /// The original bytes when they are not valid UTF-8 (a PDF, an image…):
    /// `body` is then a lossy rendering for display and this is what "Save
    /// response" writes to disk.
    pub body_base64: Option<String>,
    /// Total round-trip time in milliseconds.
    pub time_ms: u128,
    /// Size of the response body in bytes.
    pub size_bytes: u64,
    /// Final URL after any redirects.
    pub final_url: String,
    /// Protocol actually negotiated, e.g. "HTTP/2.0".
    pub http_version: String,
}

/// Perform an HTTP request described by `spec`.
#[tauri::command]
pub async fn send_request(
    spec: HttpRequestSpec,
    cookies: State<'_, CookieState>,
    db: State<'_, Db>,
    cancels: State<'_, CancelState>,
) -> Result<HttpResponseData, String> {
    let method = reqwest::Method::from_bytes(spec.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

    let skip_cookie_jar = spec.no_cookie_jar == Some(true);

    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("APIKit/", env!("CARGO_PKG_VERSION")));

    // The jar is shared, so a login in one tab authenticates the next
    // request — and reqwest applies it across redirects for us. Left out
    // entirely when this request opts out of the jar.
    if !skip_cookie_jar {
        builder = builder.cookie_provider(cookies.0.clone());
    }

    if spec.no_referer == Some(true) {
        builder = builder.referer(false);
    }

    if let Some(ms) = spec.timeout_ms {
        builder = builder.timeout(std::time::Duration::from_millis(ms));
    }

    // "auto" lets ALPN pick; the explicit modes pin the protocol so a server's
    // HTTP/2 support (or lack of it) can be tested directly.
    builder = match spec.http_version.as_deref() {
        Some("http1") => builder.http1_only(),
        Some("http2") => builder.http2_prior_knowledge(),
        // QUIC has no plaintext form and no upgrade path, so this only works
        // against a server that already speaks HTTP/3 over TLS.
        Some("http3") => builder.http3_prior_knowledge(),
        _ => builder,
    };

    if spec.verify_tls == Some(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }

    // Before `build()`, and fatal if it fails: a request that quietly went out
    // without its client certificate comes back as an opaque handshake failure
    // from the server, with nothing pointing at the real cause.
    builder = crate::tls::apply(
        builder,
        spec.client_cert.as_ref(),
        spec.ca_cert_paths.as_deref().unwrap_or(&[]),
    )?;
    if spec.follow_redirects == Some(false) {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    } else if let Some(max) = spec.max_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::limited(max as usize));
    }

    let client = builder
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut req = client.request(method.clone(), &spec.url);

    for h in &spec.headers {
        if h.name.trim().is_empty() {
            continue;
        }
        req = req.header(&h.name, &h.value);
    }

    if let Some(parts) = &spec.multipart {
        req = req.multipart(build_multipart(parts).await?);
    } else if let Some(path) = spec.body_file_path.as_deref().filter(|p| !p.is_empty()) {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| format!("could not read {path}: {e}"))?;
        // Only guess a type when the caller did not set one; an explicit
        // Content-Type header is a deliberate choice and must win.
        if !spec
            .headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("content-type"))
        {
            req = req.header("Content-Type", guess_content_type(path));
        }
        req = req.body(bytes);
    } else if let Some(body) = spec.body {
        // Only attach a body for methods that conventionally carry one.
        if !body.is_empty() && method_allows_body(&method) {
            req = req.body(body);
        }
    }

    let started = Instant::now();
    let work = async move {
        let resp = req
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        let final_url = resp.url().to_string();
        let http_version = format!("{:?}", resp.version());

        let headers: Vec<Header> = resp
            .headers()
            .iter()
            .map(|(k, v)| Header {
                name: k.to_string(),
                value: v.to_str().unwrap_or("<binary>").to_string(),
            })
            .collect();

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("failed to read response body: {e}"))?;
        let time_ms = started.elapsed().as_millis();
        let size_bytes = bytes.len() as u64;

        // Text stays a plain string; binary keeps its exact bytes as base64
        // alongside a lossy rendering for display.
        let (body, body_base64) = match std::str::from_utf8(&bytes) {
            Ok(text) => (text.to_owned(), None),
            Err(_) => (
                String::from_utf8_lossy(&bytes).into_owned(),
                Some(crate::github::base64_encode(&bytes)),
            ),
        };

        Ok(HttpResponseData {
            status: status.as_u16(),
            status_text: status
                .canonical_reason()
                .unwrap_or("")
                .to_string(),
            headers,
            body,
            body_base64,
            time_ms,
            size_bytes,
            final_url,
            http_version,
        })
    };

    // Dropping the future is what cancels it: reqwest tears the connection
    // down when the in-flight send/read is dropped mid-way.
    let result = match spec.cancel_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => {
            let (handle, registration) = AbortHandle::new_pair();
            cancels
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .insert(id.to_string(), handle);
            let outcome = Abortable::new(work, registration).await;
            cancels
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .remove(id);
            match outcome {
                Ok(result) => result,
                Err(_) => Err("Request canceled".to_string()),
            }
        }
        None => work.await,
    };

    if result.is_ok() && !skip_cookie_jar {
        crate::cookies::persist_after_request(&cookies, &db);
    }
    result
}

/// A content type for a file body, from its extension.
///
/// Deliberately a short list rather than a mime database: these are the types
/// people actually upload as a raw body, and anything unrecognised is safest as
/// `application/octet-stream` — a wrong guess is worse than no guess.
fn guess_content_type(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Builds a multipart form, reading any referenced files from disk.
async fn build_multipart(
    parts: &[MultipartPart],
) -> Result<reqwest::multipart::Form, String> {
    let mut form = reqwest::multipart::Form::new();

    for part in parts {
        if part.name.trim().is_empty() {
            continue;
        }
        match &part.file_path {
            Some(path) if !path.trim().is_empty() => {
                let bytes = tokio::fs::read(path)
                    .await
                    .map_err(|e| format!("cannot read {path}: {e}"))?;
                let file_name = part.file_name.clone().unwrap_or_else(|| {
                    std::path::Path::new(path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file".to_string())
                });
                let mut field = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
                if let Some(mime) = &part.content_type {
                    field = field
                        .mime_str(mime)
                        .map_err(|e| format!("invalid content type {mime}: {e}"))?;
                }
                form = form.part(part.name.clone(), field);
            }
            _ => {
                let mut field = reqwest::multipart::Part::text(part.value.clone());
                if let Some(mime) = &part.content_type {
                    field = field
                        .mime_str(mime)
                        .map_err(|e| format!("invalid content type {mime}: {e}"))?;
                }
                form = form.part(part.name.clone(), field);
            }
        }
    }

    Ok(form)
}

fn method_allows_body(method: &reqwest::Method) -> bool {
    !matches!(
        *method,
        reqwest::Method::GET | reqwest::Method::HEAD | reqwest::Method::TRACE
    )
}
