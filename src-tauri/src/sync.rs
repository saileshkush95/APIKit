//! Local-network sync between peers.
//!
//! Every instance keeps its own database and stays fully usable offline. One
//! instance shares over the LAN; others connect to it and exchange rows changed
//! since their last sync, resolved last-write-wins per row (see
//! [`crate::store`]). Any number of peers can be configured, and sync is
//! symmetric — each round trip both pushes and pulls.
//!
//! The transport is plain HTTP on the local network guarded by a pairing token,
//! so it is only appropriate on a network you trust.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};

use crate::store::{apply, now_ms, snapshot, ApplyReport, Db, SyncPayload};

pub struct SyncState {
    running: Mutex<Option<Running>>,
    token: Mutex<String>,
    /// Fires whenever this machine's data changes, so subscribed peers can pull
    /// straight away instead of waiting for their next poll.
    changes: broadcast::Sender<()>,
    /// Cancel handles for the peer streams this machine is watching.
    watchers: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl Default for SyncState {
    fn default() -> Self {
        let (changes, _) = broadcast::channel(16);
        Self {
            running: Mutex::new(None),
            token: Mutex::new(String::new()),
            changes,
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

type ResponseBody = BoxBody<Bytes, Infallible>;

struct Running {
    port: u16,
    shutdown: watch::Sender<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub addresses: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest {
    workspace_id: String,
    /// Peer wants everything changed after this point on our side.
    since: i64,
    changes: SyncPayload,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    changes: SyncPayload,
    applied: usize,
    now: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub pushed: usize,
    pub pulled: usize,
    pub skipped: usize,
    /// Peer's clock, so the UI can warn about skew that would break
    /// last-write-wins.
    pub peer_now: i64,
    pub local_now: i64,
    /// Watermarks for the next round: what we pulled, and when we pushed.
    pub pulled_watermark: i64,
    pub pushed_watermark: i64,
}

/// This machine's LAN address, discovered without sending anything.
fn local_addresses() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        // Connecting a UDP socket only sets the default route; no packets go out.
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                found.push(addr.ip().to_string());
            }
        }
    }
    found.push("127.0.0.1".to_string());
    found.dedup();
    found
}

fn json_response(status: StatusCode, body: String) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(BodyExt::boxed(Full::new(Bytes::from(body))))
        .unwrap()
}

/// Server-sent events stream that ticks whenever this machine's data changes.
/// A comment frame every 20s keeps idle connections from being dropped.
fn events_response(rx: broadcast::Receiver<()>) -> Response<ResponseBody> {
    // The receiver travels as the unfold state rather than being captured, so
    // nothing is borrowed across the yielded futures.
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        let frame = match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
            Ok(Ok(())) => "data: changed\n\n",
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => "data: changed\n\n",
            Ok(Err(broadcast::error::RecvError::Closed)) => return None,
            Err(_) => ": ping\n\n",
        };
        Some((Ok::<_, Infallible>(Frame::data(Bytes::from(frame))), rx))
    });

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(BodyExt::boxed(StreamBody::new(stream)))
        .unwrap()
}

fn authorized(req: &Request<hyper::body::Incoming>, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    req.headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|provided| provided == token)
        .unwrap_or(false)
}

