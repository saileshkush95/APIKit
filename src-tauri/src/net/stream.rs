//! Long-lived protocol sessions: WebSocket, Server-Sent Events, Socket.IO,
//! MQTT and GraphQL subscriptions.
//!
//! They differ in transport but share a shape — connect, exchange messages
//! until closed — so they are driven by one session registry. Every session
//! owns a task that pumps its transport and emits `stream://event` and
//! `stream://status` to the UI; outbound messages arrive over an mpsc channel.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use crate::store::Header;

#[derive(Default)]
pub struct StreamState {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<Outbound>>>,
}

/// What the UI can push into a live session.
enum Outbound {
    Send { text: String, topic: Option<String> },
    Close,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfig {
    /// One of: websocket, sse, socketio, mqtt, graphqlws.
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    /// MQTT topics to subscribe to on connect.
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub variables: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub qos: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundMessage {
    pub text: String,
    /// MQTT publish topic; ignored by the other transports.
    #[serde(default)]
    pub topic: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub session_id: String,
    /// "in", "out" or "system".
    pub direction: String,
    pub data: String,
    /// Event name / topic, when the protocol carries one.
    pub label: Option<String>,
    pub at_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub session_id: String,
    /// "connecting", "open", "closed" or "error".
    pub state: String,
    pub detail: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_event(app: &AppHandle, session_id: &str, direction: &str, data: String, label: Option<String>) {
    let _ = app.emit(
        "stream://event",
        StreamEvent {
            session_id: session_id.to_string(),
            direction: direction.to_string(),
            data,
            label,
            at_ms: now_ms(),
        },
    );
}

fn emit_status(app: &AppHandle, session_id: &str, state: &str, detail: Option<String>) {
    let _ = app.emit(
        "stream://status",
        StreamStatus {
            session_id: session_id.to_string(),
            state: state.to_string(),
            detail,
        },
    );
}

fn session_id() -> String {
    format!("s{}{}", now_ms(), fastrand_suffix())
}

/// Small non-cryptographic suffix so two sessions opened in the same
/// millisecond still get distinct ids.
fn fastrand_suffix() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

// --- WebSocket-family transports --------------------------------------------

/// Builds a tungstenite request carrying the user's headers (and optionally a
/// subprotocol), which the browser WebSocket API cannot do.
fn ws_request(
    url: &str,
    headers: &[Header],
    protocol: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("invalid WebSocket URL: {e}"))?;
    for header in headers {
        if header.name.trim().is_empty() {
            continue;
        }
        let name = HeaderName::try_from(header.name.as_str())
            .map_err(|e| format!("invalid header {}: {e}", header.name))?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|e| format!("invalid header value for {}: {e}", header.name))?;
        request.headers_mut().insert(name, value);
    }
    if let Some(protocol) = protocol {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(protocol).map_err(|e| e.to_string())?,
        );
    }
    Ok(request)
}

/// Drives a WebSocket connection for the plain, Socket.IO and GraphQL-WS kinds,
/// which differ only in the framing applied to messages.
async fn run_websocket(
    app: AppHandle,
    id: String,
    config: StreamConfig,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
) {
    let flavour = config.kind.as_str();
    let (url, protocol) = match flavour {
        "socketio" => (socketio_url(&config.url), None),
        "graphqlws" => (config.url.clone(), Some("graphql-transport-ws")),
        _ => (config.url.clone(), None),
    };

    let request = match ws_request(&url, &config.headers, protocol) {
        Ok(request) => request,
        Err(e) => {
            emit_status(&app, &id, "error", Some(e));
            return;
        }
    };

    let stream = match tokio_tungstenite::connect_async(request).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            emit_status(&app, &id, "error", Some(format!("connect failed: {e}")));
            return;
        }
    };

    emit_status(&app, &id, "open", None);
    let (mut write, mut read) = stream.split();

    // GraphQL-WS opens with a handshake before any subscription is sent.
    if flavour == "graphqlws" {
        let init = r#"{"type":"connection_init","payload":{}}"#.to_string();
        if write.send(Message::Text(init.clone())).await.is_err() {
            emit_status(&app, &id, "error", Some("failed to send connection_init".into()));
            return;
        }
        emit_event(&app, &id, "out", init, Some("connection_init".into()));
    }

    loop {
        tokio::select! {
            incoming = read.next() => {
                let Some(message) = incoming else { break };
                match message {
                    Ok(Message::Text(text)) => {
                        match flavour {
                            "socketio" => {
                                if let Some(reply) = handle_socketio(&app, &id, &text) {
                                    let _ = write.send(Message::Text(reply)).await;
                                }
                            }
                            "graphqlws" => {
                                if let Some(reply) = handle_graphqlws(&app, &id, &text, &config) {
                                    let _ = write.send(Message::Text(reply.clone())).await;
                                    emit_event(&app, &id, "out", reply, Some("subscribe".into()));
                                }
                            }
                            _ => emit_event(&app, &id, "in", text, None),
                        }
                    }
                    Ok(Message::Binary(bytes)) => {
                        emit_event(&app, &id, "in", format!("<{} bytes binary>", bytes.len()), None);
                    }
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                    Ok(Message::Close(frame)) => {
                        let detail = frame.map(|f| format!("{} {}", f.code, f.reason));
                        emit_status(&app, &id, "closed", detail);
                        break;
                    }
                    Err(e) => {
                        emit_status(&app, &id, "error", Some(e.to_string()));
                        break;
                    }
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Outbound::Send { text, .. }) => {
                        let framed = match flavour {
                            "socketio" => socketio_frame(&text),
                            _ => text.clone(),
                        };
                        if write.send(Message::Text(framed.clone())).await.is_err() {
                            emit_status(&app, &id, "error", Some("send failed".into()));
                            break;
                        }
                        emit_event(&app, &id, "out", framed, None);
                    }
                    Some(Outbound::Close) | None => {
                        let _ = write.send(Message::Close(None)).await;
                        emit_status(&app, &id, "closed", Some("closed by client".into()));
                        break;
                    }
                }
            }
        }
    }

    emit_status(&app, &id, "closed", None);
}

