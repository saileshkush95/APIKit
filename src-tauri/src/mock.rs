//! A small HTTP server that replays canned responses.
//!
//! Routes are edited in the UI, persisted by [`crate::store`], and held here in
//! an `RwLock` so edits take effect on the next request without a restart.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::store::{read_mock_routes, Db, MockRoute};

/// Every mock response is boxed, so a static body and an event stream can be
/// returned from the same places.
type ResponseBody = BoxBody<Bytes, Infallible>;

fn boxed(bytes: impl Into<Bytes>) -> ResponseBody {
    BodyExt::boxed(Full::new(bytes.into()))
}

#[derive(Default)]
pub struct MockState {
    running: Mutex<Option<Running>>,
    routes: Arc<RwLock<Vec<MockRoute>>>,
    hits: Arc<AtomicU64>,
}

struct Running {
    port: u16,
    shutdown: watch::Sender<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MockStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub hit_count: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MockHit {
    pub method: String,
    pub path: String,
    pub status: u16,
    /// Id of the route that matched, or `None` when nothing did.
    pub route_id: Option<String>,
    pub at_ms: u64,
}

/// Matches `path` against a route pattern, honouring a trailing `*` wildcard.
fn path_matches(pattern: &str, path: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => path.starts_with(prefix),
        None => pattern == path,
    }
}

fn method_matches(pattern: &str, method: &str) -> bool {
    pattern.eq_ignore_ascii_case("ANY") || pattern.eq_ignore_ascii_case(method)
}

/// The conditions beyond method and path: a route can require query pairs,
/// headers, or a substring of the body, so several routes can share a path and
/// answer different requests.
fn conditions_match(
    route: &MockRoute,
    query: Option<&str>,
    headers: &hyper::HeaderMap,
    body: &str,
) -> bool {
    for pair in route.match_query.split('&') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let present = query
            .map(|q| q.split('&').any(|candidate| candidate.trim() == pair))
            .unwrap_or(false);
        if !present {
            return false;
        }
    }

    for header in &route.match_headers {
        if header.name.trim().is_empty() {
            continue;
        }
        let actual = headers
            .get(header.name.trim())
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if header.value.trim().is_empty() {
            // A name with no value only requires the header to be present.
            if actual.is_empty() {
                return false;
            }
        } else if actual != header.value.trim() {
            return false;
        }
    }

    if !route.match_body.trim().is_empty() && !body.contains(route.match_body.trim()) {
        return false;
    }

    true
}

fn find_route<'a>(
    routes: &'a [MockRoute],
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &hyper::HeaderMap,
    body: &str,
) -> Option<&'a MockRoute> {
    // Folder rows carry no response; they only give the list its shape.
    routes.iter().find(|r| {
        !r.is_folder
            && r.enabled
            && method_matches(&r.method, method)
            && path_matches(&r.path, path)
            && conditions_match(r, query, headers, body)
    })
}

/// Cheap xorshift seeded from the clock. Mock randomness needs to be varied,
/// not cryptographic, and this avoids a dependency for it.
fn pseudo_random() -> u64 {
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ (d.as_secs() << 17))
        .unwrap_or(0x2545F491)
        | 1;
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    seed
}