/// Routing and protocol handling, independent of Tauri so it can be exercised
/// in tests against a real socket.
async fn route(
    req: Request<hyper::body::Incoming>,
    db: &Db,
    token: Arc<Mutex<String>>,
    changes: broadcast::Sender<()>,
) -> (Response<ResponseBody>, usize) {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // Lets a peer verify the token and compare clocks before syncing.
    if path == "/ping" {
        return (
            json_response(
                StatusCode::OK,
                serde_json::json!({ "app": "webrequestkit", "now": now_ms() }).to_string(),
            ),
            0,
        );
    }

    if path == "/events" && method == hyper::Method::GET {
        let expected = token.lock().map(|t| t.clone()).unwrap_or_default();
        if !authorized(&req, &expected) {
            return (
                json_response(
                    StatusCode::UNAUTHORIZED,
                    r#"{"error":"invalid pairing token"}"#.to_string(),
                ),
                0,
            );
        }
        return (events_response(changes.subscribe()), 0);
    }

    if path != "/sync" || method != hyper::Method::POST {
        return (
            json_response(
                StatusCode::NOT_FOUND,
                r#"{"error":"not found"}"#.to_string(),
            ),
            0,
        );
    }

    let expected = token.lock().map(|t| t.clone()).unwrap_or_default();
    if !authorized(&req, &expected) {
        return (
            json_response(
                StatusCode::UNAUTHORIZED,
                r#"{"error":"invalid pairing token"}"#.to_string(),
            ),
            0,
        );
    }

    let body = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(e) => {
            return (
                json_response(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": e.to_string() }).to_string(),
                ),
                0,
            )
        }
    };

    let request: SyncRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(e) => {
            return (
                json_response(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": format!("malformed sync payload: {e}") })
                        .to_string(),
                ),
                0,
            )
        }
    };

    let result = (|| -> Result<SyncResponse, String> {
        let applied = {
            let mut conn = db.0.lock().map_err(|e| e.to_string())?;
            apply(&mut conn, &request.changes)?
        };
        let changes = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            snapshot(&conn, &request.workspace_id, request.since)?
        };
        Ok(SyncResponse {
            changes,
            applied: applied.applied,
            now: now_ms(),
        })
    })();

    match result {
        Ok(response) => {
            let applied = response.applied;
            if applied > 0 {
                // Tell every watching peer, so a change made on one machine
                // reaches all of them rather than only the one that pushed.
                let _ = changes.send(());
            }
            (
                json_response(
                    StatusCode::OK,
                    serde_json::to_string(&response).unwrap_or_default(),
                ),
                applied,
            )
        }
        Err(e) => (
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": e }).to_string(),
            ),
            0,
        ),
    }
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    app: AppHandle,
    token: Arc<Mutex<String>>,
    changes: broadcast::Sender<()>,
) -> Result<Response<ResponseBody>, Infallible> {
    let (response, applied) = {
        let db = app.state::<Db>();
        route(req, &db, token, changes).await
    };
    if applied > 0 {
        // Tell the UI to reload; the database changed underneath it.
        let _ = app.emit("sync://applied", applied);
    }
    Ok(response)
}