/// Socket.IO rides on Engine.IO: the handshake path and query are fixed.
fn socketio_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    let ws = if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        trimmed.to_string()
    };
    if ws.contains("/socket.io/") {
        ws
    } else {
        format!("{ws}/socket.io/?EIO=4&transport=websocket")
    }
}

/// Handles Engine.IO/Socket.IO control frames, returning any reply to send.
/// Frame prefixes: 0 open, 2 ping, 3 pong, 40 connect, 42 event.
fn handle_socketio(app: &AppHandle, id: &str, text: &str) -> Option<String> {
    if let Some(rest) = text.strip_prefix('0') {
        emit_event(app, id, "system", format!("handshake {rest}"), Some("open".into()));
        return Some("40".to_string());
    }
    if text == "2" {
        return Some("3".to_string());
    }
    if text.starts_with("40") {
        emit_status(app, id, "open", Some("socket.io connected".into()));
        return None;
    }
    if let Some(payload) = text.strip_prefix("42") {
        // `["event", data]` — surface the event name separately.
        let label = serde_json::from_str::<serde_json::Value>(payload)
            .ok()
            .and_then(|value| value.get(0)?.as_str().map(str::to_string));
        emit_event(app, id, "in", payload.to_string(), label);
        return None;
    }
    emit_event(app, id, "in", text.to_string(), None);
    None
}

/// Accepts either a raw Socket.IO frame or `{"event":…,"data":…}` shorthand.
fn socketio_frame(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with("42") || trimmed.starts_with('4') && trimmed.len() > 2 {
        return trimmed.to_string();
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(event) = value.get("event").and_then(|v| v.as_str()) {
            let data = value.get("data").cloned().unwrap_or(serde_json::Value::Null);
            return format!("42{}", serde_json::json!([event, data]));
        }
    }
    format!("42{}", serde_json::json!(["message", trimmed]))
}

/// Replies to the GraphQL-WS handshake with the configured subscription.
fn handle_graphqlws(
    app: &AppHandle,
    id: &str,
    text: &str,
    config: &StreamConfig,
) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    match value.get("type").and_then(|v| v.as_str()) {
        Some("connection_ack") => {
            emit_event(app, id, "system", "connection_ack".into(), None);
            let variables: serde_json::Value = serde_json::from_str(&config.variables)
                .unwrap_or(serde_json::Value::Object(Default::default()));
            Some(
                serde_json::json!({
                    "id": "1",
                    "type": "subscribe",
                    "payload": { "query": config.query, "variables": variables }
                })
                .to_string(),
            )
        }
        Some("ping") => Some(r#"{"type":"pong"}"#.to_string()),
        Some("next") => {
            let payload = value.get("payload").cloned().unwrap_or_default();
            emit_event(app, id, "in", payload.to_string(), Some("next".into()));
            None
        }
        Some("error") => {
            emit_event(app, id, "in", text.to_string(), Some("error".into()));
            None
        }
        Some("complete") => {
            emit_status(app, id, "closed", Some("subscription complete".into()));
            None
        }
        _ => {
            emit_event(app, id, "in", text.to_string(), None);
            None
        }
    }
}

// --- Server-Sent Events ------------------------------------------------------