/// Substitutes `{{…}}` placeholders in a template response.
fn render_template(
    body: &str,
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &hyper::HeaderMap,
    request_body: &str,
) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes: Vec<char> = body.chars().collect();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == '{' && i + 1 < bytes.len() && bytes[i + 1] == '{' {
            if let Some(end) = body[i..].find("}}") {
                let token = body[i + 2..i + end].trim().to_string();
                out.push_str(&resolve_token(
                    &token,
                    method,
                    path,
                    query,
                    headers,
                    request_body,
                ));
                // Advance past the placeholder in char terms.
                let consumed = body[i..i + end + 2].chars().count();
                i += consumed;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn resolve_token(
    token: &str,
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &hyper::HeaderMap,
    request_body: &str,
) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();

    if let Some(name) = token.strip_prefix("query.") {
        return query
            .and_then(|q| {
                q.split('&').find_map(|pair| {
                    let (key, value) = pair.split_once('=')?;
                    (key == name).then(|| value.to_owned())
                })
            })
            .unwrap_or_default();
    }
    if let Some(name) = token.strip_prefix("header.") {
        return headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
    }

    match token {
        "uuid" => {
            // Version-4 shaped, from two pseudo-random words.
            let (a, b) = (pseudo_random(), pseudo_random());
            format!(
                "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
                a as u32,
                (a >> 32) as u16,
                (b & 0xfff) as u16,
                ((b >> 12) as u16 & 0x3fff) | 0x8000,
                (b >> 26) & 0xffff_ffff_ffff
            )
        }
        "timestamp" => now.as_secs().to_string(),
        "now" => crate::mock::iso_now(),
        "randomInt" => (pseudo_random() % 1000).to_string(),
        "method" => method.to_owned(),
        "path" => path.to_owned(),
        "body" => request_body.to_owned(),
        // An unknown placeholder is left as written, so a typo is visible
        // rather than silently blanking part of the response.
        other => format!("{{{{{other}}}}}"),
    }
}

/// RFC 3339 timestamp without pulling in a date library.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Civil-from-days, Howard Hinnant's algorithm.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A server-sent event stream from the route's body: each `---` separated
/// chunk becomes one event, spaced by the route's delay so a client can be
/// watched consuming them. Ends the stream after the last one.
fn sse_response(route: &MockRoute, body: String) -> Response<ResponseBody> {
    let events: Vec<String> = body
        .split("\n---\n")
        .map(|part| part.trim_matches('\n').to_string())
        .filter(|part| !part.is_empty())
        .collect();
    // Between events, not before the first: a stream that stalls on connect
    // looks broken.
    let gap = Duration::from_millis(route.delay_ms.max(500));

    let stream = futures::stream::unfold(
        (events.into_iter(), true),
        move |(mut rest, first)| async move {
            let event = rest.next()?;
            if !first {
                tokio::time::sleep(gap).await;
            }
            // Every line of a multi-line payload needs its own `data:`.
            let payload = event
                .lines()
                .map(|line| format!("data: {line}\n"))
                .collect::<String>();
            Some((
                Ok::<_, Infallible>(hyper::body::Frame::data(Bytes::from(format!(
                    "{payload}\n"
                )))),
                (rest, false),
            ))
        },
    );

    let mut builder = Response::builder()
        .status(StatusCode::from_u16(route.status).unwrap_or(StatusCode::OK))
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .header("connection", "keep-alive");
    for header in &route.headers {
        if !header.name.trim().is_empty()
            && !header.name.eq_ignore_ascii_case("content-type")
        {
            builder = builder.header(&header.name, &header.value);
        }
    }
    if route.cors {
        builder = cors_headers(builder);
    }
    builder
        .body(BodyExt::boxed(StreamBody::new(stream)))
        .unwrap_or_else(|_| Response::new(boxed(Bytes::new())))
}

/// Permissive CORS, so a browser app can call the mock from any origin.
fn cors_headers(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder
        .header("access-control-allow-origin", "*")
        .header(
            "access-control-allow-methods",
            "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
        )
        .header("access-control-allow-headers", "*")
}

/// Forwards the request to a real server, so a mock can stand in for part of an
/// API while the rest passes through.
async fn proxy_response(
    route: &MockRoute,
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &hyper::HeaderMap,
    body: &str,
) -> Response<ResponseBody> {
    let target = route.proxy_target.trim().trim_end_matches('/');
    if target.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("content-type", "application/json")
            .body(boxed(
                r#"{"error":"proxy mode has no target URL"}"#,
            ))
            .unwrap();
    }

    let url = match query {
        Some(q) if !q.is_empty() => format!("{target}{path}?{q}"),
        _ => format!("{target}{path}"),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    for (name, value) in headers {
        // Host belongs to the mock's address, not the upstream's.
        if name.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        if let Ok(text) = value.to_str() {
            request = request.header(name.as_str(), text);
        }
    }
    if !body.is_empty() {
        request = request.body(body.to_owned());
    }

    match request.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let upstream_headers = upstream.headers().clone();
            let bytes = upstream.bytes().await.unwrap_or_default();
            let mut builder = Response::builder().status(status.as_u16());
            for (name, value) in &upstream_headers {
                // Re-chunking is ours to decide; copying these would lie.
                if matches!(
                    name.as_str(),
                    "transfer-encoding" | "content-length" | "connection"
                ) {
                    continue;
                }
                builder = builder.header(name.as_str(), value.as_bytes());
            }
            if route.cors {
                builder = cors_headers(builder);
            }
            builder
                .body(boxed(bytes))
                .unwrap_or_else(|_| Response::new(boxed(Bytes::new())))
        }
        Err(e) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("content-type", "application/json")
            .body(boxed(format!(
                r#"{{"error":"proxy to {url} failed: {e}"}}"#
            )))
            .unwrap(),
    }
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    routes: Arc<RwLock<Vec<MockRoute>>>,
    hits: Arc<AtomicU64>,
    sequence: Arc<Mutex<std::collections::HashMap<String, usize>>>,
    app: AppHandle,
) -> Result<Response<ResponseBody>, Infallible> {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| q.to_string());
    let headers = req.headers().clone();
    // Conditional matching and templates both need the body, so it is read up
    // front rather than only for the routes that turn out to use it.
    let request_body = {
        use http_body_util::BodyExt;
        req.into_body()
            .collect()
            .await
            .map(|collected| String::from_utf8_lossy(&collected.to_bytes()).into_owned())
            .unwrap_or_default()
    };

    // Clone the match out so the lock is not held across the delay/await.
    let matched = {
        let guard = routes.read().unwrap();
        find_route(
            &guard,
            &method,
            &path,
            query.as_deref(),
            &headers,
            &request_body,
        )
        .cloned()
    };

    hits.fetch_add(1, Ordering::Relaxed);

    // A browser's preflight never carries the real method, so a CORS route has
    // to answer OPTIONS itself or nothing else it serves is reachable.
    let preflight = method.eq_ignore_ascii_case("OPTIONS")
        && matched.as_ref().map(|route| route.cors).unwrap_or(false);

    let response = match &matched {
        Some(route) if preflight => cors_headers(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("access-control-max-age", "600"),
        )
        .body(boxed(Bytes::new()))
        .unwrap(),

        Some(route) => {
            if route.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(route.delay_ms)).await;
            }

            // Fault injection comes before the mode: the point is to exercise a
            // client's error handling on a route that otherwise succeeds.
            if route.fail_percent > 0
                && (pseudo_random() % 100) < route.fail_percent as u64
            {
                let mut builder = Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header("content-type", "application/json");
                if route.cors {
                    builder = cors_headers(builder);
                }
                builder
                    .body(boxed(
                        r#"{"error":"injected failure"}"#,
                    ))
                    .unwrap()
            } else if route.mode == "proxy" {
                proxy_response(route, &method, &path, query.as_deref(), &headers, &request_body)
                    .await
            } else if route.mode == "sse" {
                // Templated first, so an event stream can carry {{uuid}} and
                // the rest.
                sse_response(
                    route,
                    render_template(
                        &route.body,
                        &method,
                        &path,
                        query.as_deref(),
                        &headers,
                        &request_body,
                    ),
                )
            } else {
                let body = match route.mode.as_str() {
                    "template" => render_template(
                        &route.body,
                        &method,
                        &path,
                        query.as_deref(),
                        &headers,
                        &request_body,
                    ),
                    "sequence" => {
                        // Successive calls walk the `---` separated bodies and
                        // then repeat, which is how a stateful flow is mocked.
                        let parts: Vec<&str> = route
                            .body
                            .split("\n---\n")
                            .map(|part| part.trim_matches('\n'))
                            .collect();
                        let mut guard = sequence.lock().unwrap();
                        let index = guard.entry(route.id.clone()).or_insert(0);
                        let picked = parts[*index % parts.len().max(1)].to_string();
                        *index += 1;
                        picked
                    }
                    _ => route.body.clone(),
                };

                let status = StatusCode::from_u16(route.status)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let mut builder = Response::builder().status(status);
                for header in &route.headers {
                    if !header.name.trim().is_empty() {
                        builder = builder.header(&header.name, &header.value);
                    }
                }
                if route.cors {
                    builder = cors_headers(builder);
                }
                builder
                    .body(boxed(body))
                    .unwrap_or_else(|_| {
                        Response::new(boxed(Bytes::from_static(b"invalid mock response")))
                    })
            }
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "application/json")
            .body(boxed(
                r#"{"error":"no mock route matched this request"}"#,
            ))
            .unwrap(),
    };

    let _ = app.emit(
        "mock://hit",
        MockHit {
            method,
            path,
            status: response.status().as_u16(),
            route_id: matched.map(|r| r.id),
            at_ms: now_ms(),
        },
    );

    Ok(response)
}

