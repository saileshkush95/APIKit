//! OAuth 2.0 token acquisition.
//!
//! Five grants are supported: authorization code (with PKCE), client
//! credentials, resource owner password, refresh token, and device code.
//! Implicit is deliberately absent — the access token comes back in the URL
//! *fragment*, which a browser never sends to the redirect host, so a loopback
//! listener cannot see it. OAuth 2.1 removes the grant for the same reason it
//! is awkward here, and every provider that offers it also offers authorization
//! code with PKCE.
//!
//! The authorization code flow runs a one-shot HTTP listener on loopback and
//! opens the system browser at the authorization endpoint. Using the real
//! browser rather than an embedded webview is the point: the user's existing
//! session, password manager and hardware keys all work, and the app never sees
//! their credentials.
//!
//! Nothing here writes to disk. Tokens are returned to the caller, which puts
//! them in the OS keychain via `secrets.rs` — see the note there on why a
//! credential must not live beside the collection.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// How long to wait for the user to finish in the browser.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);

/// Whether the client authenticates in the Authorization header or the body.
/// RFC 6749 §2.3.1 requires servers to support the header form and says the
/// body form "MUST NOT be used" unless the header is unavailable — but real
/// providers differ on which they accept, so it is the user's choice.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ClientAuth {
    Basic,
    Body,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthConfig {
    pub token_url: String,
    #[serde(default)]
    pub authorize_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub scope: String,
    /// Must match a redirect URI registered with the provider, and must be a
    /// loopback address — it is this process that answers it.
    #[serde(default)]
    pub redirect_uri: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub client_auth: Option<ClientAuth>,
    #[serde(default)]
    pub use_pkce: bool,
    /// Extra name/value pairs, for the parameters providers invent: `audience`,
    /// `resource`, `prompt`, `tenant`.
    #[serde(default)]
    pub extra_params: Vec<Pair>,
    #[serde(default)]
    pub verify_tls: Option<bool>,
    #[serde(default)]
    pub device_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    pub token_type: String,
    pub refresh_token: String,
    pub id_token: String,
    pub scope: String,
    /// Unix milliseconds, computed from `expires_in` at the moment of the
    /// response. Absent when the provider did not say, which means the token
    /// has no known lifetime rather than an infinite one.
    pub expires_at_ms: Option<u64>,
    /// The whole response, so a provider-specific field is still reachable.
    pub raw: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuth {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Some providers send a URI with the code already embedded.
    pub verification_uri_complete: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

// --- helpers -----------------------------------------------------------------

const URL_SAFE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding, as every OAuth/JOSE spec requires.
fn base64url(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(URL_SAFE[(n >> 18 & 63) as usize] as char);
        out.push(URL_SAFE[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(URL_SAFE[(n >> 6 & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(URL_SAFE[(n & 63) as usize] as char);
        }
    }
    out
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// 43 characters of unreserved alphabet — the shortest verifier RFC 7636 allows,
/// and 256 bits of entropy.
fn code_verifier() -> String {
    base64url(&random_bytes(32))
}

fn code_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn client(verify_tls: Option<bool>) -> Result<reqwest::Client, String> {
    // The system proxy is honoured: an identity provider reached through a
    // corporate proxy is the common case, and APIKit's own proxy trusts its CA
    // when it installs itself, so routing through that works too.
    let mut builder =
        reqwest::Client::builder().user_agent(concat!("APIKit/", env!("CARGO_PKG_VERSION")));
    if verify_tls == Some(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder
        .build()
        .map_err(|e| format!("cannot create HTTP client: {e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Providers are inconsistent about whether numbers are numbers or strings.
fn number_field(value: &serde_json::Value, key: &str) -> Option<u64> {
    let field = value.get(key)?;
    field
        .as_u64()
        .or_else(|| field.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Posts a token request and parses the result.
///
/// An OAuth error is a 400 with a JSON body naming the fault, which is far more
/// useful than the status line, so it is unpacked into the message.
async fn post_token(
    config: &OauthConfig,
    url: &str,
    mut form: Vec<(String, String)>,
) -> Result<serde_json::Value, String> {
    if url.trim().is_empty() {
        return Err("no token URL set".into());
    }

    let auth = config.client_auth.unwrap_or(ClientAuth::Basic);
    let mut request = client(config.verify_tls)?.post(url);

    // With no secret there is nothing to authenticate with, so the client id
    // goes in the body regardless — that is how a public client identifies
    // itself, and sending an empty Basic password fails on most providers.
    if auth == ClientAuth::Basic && !config.client_secret.is_empty() {
        let encoded = base64_standard(
            format!("{}:{}", config.client_id, config.client_secret).as_bytes(),
        );
        request = request.header("Authorization", format!("Basic {encoded}"));
    } else {
        if !config.client_id.is_empty() {
            form.push(("client_id".into(), config.client_id.clone()));
        }
        if !config.client_secret.is_empty() {
            form.push(("client_secret".into(), config.client_secret.clone()));
        }
    }

    for pair in &config.extra_params {
        if !pair.name.trim().is_empty() {
            form.push((pair.name.clone(), pair.value.clone()));
        }
    }

    let response = request
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {}", why(&e)))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("cannot read token response: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
        let detail = json
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Err(if detail.is_empty() {
            format!("{error} (HTTP {})", status.as_u16())
        } else {
            format!("{error}: {detail}")
        });
    }

    if !status.is_success() {
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("token endpoint returned HTTP {}: {snippet}", status.as_u16()));
    }

    if json.is_null() {
        return Err(format!(
            "token endpoint did not return JSON: {}",
            body.chars().take(300).collect::<String>()
        ));
    }

    Ok(json)
}

/// Standard base64 with padding, for HTTP Basic.
fn base64_standard(input: &[u8]) -> String {
    crate::github::base64_encode(input)
}

/// The chain of a reqwest failure. The outer message is usually just
/// "error sending request"; the cause says what actually went wrong.
fn why(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.dedup();
    parts.join(": ")
}

fn to_token_set(json: serde_json::Value) -> TokenSet {
    let expires_at_ms = number_field(&json, "expires_in").map(|secs| now_ms() + secs * 1000);
    TokenSet {
        access_token: string_field(&json, "access_token"),
        token_type: {
            let kind = string_field(&json, "token_type");
            // Providers send "bearer", "Bearer" and sometimes nothing at all.
            if kind.is_empty() {
                "Bearer".to_string()
            } else {
                kind
            }
        },
        refresh_token: string_field(&json, "refresh_token"),
        id_token: string_field(&json, "id_token"),
        scope: string_field(&json, "scope"),
        expires_at_ms,
        raw: serde_json::to_string_pretty(&json).unwrap_or_default(),
    }
}

// --- loopback listener -------------------------------------------------------

/// The port and path of the redirect URI. The listener has to bind the exact
/// port the provider will redirect to, so it cannot be chosen here.
fn redirect_parts(redirect_uri: &str) -> Result<(u16, String), String> {
    let parsed = url::Url::parse(redirect_uri)
        .map_err(|e| format!("redirect URI `{redirect_uri}` is not a URL: {e}"))?;

    let host = parsed.host_str().unwrap_or_default();
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
        return Err(format!(
            "redirect URI must be a loopback address for the app to receive the code — \
             `{host}` is not. Use http://127.0.0.1:<port>/callback and register that \
             with the provider."
        ));
    }

    let port = parsed
        .port()
        .ok_or_else(|| "redirect URI needs an explicit port, e.g. http://127.0.0.1:8731/callback".to_string())?;

    Ok((port, parsed.path().to_string()))
}

/// Waits for the browser to come back, and returns the query it carried.
async fn await_redirect(port: u16) -> Result<HashMap<String, String>, String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        format!("cannot listen on 127.0.0.1:{port} for the redirect: {e}. Is another app using it?")
    })?;

    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|e| format!("redirect listener failed: {e}"))?;

        // The request line holds everything needed; headers and body are not
        // read beyond whatever arrived in the first packet.
        let mut buffer = [0u8; 8192];
        let read = socket
            .read(&mut buffer)
            .await
            .map_err(|e| format!("cannot read the redirect request: {e}"))?;
        let text = String::from_utf8_lossy(&buffer[..read]).to_string();

        let target = text
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();

        // A browser asks for /favicon.ico unprompted; answering it as if it were
        // the callback would abandon the flow.
        let query = match target.split_once('?') {
            Some((_, q)) if !q.is_empty() => q.to_string(),
            _ => {
                let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
        };

        let params = parse_query(&query);
        let page = result_page(&params);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            page.len(),
            page
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.flush().await;

        return Ok(params);
    }
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(name), percent_decode(value));
    }
    map
}

fn percent_decode(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// What the browser shows once it has handed the code back.
fn result_page(params: &HashMap<String, String>) -> String {
    let (title, detail) = match params.get("error").map(String::as_str) {
        Some(error) if !error.is_empty() => (
            "Authorization failed",
            params
                .get("error_description")
                .cloned()
                .unwrap_or_else(|| error.to_string()),
        ),
        _ => (
            "Authorized",
            "You can close this tab and go back to APIKit.".to_string(),
        ),
    };
    format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;margin:0\">\
         <div style=\"text-align:center\"><h2 style=\"margin:0 0 .4em\">{title}</h2>\
         <p style=\"color:#666;margin:0\">{}</p></div>",
        html_escape(&detail)
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// --- commands ----------------------------------------------------------------

/// Client credentials, resource owner password, or a refresh — the grants that
/// need no browser. `grant` picks which.
#[tauri::command]
pub async fn oauth_token(
    config: OauthConfig,
    grant: String,
    refresh_token: String,
) -> Result<TokenSet, String> {
    let mut form: Vec<(String, String)> = Vec::new();

    match grant.as_str() {
        "clientCredentials" => {
            form.push(("grant_type".into(), "client_credentials".into()));
            if !config.scope.trim().is_empty() {
                form.push(("scope".into(), config.scope.clone()));
            }
        }
        "password" => {
            form.push(("grant_type".into(), "password".into()));
            form.push(("username".into(), config.username.clone()));
            form.push(("password".into(), config.password.clone()));
            if !config.scope.trim().is_empty() {
                form.push(("scope".into(), config.scope.clone()));
            }
        }
        "refreshToken" => {
            if refresh_token.trim().is_empty() {
                return Err("no refresh token — request a new one instead".into());
            }
            form.push(("grant_type".into(), "refresh_token".into()));
            form.push(("refresh_token".into(), refresh_token.clone()));
            // Scope may be narrowed on refresh but never widened; sending the
            // original is what providers expect when it is sent at all.
            if !config.scope.trim().is_empty() {
                form.push(("scope".into(), config.scope.clone()));
            }
        }
        other => return Err(format!("`{other}` is not a grant that runs without a browser")),
    }

    let url = config.token_url.clone();
    let json = post_token(&config, &url, form).await?;
    let mut tokens = to_token_set(json);

    // A provider may omit the refresh token when refreshing, meaning "keep
    // using the one you have". Returning it empty would look like the session
    // ended, and the caller would store that over a token that still works.
    if grant == "refreshToken" && tokens.refresh_token.is_empty() {
        tokens.refresh_token = refresh_token;
    }

    Ok(tokens)
}

/// The authorization code grant. Opens the browser, waits for the redirect,
/// then exchanges the code.
#[tauri::command]
pub async fn oauth_authorize(
    app: tauri::AppHandle,
    config: OauthConfig,
) -> Result<TokenSet, String> {
    if config.authorize_url.trim().is_empty() {
        return Err("no authorization URL set".into());
    }
    let (port, _path) = redirect_parts(&config.redirect_uri)?;

    let state = base64url(&random_bytes(16));
    let verifier = code_verifier();

    let mut query = vec![
        ("response_type".to_string(), "code".to_string()),
        ("client_id".to_string(), config.client_id.clone()),
        ("redirect_uri".to_string(), config.redirect_uri.clone()),
        ("state".to_string(), state.clone()),
    ];
    if !config.scope.trim().is_empty() {
        query.push(("scope".into(), config.scope.clone()));
    }
    if config.use_pkce {
        query.push(("code_challenge".into(), code_challenge(&verifier)));
        query.push(("code_challenge_method".into(), "S256".into()));
    }
    for pair in &config.extra_params {
        if !pair.name.trim().is_empty() {
            query.push((pair.name.clone(), pair.value.clone()));
        }
    }

    let separator = if config.authorize_url.contains('?') { '&' } else { '?' };
    let url = format!(
        "{}{separator}{}",
        config.authorize_url,
        query
            .iter()
            .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
            .collect::<Vec<_>>()
            .join("&")
    );

    // Bind before opening the browser: the redirect can arrive the instant the
    // user is already signed in, and a listener started afterwards would miss
    // it and hang for the full timeout.
    let waiting = tokio::spawn(await_redirect(port));

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url.clone(), None::<&str>)
            .map_err(|e| format!("cannot open the browser: {e}"))?;
    }

    let params = match tokio::time::timeout(AUTHORIZE_TIMEOUT, waiting).await {
        Ok(Ok(Ok(params))) => params,
        Ok(Ok(Err(e))) => return Err(e),
        Ok(Err(e)) => return Err(format!("redirect listener stopped: {e}")),
        Err(_) => {
            return Err(format!(
                "no redirect after {}s — the flow was not completed in the browser",
                AUTHORIZE_TIMEOUT.as_secs()
            ))
        }
    };

    if let Some(error) = params.get("error") {
        let detail = params.get("error_description").cloned().unwrap_or_default();
        return Err(if detail.is_empty() {
            error.clone()
        } else {
            format!("{error}: {detail}")
        });
    }

    // A mismatched state means the response is not the one this flow started,
    // which is exactly the CSRF case the parameter exists to catch.
    match params.get("state") {
        Some(returned) if *returned == state => {}
        Some(_) => return Err("the redirect carried a different `state` — discarding it".into()),
        None => return Err("the redirect carried no `state`".into()),
    }

    let code = params
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "the redirect carried no authorization code".to_string())?;

    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.clone()),
        ("redirect_uri".to_string(), config.redirect_uri.clone()),
    ];
    if config.use_pkce {
        form.push(("code_verifier".into(), verifier));
    }

    let url = config.token_url.clone();
    let json = post_token(&config, &url, form).await?;
    Ok(to_token_set(json))
}