async fn run_sse(
    app: AppHandle,
    id: String,
    config: StreamConfig,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
) {
    let client = reqwest::Client::new();
    let mut request = client.get(&config.url).header("Accept", "text/event-stream");
    for header in &config.headers {
        if !header.name.trim().is_empty() {
            request = request.header(&header.name, &header.value);
        }
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            emit_status(&app, &id, "error", Some(format!("connect failed: {e}")));
            return;
        }
    };

    if !response.status().is_success() {
        emit_status(
            &app,
            &id,
            "error",
            Some(format!("server returned {}", response.status())),
        );
        return;
    }
    emit_status(&app, &id, "open", None);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        // Events are separated by a blank line.
                        while let Some(split) = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n")) {
                            let raw = buffer[..split].to_string();
                            let skip = if buffer[split..].starts_with("\r\n\r\n") { 4 } else { 2 };
                            buffer = buffer[split + skip..].to_string();
                            let (name, data) = parse_sse_event(&raw);
                            if !data.is_empty() {
                                emit_event(&app, &id, "in", data, name);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        emit_status(&app, &id, "error", Some(e.to_string()));
                        break;
                    }
                    None => {
                        emit_status(&app, &id, "closed", Some("stream ended".into()));
                        break;
                    }
                }
            }
            outbound = rx.recv() => {
                // SSE is receive-only; anything inbound means "disconnect".
                match outbound {
                    Some(Outbound::Close) | None => {
                        emit_status(&app, &id, "closed", Some("closed by client".into()));
                        break;
                    }
                    Some(Outbound::Send { .. }) => {
                        emit_event(&app, &id, "system", "SSE is receive-only".into(), None);
                    }
                }
            }
        }
    }
}

fn parse_sse_event(raw: &str) -> (Option<String>, String) {
    let mut name = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    (name, data_lines.join("\n"))
}

// --- MQTT --------------------------------------------------------------------

async fn run_mqtt(
    app: AppHandle,
    id: String,
    config: StreamConfig,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
) {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};

    let parsed = match url::Url::parse(&config.url) {
        Ok(parsed) => parsed,
        Err(e) => {
            emit_status(&app, &id, "error", Some(format!("invalid MQTT URL: {e}")));
            return;
        }
    };
    let host = parsed.host_str().unwrap_or("localhost").to_string();
    let port = parsed.port().unwrap_or(1883);
    let client_id = config
        .client_id
        .clone()
        .unwrap_or_else(|| format!("webrequestkit-{}", fastrand_suffix()));

    let mut options = MqttOptions::new(client_id, host, port);
    options.set_keep_alive(Duration::from_secs(30));
    if let (Some(user), Some(pass)) = (&config.username, &config.password) {
        if !user.is_empty() {
            options.set_credentials(user.clone(), pass.clone());
        }
    }

    let qos = match config.qos.unwrap_or(0) {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    };

    let (client, mut eventloop) = AsyncClient::new(options, 32);
    for topic in &config.topics {
        if !topic.trim().is_empty() {
            if let Err(e) = client.subscribe(topic.clone(), qos).await {
                emit_status(&app, &id, "error", Some(format!("subscribe failed: {e}")));
            }
        }
    }

    loop {
        tokio::select! {
            event = eventloop.poll() => {
                match event {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        emit_status(&app, &id, "open", None);
                    }
                    Ok(Event::Incoming(Packet::Publish(publish))) => {
                        let payload = String::from_utf8_lossy(&publish.payload).to_string();
                        emit_event(&app, &id, "in", payload, Some(publish.topic));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        emit_status(&app, &id, "error", Some(e.to_string()));
                        break;
                    }
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Outbound::Send { text, topic }) => {
                        let topic = topic.unwrap_or_default();
                        if topic.trim().is_empty() {
                            emit_event(&app, &id, "system", "a publish topic is required".into(), None);
                        } else if let Err(e) = client.publish(topic.clone(), qos, false, text.clone().into_bytes()).await {
                            emit_event(&app, &id, "system", format!("publish failed: {e}"), None);
                        } else {
                            emit_event(&app, &id, "out", text, Some(topic));
                        }
                    }
                    Some(Outbound::Close) | None => {
                        let _ = client.disconnect().await;
                        emit_status(&app, &id, "closed", Some("closed by client".into()));
                        break;
                    }
                }
            }
        }
    }
}

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn stream_connect(
    app: AppHandle,
    state: State<StreamState>,
    config: StreamConfig,
) -> Result<String, String> {
    let id = session_id();
    let (tx, rx) = mpsc::unbounded_channel();
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), tx);

    emit_status(&app, &id, "connecting", None);

    let task_id = id.clone();
    match config.kind.as_str() {
        "websocket" | "socketio" | "graphqlws" => {
            tokio::spawn(run_websocket(app, task_id, config, rx));
        }
        "sse" => {
            tokio::spawn(run_sse(app, task_id, config, rx));
        }
        "mqtt" => {
            tokio::spawn(run_mqtt(app, task_id, config, rx));
        }
        other => {
            return Err(format!("unsupported protocol: {other}"));
        }
    }

    Ok(id)
}

#[tauri::command]
pub fn stream_send(
    state: State<StreamState>,
    session_id: String,
    message: OutboundMessage,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let tx = sessions
        .get(&session_id)
        .ok_or_else(|| "session is not connected".to_string())?;
    tx.send(Outbound::Send {
        text: message.text,
        topic: message.topic,
    })
    .map_err(|_| "session has closed".to_string())
}

#[tauri::command]
pub fn stream_disconnect(state: State<StreamState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = sessions.remove(&session_id) {
        let _ = tx.send(Outbound::Close);
    }
    Ok(())
}