#[tauri::command]
pub async fn start_mock_server(
    app: AppHandle,
    state: State<'_, MockState>,
    db: State<'_, Db>,
    workspace_id: String,
    port: u16,
) -> Result<u16, String> {
    if state.running.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("mock server is already running".into());
    }

    // Seed from the database so a restart serves whatever was last saved.
    let saved = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        read_mock_routes(&conn, &workspace_id)?
    };
    *state.routes.write().map_err(|e| e.to_string())? = saved;
    state.hits.store(0, Ordering::Relaxed);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot bind {addr}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let routes = state.routes.clone();
    let hits = state.hits.clone();
    // Per-route position for "sequence" mode, reset with each server start.
    let sequence: Arc<Mutex<std::collections::HashMap<String, usize>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));

    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() { break }
                }
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let routes = routes.clone();
                    let hits = hits.clone();
                    let sequence = sequence.clone();
                    let app = app.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req| {
                            handle(
                                req,
                                routes.clone(),
                                hits.clone(),
                                sequence.clone(),
                                app.clone(),
                            )
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await;
                    });
                }
            }
        }
    });

    *state.running.lock().map_err(|e| e.to_string())? = Some(Running {
        port: bound,
        shutdown: shutdown_tx,
    });

    Ok(bound)
}

#[tauri::command]
pub fn stop_mock_server(state: State<MockState>) -> Result<(), String> {
    if let Some(running) = state.running.lock().map_err(|e| e.to_string())?.take() {
        let _ = running.shutdown.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn mock_status(state: State<MockState>) -> Result<MockStatus, String> {
    let running = state.running.lock().map_err(|e| e.to_string())?;
    Ok(MockStatus {
        running: running.is_some(),
        port: running.as_ref().map(|r| r.port),
        hit_count: state.hits.load(Ordering::Relaxed),
    })
}

/// Applies edited routes to a live server (and is a no-op when stopped).
#[tauri::command]
pub fn apply_mock_routes(state: State<MockState>, routes: Vec<MockRoute>) -> Result<(), String> {
    *state.routes.write().map_err(|e| e.to_string())? = routes;
    Ok(())
}
