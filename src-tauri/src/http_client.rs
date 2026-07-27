//! HTTP client used by the "API Client" side of the app.
//!
//! Exposes a single `send_request` Tauri command that performs an outbound
//! HTTP request and returns a structured response (status, headers, body,
//! timing and size) back to the frontend.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cookies::CookieState;
use crate::store::Db;

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
    /// "auto" (ALPN negotiation), "http1" or "http2".
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
}

/// Response returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseData {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<Header>,
    pub body: String,
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
) -> Result<HttpResponseData, String> {
    let method = reqwest::Method::from_bytes(spec.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("APIKit/", env!("CARGO_PKG_VERSION")))
        // The jar is shared, so a login in one tab authenticates the next
        // request — and reqwest applies it across redirects for us.
        .cookie_provider(cookies.0.clone());

    if let Some(ms) = spec.timeout_ms {
        builder = builder.timeout(std::time::Duration::from_millis(ms));
    }

    // "auto" lets ALPN pick; the explicit modes pin the protocol so a server's
    // HTTP/2 support (or lack of it) can be tested directly.
    builder = match spec.http_version.as_deref() {
        Some("http1") => builder.http1_only(),
        Some("http2") => builder.http2_prior_knowledge(),
        _ => builder,
    };

    if spec.verify_tls == Some(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if spec.follow_redirects == Some(false) {
        builder = builder.redirect(reqwest::redirect::Policy::none());
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

    crate::cookies::persist_after_request(&cookies, &db);

    // Best-effort UTF-8 decode; binary responses are shown lossily.
    let body = String::from_utf8_lossy(&bytes).into_owned();

    Ok(HttpResponseData {
        status: status.as_u16(),
        status_text: status
            .canonical_reason()
            .unwrap_or("")
            .to_string(),
        headers,
        body,
        time_ms,
        size_bytes,
        final_url,
        http_version,
    })
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
