//! A small HTTP server that replays canned responses.
//!
//! Routes are edited in the UI, persisted by [`crate::store`], and held here in
//! an `RwLock` so edits take effect on the next request without a restart.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::store::{read_mock_routes, Db, MockRoute};

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

fn find_route<'a>(routes: &'a [MockRoute], method: &str, path: &str) -> Option<&'a MockRoute> {
    // Folder rows carry no response; they only give the list its shape.
    routes.iter().find(|r| {
        !r.is_folder
            && r.enabled
            && method_matches(&r.method, method)
            && path_matches(&r.path, path)
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    routes: Arc<RwLock<Vec<MockRoute>>>,
    hits: Arc<AtomicU64>,
    app: AppHandle,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();

    // Clone the match out so the lock is not held across the delay/await.
    let matched = {
        let guard = routes.read().unwrap();
        find_route(&guard, &method, &path).cloned()
    };

    hits.fetch_add(1, Ordering::Relaxed);

    let response = match &matched {
        Some(route) => {
            if route.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(route.delay_ms)).await;
            }
            let status =
                StatusCode::from_u16(route.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut builder = Response::builder().status(status);
            for header in &route.headers {
                if !header.name.trim().is_empty() {
                    builder = builder.header(&header.name, &header.value);
                }
            }
            builder
                .body(Full::new(Bytes::from(route.body.clone())))
                .unwrap_or_else(|_| {
                    Response::new(Full::new(Bytes::from_static(b"invalid mock response")))
                })
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(
                r#"{"error":"no mock route matched this request"}"#,
            )))
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
                    let app = app.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req| {
                            handle(req, routes.clone(), hits.clone(), app.clone())
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