/// Device code, step one: ask for a code the user types on another device.
#[tauri::command]
pub async fn oauth_device_start(config: OauthConfig) -> Result<DeviceAuth, String> {
    if config.device_url.trim().is_empty() {
        return Err("no device authorization URL set".into());
    }

    let mut form = vec![];
    if !config.scope.trim().is_empty() {
        form.push(("scope".to_string(), config.scope.clone()));
    }

    let url = config.device_url.clone();
    let json = post_token(&config, &url, form).await?;

    let device_code = string_field(&json, "device_code");
    if device_code.is_empty() {
        return Err("the device endpoint returned no device_code".into());
    }

    Ok(DeviceAuth {
        device_code,
        user_code: string_field(&json, "user_code"),
        verification_uri: string_field(&json, "verification_uri"),
        verification_uri_complete: string_field(&json, "verification_uri_complete"),
        // RFC 8628 §3.2: absent means poll every 5 seconds.
        interval_secs: number_field(&json, "interval").unwrap_or(5).max(1),
        expires_in_secs: number_field(&json, "expires_in").unwrap_or(600),
    })
}

/// Device code, step two: poll until the user finishes, or time runs out.
#[tauri::command]
pub async fn oauth_device_poll(
    config: OauthConfig,
    device_code: String,
    interval_secs: u64,
    expires_in_secs: u64,
) -> Result<TokenSet, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(expires_in_secs.clamp(30, 1800));
    let mut wait = Duration::from_secs(interval_secs.clamp(1, 60));

    loop {
        if std::time::Instant::now() >= deadline {
            return Err("the device code expired before it was approved".into());
        }
        tokio::time::sleep(wait).await;

        let form = vec![
            (
                "grant_type".to_string(),
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("device_code".to_string(), device_code.clone()),
        ];

        let url = config.token_url.clone();
        match post_token(&config, &url, form).await {
            Ok(json) => return Ok(to_token_set(json)),
            Err(message) => {
                // RFC 8628 §3.5. `authorization_pending` is the normal answer
                // while the user is still typing; `slow_down` asks for a longer
                // gap and must be honoured or the provider starts refusing.
                if message.starts_with("authorization_pending") {
                    continue;
                }
                if message.starts_with("slow_down") {
                    wait += Duration::from_secs(5);
                    continue;
                }
                return Err(message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_has_no_padding_and_no_unsafe_characters() {
        // Lengths 1..4 cover every remainder case in the 3-byte grouping.
        for len in 1..=4 {
            let encoded = base64url(&vec![0xffu8; len]);
            assert!(!encoded.contains('='), "{encoded} should not be padded");
            assert!(!encoded.contains('+') && !encoded.contains('/'), "{encoded}");
        }
        assert_eq!(base64url(b""), "");
        // Known vector, so a rewrite of the bit twiddling cannot pass silently.
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn verifier_and_challenge_meet_rfc7636() {
        let verifier = code_verifier();
        assert_eq!(verifier.len(), 43, "shortest length the RFC allows");
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));

        // The RFC's own worked example (appendix B).
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn two_verifiers_differ() {
        assert_ne!(code_verifier(), code_verifier());
    }

    #[test]
    fn query_parsing_decodes_and_survives_odd_input() {
        let params = parse_query("code=a%2Bb&state=x%20y&empty=&flag");
        assert_eq!(params.get("code").unwrap(), "a+b");
        assert_eq!(params.get("state").unwrap(), "x y");
        assert_eq!(params.get("empty").unwrap(), "");
        assert_eq!(params.get("flag").unwrap(), "");
    }

    #[test]
    fn percent_encoding_leaves_unreserved_alone() {
        assert_eq!(percent_encode("aZ0-_.~"), "aZ0-_.~");
        assert_eq!(percent_encode("a b&c=d"), "a%20b%26c%3Dd");
        // A scope list is space separated, and the space must survive as %20.
        assert_eq!(percent_encode("openid profile"), "openid%20profile");
    }

    #[test]
    fn redirect_must_be_loopback_with_a_port() {
        assert_eq!(
            redirect_parts("http://127.0.0.1:8731/callback").unwrap(),
            (8731, "/callback".to_string())
        );
        assert!(redirect_parts("http://example.com:80/cb").is_err());
        assert!(redirect_parts("http://127.0.0.1/cb").is_err());
        assert!(redirect_parts("not a url").is_err());
    }

    #[test]
    fn numbers_parse_whether_quoted_or_not() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"a":30,"b":"45","c":"x","d":null}"#).unwrap();
        assert_eq!(number_field(&json, "a"), Some(30));
        assert_eq!(number_field(&json, "b"), Some(45));
        assert_eq!(number_field(&json, "c"), None);
        assert_eq!(number_field(&json, "d"), None);
        assert_eq!(number_field(&json, "missing"), None);
    }

    #[test]
    fn token_type_defaults_to_bearer() {
        let json: serde_json::Value = serde_json::from_str(r#"{"access_token":"t"}"#).unwrap();
        let tokens = to_token_set(json);
        assert_eq!(tokens.token_type, "Bearer");
        assert_eq!(tokens.access_token, "t");
        // No expires_in means an unknown lifetime, not an unlimited one.
        assert_eq!(tokens.expires_at_ms, None);
    }

    #[test]
    fn expiry_becomes_an_absolute_instant() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"access_token":"t","expires_in":3600}"#).unwrap();
        let before = now_ms();
        let tokens = to_token_set(json);
        let expires = tokens.expires_at_ms.unwrap();
        assert!(expires >= before + 3_600_000 && expires <= now_ms() + 3_600_000);
    }

    #[test]
    fn html_in_a_provider_error_is_escaped() {
        let mut params = HashMap::new();
        params.insert("error".to_string(), "invalid_scope".to_string());
        params.insert(
            "error_description".to_string(),
            "<script>alert(1)</script>".to_string(),
        );
        let page = result_page(&params);
        assert!(page.contains("&lt;script&gt;"));
        assert!(!page.contains("<script>"));
    }
}