#[tauri::command]
pub async fn start_sync_server(
    app: AppHandle,
    state: State<'_, SyncState>,
    port: u16,
    token: String,
) -> Result<u16, String> {
    if token.trim().is_empty() {
        return Err("a pairing token is required".into());
    }
    if state.running.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("sync is already being shared".into());
    }

    *state.token.lock().map_err(|e| e.to_string())? = token;

    // Bound to all interfaces so peers on the LAN can reach it.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot bind {addr}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let token_handle = Arc::new(Mutex::new(
        state.token.lock().map_err(|e| e.to_string())?.clone(),
    ));
    let changes_handle = state.changes.clone();

    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() { break }
                }
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let app = app.clone();
                    let token = token_handle.clone();
                    let changes = changes_handle.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req| {
                            handle(req, app.clone(), token.clone(), changes.clone())
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
pub fn stop_sync_server(state: State<SyncState>) -> Result<(), String> {
    if let Some(running) = state.running.lock().map_err(|e| e.to_string())?.take() {
        let _ = running.shutdown.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn sync_server_status(state: State<SyncState>) -> Result<SyncServerStatus, String> {
    let running = state.running.lock().map_err(|e| e.to_string())?;
    Ok(SyncServerStatus {
        running: running.is_some(),
        port: running.as_ref().map(|r| r.port),
        addresses: local_addresses(),
    })
}

/// Checks a peer is reachable and reports its clock, for skew warnings.
#[tauri::command]
pub async fn ping_peer(host: String) -> Result<i64, String> {
    let url = format!("http://{}/ping", host.trim().trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("cannot reach {host}: {e}"))?;
    let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    value
        .get("now")
        .and_then(|now| now.as_i64())
        .ok_or_else(|| "peer did not answer with a clock".to_string())
}

/// One sync round trip with a peer: push what changed here, apply what changed
/// there.
#[tauri::command]
pub async fn sync_with_peer(
    app: AppHandle,
    host: String,
    token: String,
    workspace_id: String,
    pulled_watermark: i64,
    pushed_watermark: i64,
) -> Result<SyncOutcome, String> {
    let db = app.state::<Db>();

    let local_now = now_ms();
    let outgoing = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        snapshot(&conn, &workspace_id, pushed_watermark)?
    };
    let pushed = outgoing.rows.len();

    let url = format!("http://{}/sync", host.trim().trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&token)
        .timeout(std::time::Duration::from_secs(30))
        .json(&SyncRequest {
            workspace_id: workspace_id.clone(),
            since: pulled_watermark,
            changes: outgoing,
        })
        .send()
        .await
        .map_err(|e| format!("cannot reach {host}: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("the peer rejected this pairing token".into());
    }
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("peer returned {status}: {detail}"));
    }

    let body: SyncResponse = response
        .json()
        .await
        .map_err(|e| format!("malformed reply from peer: {e}"))?;

    let report: ApplyReport = {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        apply(&mut conn, &body.changes)?
    };

    if report.applied > 0 {
        let _ = app.emit("sync://applied", report.applied);
    }

    Ok(SyncOutcome {
        pushed,
        pulled: report.applied,
        skipped: report.skipped,
        peer_now: body.now,
        local_now,
        // Advance by what the peer actually sent, so the watermark never
        // depends on the two machines' clocks agreeing.
        pulled_watermark: report.max_updated_at.max(pulled_watermark),
        pushed_watermark: local_now,
    })
}


// --- Live sync ----------------------------------------------------------------

/// Announces a local change to peers watching this machine's event stream.
#[tauri::command]
pub fn notify_local_change(state: State<SyncState>) -> Result<(), String> {
    // No subscribers is the normal case; the error just means nobody listened.
    let _ = state.changes.send(());
    Ok(())
}

/// Watches a peer's event stream and emits `sync://peer-changed` whenever it
/// reports a change, so the UI can pull immediately. Reconnects on drop.
#[tauri::command]
pub async fn sync_watch_peer(
    app: AppHandle,
    state: State<'_, SyncState>,
    host: String,
    token: String,
) -> Result<(), String> {
    let key = host.trim().to_string();
    if key.is_empty() {
        return Err("a peer address is required".into());
    }

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    {
        let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = watchers.insert(key.clone(), cancel_tx) {
            let _ = existing.send(true);
        }
    }

    let url = format!("http://{}/events", key.trim_end_matches('/'));
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            if *cancel_rx.borrow() {
                break;
            }

            let attempt = client
                .get(&url)
                .bearer_auth(&token)
                // No overall timeout: the stream is meant to stay open.
                .send()
                .await;

            match attempt {
                Ok(response) if response.status().is_success() => {
                    let _ = app.emit("sync://watch-state", (key.clone(), true));
                    let mut stream = response.bytes_stream();
                    loop {
                        tokio::select! {
                            _ = cancel_rx.changed() => break,
                            chunk = stream.next() => {
                                match chunk {
                                    Some(Ok(bytes)) => {
                                        let text = String::from_utf8_lossy(&bytes);
                                        // Comment frames are heartbeats.
                                        if text.contains("data:") {
                                            let _ = app.emit("sync://peer-changed", key.clone());
                                        }
                                    }
                                    _ => break,
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            let _ = app.emit("sync://watch-state", (key.clone(), false));
            if *cancel_rx.borrow() {
                break;
            }
            // Backoff before reconnecting, so a peer that is asleep does not
            // spin the loop.
            tokio::select! {
                _ = cancel_rx.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn sync_unwatch_peer(state: State<SyncState>, host: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if let Some(cancel) = watchers.remove(host.trim()) {
        let _ = cancel.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{write_tree, TreeNode};
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU16, Ordering};

    /// Two databases, a real server on a real socket, and the real client
    /// command path — the parts LAN sync uses that the store tests cannot cover.
    struct Harness {
        port: u16,
        token: String,
        server_db: Arc<Db>,
        shutdown: watch::Sender<bool>,
        changes: broadcast::Sender<()>,
    }

    fn memory_db() -> Db {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(crate::store::SCHEMA).expect("schema");
        conn.execute_batch(crate::store::INDEXES).expect("indexes");
        conn.execute(
            "INSERT INTO workspaces (id, name, position, updated_at) VALUES ('w', 'Test', 0, 1)",
            [],
        )
        .expect("workspace");
        Db(Mutex::new(conn))
    }

    fn request(id: &str, name: &str) -> TreeNode {
        TreeNode::Request {
            id: id.into(),
            name: name.into(),
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: vec![],
            body: String::new(),
            tests: serde_json::Value::Array(vec![]),
            config: serde_json::Value::Object(Default::default()),
        }
    }

    fn next_port() -> u16 {
        // Fixed range so a failed test cannot collide with a real server.
        static NEXT: AtomicU16 = AtomicU16::new(17420);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    async fn start(token: &str) -> Harness {
        let db = Arc::new(memory_db());
        let (changes, _) = broadcast::channel(16);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        let mut port = next_port();
        let listener = loop {
            match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                Ok(listener) => break listener,
                Err(_) => port = next_port(),
            }
        };

        let token_handle = Arc::new(Mutex::new(token.to_string()));
        let serve_db = db.clone();
        let serve_changes = changes.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let db = serve_db.clone();
                        let token = token_handle.clone();
                        let changes = serve_changes.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |req| {
                                let db = db.clone();
                                let token = token.clone();
                                let changes = changes.clone();
                                async move {
                                    let (response, _) = route(req, &db, token, changes).await;
                                    Ok::<_, Infallible>(response)
                                }
                            });
                            let _ = hyper::server::conn::http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
        });

        // Give the accept loop a moment to be ready.
        tokio::time::sleep(Duration::from_millis(50)).await;

        Harness {
            port,
            token: token.to_string(),
            server_db: db,
            shutdown: shutdown_tx,
            changes,
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = self.shutdown.send(true);
        }
    }

    /// The client half of `sync_with_peer`, without the Tauri plumbing.
    async fn sync_once(
        client_db: &Db,
        harness: &Harness,
        token: &str,
        pulled: i64,
        pushed: i64,
    ) -> Result<(usize, usize, i64), String> {
        let outgoing = {
            let conn = client_db.0.lock().unwrap();
            snapshot(&conn, "w", pushed)?
        };
        let sent = outgoing.rows.len();

        let response = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/sync", harness.port))
            .bearer_auth(token)
            .json(&SyncRequest {
                workspace_id: "w".into(),
                since: pulled,
                changes: outgoing,
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("status {}", response.status()));
        }

        let body: SyncResponse = response.json().await.map_err(|e| e.to_string())?;
        let report = {
            let mut conn = client_db.0.lock().unwrap();
            apply(&mut conn, &body.changes)?
        };
        Ok((sent, report.applied, report.max_updated_at.max(pulled)))
    }

    #[tokio::test]
    async fn ping_reports_a_clock() {
        let harness = start("secret").await;
        let value: serde_json::Value = reqwest::get(format!(
            "http://127.0.0.1:{}/ping",
            harness.port
        ))
        .await
        .expect("reachable")
        .json()
        .await
        .expect("json");

        assert_eq!(value["app"], "webrequestkit");
        assert!(value["now"].as_i64().unwrap_or(0) > 0);
    }

    #[tokio::test]
    async fn a_wrong_token_is_rejected() {
        let harness = start("secret").await;
        let client = memory_db();

        let denied = sync_once(&client, &harness, "not-the-token", 0, 0).await;
        assert!(denied.is_err(), "sync must fail with a bad token");

        let events = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/events", harness.port))
            .bearer_auth("not-the-token")
            .send()
            .await
            .expect("reachable");
        assert_eq!(events.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_round_trip_moves_rows_both_ways() {
        let harness = start("secret").await;
        let client = memory_db();

        // Each side creates something the other has never seen.
        {
            let mut conn = client.0.lock().unwrap();
            write_tree(&mut conn, "w", &[request("r-client", "From client")]).unwrap();
        }
        {
            let mut conn = harness.server_db.0.lock().unwrap();
            write_tree(&mut conn, "w", &[request("r-server", "From server")]).unwrap();
        }

        let (pushed, pulled, watermark) =
            sync_once(&client, &harness, &harness.token, 0, 0).await.unwrap();
        assert_eq!(pushed, 1, "client sends its own row");
        assert_eq!(pulled, 1, "client receives the server's row");

        // Both databases now hold both requests.
        for db in [&client, &*harness.server_db] {
            let conn = db.0.lock().unwrap();
            let names: Vec<String> = crate::store::read_tree(&conn, "w")
                .unwrap()
                .iter()
                .map(|node| match node {
                    TreeNode::Request { name, .. } => name.clone(),
                    TreeNode::Folder { name, .. } => name.clone(),
                })
                .collect();
            assert!(names.contains(&"From client".to_string()), "{names:?}");
            assert!(names.contains(&"From server".to_string()), "{names:?}");
        }

        // A second round with the new watermark has nothing left to move.
        let (pushed, pulled, _) = sync_once(&client, &harness, &harness.token, watermark, now_ms())
            .await
            .unwrap();
        assert_eq!((pushed, pulled), (0, 0), "sync must settle");
    }

    #[tokio::test]
    async fn the_event_stream_announces_changes() {
        let harness = start("secret").await;

        let mut stream = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/events", harness.port))
            .bearer_auth(&harness.token)
            .send()
            .await
            .expect("stream opens")
            .bytes_stream();

        // Let the subscription land before broadcasting.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = harness.changes.send(());

        let frame = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .expect("a frame arrives before the timeout")
            .expect("stream is open")
            .expect("frame reads");

        assert!(
            String::from_utf8_lossy(&frame).contains("data: changed"),
            "expected a change frame"
        );
    }
}
