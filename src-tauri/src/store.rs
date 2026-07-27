//! SQLite-backed storage: workspaces, and per-workspace collection trees,
//! environments, open tabs, mock routes and UI settings.
//!
//! Folders and requests are stored relationally (a `parent_id` edge plus a
//! sibling `position`) rather than as one JSON blob, so nesting, ordering and
//! cascading deletes are enforced by the database itself. Saves rewrite one
//! workspace's rows inside a transaction — collections are small, and it keeps
//! the frontend free to hand back the entire tree after any edit.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub struct Db(pub Mutex<Connection>);

/// Scope used by [`set_setting`] for values that are not workspace-specific.
pub const GLOBAL_SCOPE: &str = "global";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeNode {
    #[serde(rename_all = "camelCase")]
    Folder {
        id: String,
        name: String,
        children: Vec<TreeNode>,
    },
    #[serde(rename_all = "camelCase")]
    Request {
        id: String,
        name: String,
        method: String,
        url: String,
        headers: Vec<Header>,
        body: String,
        /// Assertions are opaque to the backend — stored as JSON, evaluated in
        /// the UI where the response already lives.
        #[serde(default)]
        tests: serde_json::Value,
        /// Builder state (body mode, auth, …), likewise opaque JSON.
        #[serde(default)]
        config: serde_json::Value,
    },
}

fn json_text(value: &serde_json::Value, fallback: &str) -> String {
    if value.is_null() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn parse_json(raw: &str, fallback: serde_json::Value) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn empty_array() -> serde_json::Value {
    serde_json::Value::Array(vec![])
}

fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub variables: Vec<Header>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredTab {
    pub id: String,
    pub name: Option<String>,
    pub source_id: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: String,
    pub req_tab: String,
    #[serde(default)]
    pub tests: serde_json::Value,
    #[serde(default)]
    pub config: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MockRoute {
    pub id: String,
    pub enabled: bool,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub headers: Vec<Header>,
    pub body: String,
    pub delay_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    /// "request", "folder", "collection" or "url" (an ad-hoc endpoint).
    pub target_kind: String,
    pub target_id: Option<String>,
    pub interval_secs: u64,
    pub enabled: bool,
    /// Environment to run against; `None` uses whichever is active.
    pub environment_id: Option<String>,
    pub notify: bool,
    // Used when `target_kind` is "url": the endpoint to check directly.
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub expected_status: u16,
}

/// One sent request. History is per machine — it records what *you* did, so it
/// is deliberately not part of sync.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub at_ms: i64,
    pub name: String,
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
    #[serde(default)]
    pub status_text: String,
    pub time_ms: i64,
    pub size_bytes: i64,
    /// The request as sent, so it can be reopened or saved to the collection.
    pub request: serde_json::Value,
    pub error: Option<String>,
}

/// A note on a request. `parent_id` makes it a reply, so threads are one deep
/// plus replies — enough for review conversations without a tree UI.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub request_id: String,
    pub parent_id: Option<String>,
    pub author: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRun {
    pub id: String,
    pub monitor_id: String,
    pub at_ms: i64,
    pub ok: bool,
    pub requests: i64,
    pub failures: i64,
    pub avg_ms: f64,
    pub detail: String,
}

/// Everything one workspace needs on load.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    pub tree: Vec<TreeNode>,
    pub environments: Vec<Environment>,
    pub tabs: Vec<StoredTab>,
    pub mock_routes: Vec<MockRoute>,
    pub monitors: Vec<Monitor>,
    pub comments: Vec<Comment>,
    /// Recent monitor history, newest first, across all monitors.
    pub monitor_runs: Vec<MonitorRun>,
    /// Workspace-scoped settings merged over global ones.
    pub settings: HashMap<String, String>,
}

pub(crate) const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_id    TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    deleted      INTEGER NOT NULL DEFAULT 0,
    sig          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS requests (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    folder_id    TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    headers      TEXT NOT NULL,
    body         TEXT NOT NULL,
    tests        TEXT NOT NULL DEFAULT '[]',
    config       TEXT NOT NULL DEFAULT '{}',
    position     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    deleted      INTEGER NOT NULL DEFAULT 0,
    sig          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS environments (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name         TEXT NOT NULL,
    variables    TEXT NOT NULL,
    position     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    deleted      INTEGER NOT NULL DEFAULT 0,
    sig          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tabs (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name         TEXT,
    source_id    TEXT,
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    headers      TEXT NOT NULL,
    body         TEXT NOT NULL,
    req_tab      TEXT NOT NULL,
    tests        TEXT NOT NULL DEFAULT '[]',
    config       TEXT NOT NULL DEFAULT '{}',
    position     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_routes (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    enabled      INTEGER NOT NULL,
    method       TEXT NOT NULL,
    path         TEXT NOT NULL,
    status       INTEGER NOT NULL,
    headers      TEXT NOT NULL,
    body         TEXT NOT NULL,
    delay_ms     INTEGER NOT NULL,
    position     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    deleted      INTEGER NOT NULL DEFAULT 0,
    sig          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS monitors (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL,
    name           TEXT NOT NULL,
    target_kind    TEXT NOT NULL,
    target_id      TEXT,
    interval_secs  INTEGER NOT NULL,
    enabled        INTEGER NOT NULL,
    environment_id TEXT,
    notify         INTEGER NOT NULL,
    method         TEXT NOT NULL DEFAULT 'GET',
    url            TEXT NOT NULL DEFAULT '',
    headers        TEXT NOT NULL DEFAULT '[]',
    body           TEXT NOT NULL DEFAULT '',
    expected_status INTEGER NOT NULL DEFAULT 200,
    position       INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL DEFAULT 0,
    deleted        INTEGER NOT NULL DEFAULT 0,
    sig            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS monitor_runs (
    id         TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    at_ms      INTEGER NOT NULL,
    ok         INTEGER NOT NULL,
    requests   INTEGER NOT NULL,
    failures   INTEGER NOT NULL,
    avg_ms     REAL NOT NULL,
    detail     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    request_id   TEXT NOT NULL,
    parent_id    TEXT,
    author       TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    deleted      INTEGER NOT NULL DEFAULT 0,
    sig          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS history (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    at_ms        INTEGER NOT NULL,
    name         TEXT NOT NULL,
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    status       INTEGER,
    status_text  TEXT NOT NULL DEFAULT '',
    time_ms      INTEGER NOT NULL DEFAULT 0,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    request      TEXT NOT NULL,
    error        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);

"#;

/// Indexes are created after [`migrate`], because a database written by an
/// older build may still be missing the columns they cover.
pub(crate) const INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_folders_parent    ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_ws        ON folders(workspace_id);
CREATE INDEX IF NOT EXISTS idx_requests_folder   ON requests(folder_id);
CREATE INDEX IF NOT EXISTS idx_requests_ws       ON requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_environments_ws   ON environments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tabs_ws           ON tabs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_mock_routes_ws    ON mock_routes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_monitors_ws       ON monitors(workspace_id);
CREATE INDEX IF NOT EXISTS idx_monitor_runs_id   ON monitor_runs(monitor_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_comments_ws       ON comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_comments_request  ON comments(request_id);
CREATE INDEX IF NOT EXISTS idx_history_ws        ON history(workspace_id, at_ms DESC);
"#;

const DEFAULT_WORKSPACE_NAME: &str = "My Workspace";

/// Identifiers this app has shipped under. The data directory is derived from
/// the bundle identifier, so renaming the product moves it — anything found
/// under a previous name is adopted on first run rather than left behind.
const LEGACY_IDENTIFIERS: &[&str] = &["com.sandeep.webrequestkit"];

/// Copies a previous installation's files across, once, if this one is empty.
fn adopt_legacy_data(dir: &std::path::Path) -> Result<Option<String>, String> {
    if dir.join("workspace.db").exists() {
        return Ok(None);
    }
    let Some(parent) = dir.parent() else {
        return Ok(None);
    };

    for identifier in LEGACY_IDENTIFIERS {
        let legacy = parent.join(identifier);
        if !legacy.join("workspace.db").exists() {
            continue;
        }
        // Everything in the directory matters: the database, and the proxy's
        // CA key and certificate.
        let entries =
            std::fs::read_dir(&legacy).map_err(|e| format!("read {identifier}: {e}"))?;
        for entry in entries.flatten() {
            if entry.path().is_file() {
                let destination = dir.join(entry.file_name());
                std::fs::copy(entry.path(), &destination)
                    .map_err(|e| format!("copy {:?}: {e}", entry.file_name()))?;
            }
        }
        return Ok(Some((*identifier).to_string()));
    }
    Ok(None)
}

/// Opens (creating if needed) the workspace database in the app data dir.
pub fn init(app: &AppHandle) -> Result<Db, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;

    if let Some(adopted) = adopt_legacy_data(&dir)? {
        // The old directory is left untouched, so a downgrade still works.
        eprintln!("apikit: adopted workspace data from {adopted}");
    }

    let conn = Connection::open(dir.join("workspace.db"))
        .map_err(|e| format!("open workspace database: {e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("initialize schema: {e}"))?;
    migrate(&conn)?;
    conn.execute_batch(INDEXES)
        .map_err(|e| format!("create indexes: {e}"))?;
    ensure_default_workspace(&conn)?;

    Ok(Db(Mutex::new(conn)))
}

/// Brings databases created before a column existed up to the current shape.
/// `ALTER TABLE ... ADD COLUMN` errors when the column is already there, which
/// is the normal case and is ignored.
fn migrate(conn: &Connection) -> Result<(), String> {
    let additions = [
        "ALTER TABLE folders ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE requests ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE requests ADD COLUMN tests TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE requests ADD COLUMN config TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE environments ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tabs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tabs ADD COLUMN tests TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE tabs ADD COLUMN config TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE mock_routes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE monitors ADD COLUMN method TEXT NOT NULL DEFAULT 'GET'",
        "ALTER TABLE monitors ADD COLUMN url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE monitors ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE monitors ADD COLUMN body TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE monitors ADD COLUMN expected_status INTEGER NOT NULL DEFAULT 200",
        // Sync bookkeeping: when a row last changed, whether it is a tombstone,
        // and a signature so a re-save that changed nothing keeps its timestamp.
        "ALTER TABLE workspaces ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE workspaces ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN sig TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE requests ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE requests ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE requests ADD COLUMN sig TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE environments ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE environments ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE environments ADD COLUMN sig TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE mock_routes ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE mock_routes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE mock_routes ADD COLUMN sig TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE monitors ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE monitors ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE monitors ADD COLUMN sig TEXT NOT NULL DEFAULT ''",
    ];
    for statement in additions {
        let _ = conn.execute(statement, []);
    }

    stamp_unversioned_rows(conn)?;

    // `settings` gained a `scope` column, which needs a table rebuild rather
    // than an ALTER because the primary key changed.
    let scoped = conn.prepare("SELECT scope FROM settings LIMIT 1").is_ok();
    if !scoped {
        conn.execute_batch(
            r#"
            ALTER TABLE settings RENAME TO settings_legacy;
            CREATE TABLE settings (
                scope TEXT NOT NULL,
                key   TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (scope, key)
            );
            INSERT INTO settings (scope, key, value)
                SELECT 'global', key, value FROM settings_legacy;
            DROP TABLE settings_legacy;
            "#,
        )
        .map_err(|e| format!("migrate settings table: {e}"))?;
    }

    Ok(())
}

/// Tables that take part in sync, in dependency order.
const VERSIONED_TABLES: &[&str] = &[
    "workspaces",
    "folders",
    "requests",
    "environments",
    "mock_routes",
    "monitors",
    "comments",
];

/// Gives a real timestamp to rows that predate sync bookkeeping.
///
/// The migration added `updated_at` with `DEFAULT 0`, and [`snapshot`] only
/// sends rows *newer* than the caller's watermark — a first sync asks for
/// everything after 0, so rows still sitting at 0 would never be sent. Left
/// alone they are invisible to every peer, forever.
pub(crate) fn stamp_unversioned_rows(conn: &Connection) -> Result<usize, String> {
    let now = now_ms();
    let mut stamped = 0;
    for table in VERSIONED_TABLES {
        // Tables missing on an old database simply report an error we ignore.
        if let Ok(count) = conn.execute(
            &format!("UPDATE {table} SET updated_at = ?1 WHERE updated_at = 0"),
            params![now],
        ) {
            stamped += count;
        }
    }
    Ok(stamped)
}

fn ensure_default_workspace(conn: &Connection) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces WHERE deleted = 0 ORDER BY position LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }

    let id = uuid(conn)?;
    conn.execute(
        "INSERT INTO workspaces (id, name, position, updated_at) VALUES (?1, ?2, 0, ?3)",
        params![id, DEFAULT_WORKSPACE_NAME, now_ms()],
    )
    .map_err(to_err)?;

    // Adopt any rows written before workspaces existed.
    for table in ["folders", "requests", "environments", "tabs", "mock_routes"] {
        let _ = conn.execute(
            &format!("UPDATE {table} SET workspace_id = ?1 WHERE workspace_id = ''"),
            params![id],
        );
    }

    Ok(id)
}

/// A v4-shaped id built from SQLite's own randomness, so no extra crate is
/// needed just to name a workspace.
fn uuid(conn: &Connection) -> Result<String, String> {
    conn.query_row(
        "SELECT lower(
            hex(randomblob(4)) || '-' ||
            hex(randomblob(2)) || '-4' ||
            substr(hex(randomblob(2)), 2) || '-' ||
            substr('89ab', abs(random()) % 4 + 1, 1) ||
            substr(hex(randomblob(2)), 2) || '-' ||
            hex(randomblob(6))
        )",
        [],
        |row| row.get(0),
    )
    .map_err(to_err)
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Content signature for a row, so re-saving unchanged data does not bump its
/// `updated_at` and start a sync loop.
fn sig_of(parts: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

/// Reads `(updated_at, sig)` for every live row of a table in one workspace.
fn existing_rows(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, sig FROM {table} WHERE workspace_id = ?1 AND deleted = 0"
        ))
        .map_err(to_err)?;
    let rows = stmt
        .query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_err)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(to_err)?;
    Ok(rows)
}

/// Tombstones every id in `table` that the caller did not send back.
fn tombstone_missing(
    tx: &rusqlite::Transaction,
    table: &str,
    workspace_id: &str,
    kept: &std::collections::HashSet<String>,
    now: i64,
) -> Result<(), String> {
    let mut stmt = tx
        .prepare(&format!(
            "SELECT id FROM {table} WHERE workspace_id = ?1 AND deleted = 0"
        ))
        .map_err(to_err)?;
    let ids: Vec<String> = stmt
        .query_map(params![workspace_id], |row| row.get::<_, String>(0))
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;
    drop(stmt);

    for id in ids {
        if !kept.contains(&id) {
            tx.execute(
                &format!("UPDATE {table} SET deleted = 1, updated_at = ?2 WHERE id = ?1"),
                params![id, now],
            )
            .map_err(to_err)?;
        }
    }
    Ok(())
}

// --- Workspaces --------------------------------------------------------------

#[tauri::command]
pub fn list_workspaces(db: State<Db>) -> Result<Vec<WorkspaceMeta>, String> {
    let conn = db.0.lock().map_err(to_err)?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM workspaces WHERE deleted = 0 ORDER BY position")
        .map_err(to_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WorkspaceMeta {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;
    Ok(rows)
}

/// Workspace list for a peer that is choosing what to pair with.
pub fn workspace_list(conn: &Connection) -> Result<Vec<WorkspaceMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM workspaces WHERE deleted = 0 ORDER BY position")
        .map_err(to_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WorkspaceMeta {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;
    Ok(rows)
}

pub fn workspace_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1 AND deleted = 0",
            params![id],
            |row| row.get(0),
        )
        .map_err(to_err)?;
    Ok(count > 0)
}

#[tauri::command]
pub fn create_workspace(db: State<Db>, name: String) -> Result<WorkspaceMeta, String> {
    let conn = db.0.lock().map_err(to_err)?;
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM workspaces",
            [],
            |row| row.get(0),
        )
        .map_err(to_err)?;
    let id = uuid(&conn)?;
    conn.execute(
        "INSERT INTO workspaces (id, name, position, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, next, now_ms()],
    )
    .map_err(to_err)?;
    Ok(WorkspaceMeta { id, name })
}

#[tauri::command]
pub fn rename_workspace(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now_ms()],
    )
    .map_err(to_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_workspace(db: State<Db>, id: String) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces WHERE deleted = 0", [], |row| {
            row.get(0)
        })
        .map_err(to_err)?;
    if count <= 1 {
        return Err("the last workspace cannot be deleted".into());
    }

    let now = now_ms();
    let tx = conn.transaction().map_err(to_err)?;
    // Content is tombstoned rather than dropped so peers learn about the
    // deletion; per-machine state (tabs, settings) is simply removed.
    for table in ["requests", "folders", "environments", "mock_routes", "monitors"] {
        tx.execute(
            &format!(
                "UPDATE {table} SET deleted = 1, updated_at = ?2 WHERE workspace_id = ?1"
            ),
            params![id, now],
        )
        .map_err(to_err)?;
    }
    for table in ["tabs", "settings"] {
        let column = if table == "settings" { "scope" } else { "workspace_id" };
        tx.execute(&format!("DELETE FROM {table} WHERE {column} = ?1"), params![id])
            .map_err(to_err)?;
    }
    tx.execute(
        "UPDATE workspaces SET deleted = 1, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(to_err)?;
    tx.commit().map_err(to_err)
}

// --- Collection tree ---------------------------------------------------------

/// A row from either child table, keyed by parent so the tree can be rebuilt.
enum Stub {
    Folder { id: String, name: String },
    Request(TreeNode),
}

pub(crate) fn read_tree(conn: &Connection, workspace_id: &str) -> Result<Vec<TreeNode>, String> {
    let mut children: HashMap<Option<String>, Vec<(i64, Stub)>> = HashMap::new();

    let mut folders = conn
        .prepare(
            "SELECT id, parent_id, name, position FROM folders
             WHERE workspace_id = ?1 AND deleted = 0",
        )
        .map_err(to_err)?;
    let rows = folders
        .query_map(params![workspace_id], |row| {
            Ok((
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(3)?,
                Stub::Folder {
                    id: row.get(0)?,
                    name: row.get(2)?,
                },
            ))
        })
        .map_err(to_err)?;
    for row in rows {
        let (parent, position, stub) = row.map_err(to_err)?;
        children.entry(parent).or_default().push((position, stub));
    }

    let mut requests = conn
        .prepare(
            "SELECT id, folder_id, name, method, url, headers, body, tests, config, position
             FROM requests WHERE workspace_id = ?1 AND deleted = 0",
        )
        .map_err(to_err)?;
    let rows = requests
        .query_map(params![workspace_id], |row| {
            let headers_json: String = row.get(5)?;
            let tests_raw: String = row.get(7)?;
            let config_raw: String = row.get(8)?;
            Ok((
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(9)?,
                TreeNode::Request {
                    id: row.get(0)?,
                    name: row.get(2)?,
                    method: row.get(3)?,
                    url: row.get(4)?,
                    headers: serde_json::from_str(&headers_json).unwrap_or_default(),
                    body: row.get(6)?,
                    tests: parse_json(&tests_raw, empty_array()),
                    config: parse_json(&config_raw, empty_object()),
                },
            ))
        })
        .map_err(to_err)?;
    for row in rows {
        let (parent, position, node) = row.map_err(to_err)?;
        children
            .entry(parent)
            .or_default()
            .push((position, Stub::Request(node)));
    }

    Ok(build_level(&mut children, None))
}

fn build_level(
    children: &mut HashMap<Option<String>, Vec<(i64, Stub)>>,
    parent: Option<String>,
) -> Vec<TreeNode> {
    let mut level = match children.remove(&parent) {
        Some(level) => level,
        None => return Vec::new(),
    };
    level.sort_by_key(|(position, _)| *position);

    level
        .into_iter()
        .map(|(_, stub)| match stub {
            Stub::Request(node) => node,
            Stub::Folder { id, name } => {
                let nested = build_level(children, Some(id.clone()));
                TreeNode::Folder {
                    id,
                    name,
                    children: nested,
                }
            }
        })
        .collect()
}

/// Tracks what a tree save touched so unseen rows can be tombstoned.
struct TreeWrite<'a> {
    now: i64,
    folders: &'a HashMap<String, String>,
    requests: &'a HashMap<String, String>,
    kept_folders: std::collections::HashSet<String>,
    kept_requests: std::collections::HashSet<String>,
}

fn write_level(
    tx: &rusqlite::Transaction,
    workspace_id: &str,
    nodes: &[TreeNode],
    parent: Option<&str>,
    ctx: &mut TreeWrite,
) -> Result<(), String> {
    for (position, node) in nodes.iter().enumerate() {
        let position = position as i64;
        match node {
            TreeNode::Folder { id, name, children } => {
                ctx.kept_folders.insert(id.clone());
                let sig = sig_of(&[parent.unwrap_or(""), name, &position.to_string()]);
                // An unchanged row keeps its timestamp, so a save that touched
                // one request does not look like a change to everything.
                if ctx.folders.get(id) != Some(&sig) {
                    tx.execute(
                        "INSERT INTO folders
                           (id, workspace_id, parent_id, name, position, updated_at, deleted, sig)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
                         ON CONFLICT(id) DO UPDATE SET
                           workspace_id = excluded.workspace_id,
                           parent_id    = excluded.parent_id,
                           name         = excluded.name,
                           position     = excluded.position,
                           updated_at   = excluded.updated_at,
                           deleted      = 0,
                           sig          = excluded.sig",
                        params![id, workspace_id, parent, name, position, ctx.now, sig],
                    )
                    .map_err(to_err)?;
                }
                write_level(tx, workspace_id, children, Some(id), ctx)?;
            }
            TreeNode::Request {
                id,
                name,
                method,
                url,
                headers,
                body,
                tests,
                config,
            } => {
                ctx.kept_requests.insert(id.clone());
                let headers_json = serde_json::to_string(headers).map_err(to_err)?;
                let tests_json = json_text(tests, "[]");
                let config_json = json_text(config, "{}");
                let sig = sig_of(&[
                    parent.unwrap_or(""),
                    name,
                    method,
                    url,
                    &headers_json,
                    body,
                    &tests_json,
                    &config_json,
                    &position.to_string(),
                ]);
                if ctx.requests.get(id) != Some(&sig) {
                    tx.execute(
                        "INSERT INTO requests
                           (id, workspace_id, folder_id, name, method, url, headers, body,
                            tests, config, position, updated_at, deleted, sig)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)
                         ON CONFLICT(id) DO UPDATE SET
                           workspace_id = excluded.workspace_id,
                           folder_id    = excluded.folder_id,
                           name         = excluded.name,
                           method       = excluded.method,
                           url          = excluded.url,
                           headers      = excluded.headers,
                           body         = excluded.body,
                           tests        = excluded.tests,
                           config       = excluded.config,
                           position     = excluded.position,
                           updated_at   = excluded.updated_at,
                           deleted      = 0,
                           sig          = excluded.sig",
                        params![
                            id,
                            workspace_id,
                            parent,
                            name,
                            method,
                            url,
                            headers_json,
                            body,
                            tests_json,
                            config_json,
                            position,
                            ctx.now,
                            sig
                        ],
                    )
                    .map_err(to_err)?;
                }
            }
        }
    }
    Ok(())
}

// --- Load / save -------------------------------------------------------------

#[tauri::command]
pub fn load_workspace_data(db: State<Db>, workspace_id: String) -> Result<WorkspaceData, String> {
    let conn = db.0.lock().map_err(to_err)?;

    let tree = read_tree(&conn, &workspace_id)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, variables FROM environments
             WHERE workspace_id = ?1 AND deleted = 0 ORDER BY position",
        )
        .map_err(to_err)?;
    let environments = stmt
        .query_map(params![workspace_id], |row| {
            let variables: String = row.get(2)?;
            Ok(Environment {
                id: row.get(0)?,
                name: row.get(1)?,
                variables: serde_json::from_str(&variables).unwrap_or_default(),
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, source_id, method, url, headers, body, req_tab, tests, config
             FROM tabs WHERE workspace_id = ?1 ORDER BY position",
        )
        .map_err(to_err)?;
    let tabs = stmt
        .query_map(params![workspace_id], |row| {
            let headers: String = row.get(5)?;
            let tests_raw: String = row.get(8)?;
            let config_raw: String = row.get(9)?;
            Ok(StoredTab {
                id: row.get(0)?,
                name: row.get(1)?,
                source_id: row.get(2)?,
                method: row.get(3)?,
                url: row.get(4)?,
                headers: serde_json::from_str(&headers).unwrap_or_default(),
                body: row.get(6)?,
                req_tab: row.get(7)?,
                tests: parse_json(&tests_raw, empty_array()),
                config: parse_json(&config_raw, empty_object()),
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;

    let mock_routes = read_mock_routes(&conn, &workspace_id)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, request_id, parent_id, author, body, created_at
             FROM comments WHERE workspace_id = ?1 AND deleted = 0
             ORDER BY created_at",
        )
        .map_err(to_err)?;
    let comments = stmt
        .query_map(params![workspace_id], |row| {
            Ok(Comment {
                id: row.get(0)?,
                request_id: row.get(1)?,
                parent_id: row.get(2)?,
                author: row.get(3)?,
                body: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, target_kind, target_id, interval_secs, enabled, environment_id,
                    notify, method, url, headers, body, expected_status
             FROM monitors WHERE workspace_id = ?1 AND deleted = 0 ORDER BY position",
        )
        .map_err(to_err)?;
    let monitors = stmt
        .query_map(params![workspace_id], |row| {
            Ok(Monitor {
                id: row.get(0)?,
                name: row.get(1)?,
                target_kind: row.get(2)?,
                target_id: row.get(3)?,
                interval_secs: row.get::<_, i64>(4)? as u64,
                enabled: row.get::<_, i64>(5)? != 0,
                environment_id: row.get(6)?,
                notify: row.get::<_, i64>(7)? != 0,
                method: row.get(8)?,
                url: row.get(9)?,
                headers: serde_json::from_str(&row.get::<_, String>(10)?)
                    .unwrap_or_default(),
                body: row.get(11)?,
                expected_status: row.get::<_, i64>(12)? as u16,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;

    // History is scoped by joining through the workspace's monitors.
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.monitor_id, r.at_ms, r.ok, r.requests, r.failures, r.avg_ms, r.detail
             FROM monitor_runs r
             JOIN monitors m ON m.id = r.monitor_id
             WHERE m.workspace_id = ?1
             ORDER BY r.at_ms DESC
             LIMIT 500",
        )
        .map_err(to_err)?;
    let monitor_runs = stmt
        .query_map(params![workspace_id], |row| {
            Ok(MonitorRun {
                id: row.get(0)?,
                monitor_id: row.get(1)?,
                at_ms: row.get(2)?,
                ok: row.get::<_, i64>(3)? != 0,
                requests: row.get(4)?,
                failures: row.get(5)?,
                avg_ms: row.get(6)?,
                detail: row.get(7)?,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;

    // Workspace settings win over globals of the same name.
    let mut settings = read_settings(&conn, GLOBAL_SCOPE)?;
    settings.extend(read_settings(&conn, &workspace_id)?);

    Ok(WorkspaceData {
        tree,
        environments,
        tabs,
        mock_routes,
        monitors,
        comments,
        monitor_runs,
        settings,
    })
}

fn read_settings(conn: &Connection, scope: &str) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE scope = ?1")
        .map_err(to_err)?;
    let map = stmt
        .query_map(params![scope], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_err)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(to_err)?;
    Ok(map)
}

#[tauri::command]
pub fn save_tree(
    db: State<Db>,
    workspace_id: String,
    nodes: Vec<TreeNode>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    write_tree(&mut conn, &workspace_id, &nodes)
}

pub fn write_tree(
    conn: &mut Connection,
    workspace_id: &str,
    nodes: &[TreeNode],
) -> Result<(), String> {
    let folders = existing_rows(conn, "folders", workspace_id)?;
    let requests = existing_rows(conn, "requests", workspace_id)?;

    let mut ctx = TreeWrite {
        now: now_ms(),
        folders: &folders,
        requests: &requests,
        kept_folders: std::collections::HashSet::new(),
        kept_requests: std::collections::HashSet::new(),
    };

    let tx = conn.transaction().map_err(to_err)?;
    write_level(&tx, workspace_id, nodes, None, &mut ctx)?;
    // Anything the UI no longer lists was deleted; tombstone it so the change
    // reaches peers instead of silently reappearing on the next sync.
    tombstone_missing(&tx, "folders", workspace_id, &ctx.kept_folders, ctx.now)?;
    tombstone_missing(&tx, "requests", workspace_id, &ctx.kept_requests, ctx.now)?;
    tx.commit().map_err(to_err)
}

#[tauri::command]
pub fn save_environments(
    db: State<Db>,
    workspace_id: String,
    environments: Vec<Environment>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    let existing = existing_rows(&conn, "environments", &workspace_id)?;
    let now = now_ms();
    let mut kept = std::collections::HashSet::new();

    let tx = conn.transaction().map_err(to_err)?;
    for (position, env) in environments.iter().enumerate() {
        kept.insert(env.id.clone());
        let variables = serde_json::to_string(&env.variables).map_err(to_err)?;
        let sig = sig_of(&[&env.name, &variables, &position.to_string()]);
        if existing.get(&env.id) != Some(&sig) {
            tx.execute(
                "INSERT INTO environments
                   (id, workspace_id, name, variables, position, updated_at, deleted, sig)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   name         = excluded.name,
                   variables    = excluded.variables,
                   position     = excluded.position,
                   updated_at   = excluded.updated_at,
                   deleted      = 0,
                   sig          = excluded.sig",
                params![env.id, workspace_id, env.name, variables, position as i64, now, sig],
            )
            .map_err(to_err)?;
        }
    }
    tombstone_missing(&tx, "environments", &workspace_id, &kept, now)?;
    tx.commit().map_err(to_err)
}

#[tauri::command]
pub fn save_tabs(
    db: State<Db>,
    workspace_id: String,
    tabs: Vec<StoredTab>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    let tx = conn.transaction().map_err(to_err)?;
    tx.execute("DELETE FROM tabs WHERE workspace_id = ?1", params![workspace_id])
        .map_err(to_err)?;
    for (position, tab) in tabs.iter().enumerate() {
        tx.execute(
            "INSERT INTO tabs
               (id, workspace_id, name, source_id, method, url, headers, body, req_tab, tests, config, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                tab.id,
                workspace_id,
                tab.name,
                tab.source_id,
                tab.method,
                tab.url,
                serde_json::to_string(&tab.headers).map_err(to_err)?,
                tab.body,
                tab.req_tab,
                json_text(&tab.tests, "[]"),
                json_text(&tab.config, "{}"),
                position as i64
            ],
        )
        .map_err(to_err)?;
    }
    tx.commit().map_err(to_err)
}

pub fn read_mock_routes(conn: &Connection, workspace_id: &str) -> Result<Vec<MockRoute>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, enabled, method, path, status, headers, body, delay_ms
             FROM mock_routes WHERE workspace_id = ?1 AND deleted = 0 ORDER BY position",
        )
        .map_err(to_err)?;
    let routes = stmt
        .query_map(params![workspace_id], |row| {
            let headers: String = row.get(5)?;
            Ok(MockRoute {
                id: row.get(0)?,
                enabled: row.get::<_, i64>(1)? != 0,
                method: row.get(2)?,
                path: row.get(3)?,
                status: row.get::<_, i64>(4)? as u16,
                headers: serde_json::from_str(&headers).unwrap_or_default(),
                body: row.get(6)?,
                delay_ms: row.get::<_, i64>(7)? as u64,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;
    Ok(routes)
}

#[tauri::command]
pub fn save_mock_routes(
    db: State<Db>,
    workspace_id: String,
    routes: Vec<MockRoute>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    let existing = existing_rows(&conn, "mock_routes", &workspace_id)?;
    let now = now_ms();
    let mut kept = std::collections::HashSet::new();

    let tx = conn.transaction().map_err(to_err)?;
    for (position, route) in routes.iter().enumerate() {
        kept.insert(route.id.clone());
        let headers = serde_json::to_string(&route.headers).map_err(to_err)?;
        let sig = sig_of(&[
            &(route.enabled as i64).to_string(),
            &route.method,
            &route.path,
            &route.status.to_string(),
            &headers,
            &route.body,
            &route.delay_ms.to_string(),
            &position.to_string(),
        ]);
        if existing.get(&route.id) != Some(&sig) {
            tx.execute(
                "INSERT INTO mock_routes
                   (id, workspace_id, enabled, method, path, status, headers, body, delay_ms,
                    position, updated_at, deleted, sig)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   enabled      = excluded.enabled,
                   method       = excluded.method,
                   path         = excluded.path,
                   status       = excluded.status,
                   headers      = excluded.headers,
                   body         = excluded.body,
                   delay_ms     = excluded.delay_ms,
                   position     = excluded.position,
                   updated_at   = excluded.updated_at,
                   deleted      = 0,
                   sig          = excluded.sig",
                params![
                    route.id,
                    workspace_id,
                    route.enabled as i64,
                    route.method,
                    route.path,
                    route.status as i64,
                    headers,
                    route.body,
                    route.delay_ms as i64,
                    position as i64,
                    now,
                    sig
                ],
            )
            .map_err(to_err)?;
        }
    }
    tombstone_missing(&tx, "mock_routes", &workspace_id, &kept, now)?;
    tx.commit().map_err(to_err)
}

#[tauri::command]
pub fn save_monitors(
    db: State<Db>,
    workspace_id: String,
    monitors: Vec<Monitor>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    let existing = existing_rows(&conn, "monitors", &workspace_id)?;
    let now = now_ms();
    let mut kept = std::collections::HashSet::new();

    let tx = conn.transaction().map_err(to_err)?;
    for (position, monitor) in monitors.iter().enumerate() {
        kept.insert(monitor.id.clone());
        let headers = serde_json::to_string(&monitor.headers).map_err(to_err)?;
        let sig = sig_of(&[
            &monitor.name,
            &monitor.target_kind,
            monitor.target_id.as_deref().unwrap_or(""),
            &monitor.interval_secs.to_string(),
            &(monitor.enabled as i64).to_string(),
            monitor.environment_id.as_deref().unwrap_or(""),
            &(monitor.notify as i64).to_string(),
            &monitor.method,
            &monitor.url,
            &headers,
            &monitor.body,
            &monitor.expected_status.to_string(),
            &position.to_string(),
        ]);
        if existing.get(&monitor.id) != Some(&sig) {
            tx.execute(
                "INSERT INTO monitors
                   (id, workspace_id, name, target_kind, target_id, interval_secs, enabled,
                    environment_id, notify, method, url, headers, body, expected_status,
                    position, updated_at, deleted, sig)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id    = excluded.workspace_id,
                   name            = excluded.name,
                   target_kind     = excluded.target_kind,
                   target_id       = excluded.target_id,
                   interval_secs   = excluded.interval_secs,
                   enabled         = excluded.enabled,
                   environment_id  = excluded.environment_id,
                   notify          = excluded.notify,
                   method          = excluded.method,
                   url             = excluded.url,
                   headers         = excluded.headers,
                   body            = excluded.body,
                   expected_status = excluded.expected_status,
                   position        = excluded.position,
                   updated_at      = excluded.updated_at,
                   deleted         = 0,
                   sig             = excluded.sig",
                params![
                    monitor.id,
                    workspace_id,
                    monitor.name,
                    monitor.target_kind,
                    monitor.target_id,
                    monitor.interval_secs as i64,
                    monitor.enabled as i64,
                    monitor.environment_id,
                    monitor.notify as i64,
                    monitor.method,
                    monitor.url,
                    headers,
                    monitor.body,
                    monitor.expected_status as i64,
                    position as i64,
                    now,
                    sig
                ],
            )
            .map_err(to_err)?;
        }
    }
    tombstone_missing(&tx, "monitors", &workspace_id, &kept, now)?;
    tx.commit().map_err(to_err)
}

/// Appends one result and trims that monitor's history to the newest 200.
#[tauri::command]
pub fn record_monitor_run(db: State<Db>, run: MonitorRun) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "INSERT INTO monitor_runs (id, monitor_id, at_ms, ok, requests, failures, avg_ms, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.id,
            run.monitor_id,
            run.at_ms,
            run.ok as i64,
            run.requests,
            run.failures,
            run.avg_ms,
            run.detail
        ],
    )
    .map_err(to_err)?;
    conn.execute(
        "DELETE FROM monitor_runs WHERE monitor_id = ?1 AND id NOT IN
           (SELECT id FROM monitor_runs WHERE monitor_id = ?1 ORDER BY at_ms DESC LIMIT 200)",
        params![run.monitor_id],
    )
    .map_err(to_err)?;
    Ok(())
}

#[tauri::command]
pub fn clear_monitor_runs(db: State<Db>, monitor_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "DELETE FROM monitor_runs WHERE monitor_id = ?1",
        params![monitor_id],
    )
    .map_err(to_err)?;
    Ok(())
}

fn comment_sig(comment: &Comment) -> String {
    sig_of(&[
        &comment.request_id,
        comment.parent_id.as_deref().unwrap_or(""),
        &comment.author,
        &comment.body,
        &comment.created_at.to_string(),
        "0",
    ])
}

#[tauri::command]
pub fn save_comment(
    db: State<Db>,
    workspace_id: String,
    comment: Comment,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "INSERT INTO comments
           (id, workspace_id, request_id, parent_id, author, body, created_at, position,
            updated_at, deleted, sig)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 0, ?9)
         ON CONFLICT(id) DO UPDATE SET
           body       = excluded.body,
           updated_at = excluded.updated_at,
           deleted    = 0,
           sig        = excluded.sig",
        params![
            comment.id,
            workspace_id,
            comment.request_id,
            comment.parent_id,
            comment.author,
            comment.body,
            comment.created_at,
            now_ms(),
            comment_sig(&comment)
        ],
    )
    .map_err(to_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_comment(db: State<Db>, comment_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    // Tombstoned, not removed, so the deletion reaches peers.
    conn.execute(
        "UPDATE comments SET deleted = 1, updated_at = ?2 WHERE id = ?1",
        params![comment_id, now_ms()],
    )
    .map_err(to_err)?;
    Ok(())
}

/// Newest entries first. History is capped on write, so this is bounded.
#[tauri::command]
pub fn load_history(
    db: State<Db>,
    workspace_id: String,
    limit: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    let conn = db.0.lock().map_err(to_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, at_ms, name, method, url, status, status_text, time_ms,
                    size_bytes, request, error
             FROM history WHERE workspace_id = ?1
             ORDER BY at_ms DESC LIMIT ?2",
        )
        .map_err(to_err)?;
    let rows = stmt
        .query_map(params![workspace_id, limit.unwrap_or(300)], |row| {
            let request: String = row.get(9)?;
            Ok(HistoryEntry {
                id: row.get(0)?,
                at_ms: row.get(1)?,
                name: row.get(2)?,
                method: row.get(3)?,
                url: row.get(4)?,
                status: row.get(5)?,
                status_text: row.get(6)?,
                time_ms: row.get(7)?,
                size_bytes: row.get(8)?,
                request: parse_json(&request, empty_object()),
                error: row.get(10)?,
            })
        })
        .map_err(to_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_err)?;
    Ok(rows)
}

/// Records one send and trims the workspace to its newest entries.
#[tauri::command]
pub fn record_history(
    db: State<Db>,
    workspace_id: String,
    entry: HistoryEntry,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "INSERT INTO history
           (id, workspace_id, at_ms, name, method, url, status, status_text,
            time_ms, size_bytes, request, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            entry.id,
            workspace_id,
            entry.at_ms,
            entry.name,
            entry.method,
            entry.url,
            entry.status,
            entry.status_text,
            entry.time_ms,
            entry.size_bytes,
            json_text(&entry.request, "{}"),
            entry.error
        ],
    )
    .map_err(to_err)?;

    // Unbounded history would grow the database forever.
    conn.execute(
        "DELETE FROM history WHERE workspace_id = ?1 AND id NOT IN
           (SELECT id FROM history WHERE workspace_id = ?1
            ORDER BY at_ms DESC LIMIT 500)",
        params![workspace_id],
    )
    .map_err(to_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_history_entry(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute("DELETE FROM history WHERE id = ?1", params![id])
        .map_err(to_err)?;
    Ok(())
}

#[tauri::command]
pub fn clear_history(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "DELETE FROM history WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map_err(to_err)?;
    Ok(())
}

/// `scope` is a workspace id, or `"global"` for app-wide values like the theme.
#[tauri::command]
pub fn set_setting(db: State<Db>, scope: String, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_err)?;
    conn.execute(
        "INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        params![scope, key, value],
    )
    .map_err(to_err)?;
    Ok(())
}

// --- Sync ---------------------------------------------------------------------
//
// Peers exchange rows, not whole documents: each syncable table carries
// `updated_at`, a `deleted` tombstone and a content signature. A row is taken
// from the peer only when its timestamp is newer than the local copy
// (last-write-wins), and the signature is recomputed on apply so a row that
// arrived from a peer is not mistaken for a local edit on the next save.

/// The columns that travel for each syncable table, in signature order.
pub struct TableSpec {
    pub name: &'static str,
    pub columns: &'static [&'static str],
}

pub const SYNC_TABLES: &[TableSpec] = &[
    TableSpec {
        name: "folders",
        columns: &["parent_id", "name", "position"],
    },
    TableSpec {
        name: "requests",
        columns: &[
            "folder_id", "name", "method", "url", "headers", "body", "tests", "config",
            "position",
        ],
    },
    TableSpec {
        name: "environments",
        columns: &["name", "variables", "position"],
    },
    TableSpec {
        name: "mock_routes",
        columns: &[
            "enabled", "method", "path", "status", "headers", "body", "delay_ms", "position",
        ],
    },
    TableSpec {
        name: "comments",
        columns: &[
            "request_id", "parent_id", "author", "body", "created_at", "position",
        ],
    },
    TableSpec {
        name: "monitors",
        columns: &[
            "name", "target_kind", "target_id", "interval_secs", "enabled", "environment_id",
            "notify", "method", "url", "headers", "body", "expected_status", "position",
        ],
    },
];

fn spec_for(table: &str) -> Option<&'static TableSpec> {
    SYNC_TABLES.iter().find(|spec| spec.name == table)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncRow {
    pub table: String,
    pub id: String,
    pub updated_at: i64,
    pub deleted: bool,
    /// Column values in `TableSpec` order.
    pub values: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncPayload {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_updated_at: i64,
    pub workspace_deleted: bool,
    pub rows: Vec<SyncRow>,
    /// The sender's clock when the snapshot was taken.
    pub now: i64,
}

/// Variables flagged `secret` never leave the machine: their names travel so
/// peers know what to fill in, their values do not.
fn redact_secret_variables(value: &serde_json::Value) -> serde_json::Value {
    let serde_json::Value::String(raw) = value else {
        return value.clone();
    };
    let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
        return value.clone();
    };
    let Some(list) = parsed.as_array_mut() else {
        return value.clone();
    };
    for entry in list.iter_mut() {
        if entry.get("secret").and_then(|s| s.as_bool()).unwrap_or(false) {
            entry["value"] = serde_json::Value::String(String::new());
        }
    }
    serde_json::Value::String(parsed.to_string())
}

/// Puts this machine's secret values back over a redacted incoming row, so a
/// sync never wipes a credential the peer could not send.
fn merge_local_secrets(
    incoming: &serde_json::Value,
    local: Option<&str>,
) -> serde_json::Value {
    let (serde_json::Value::String(raw), Some(local_raw)) = (incoming, local) else {
        return incoming.clone();
    };
    let (Ok(mut parsed), Ok(local_parsed)) = (
        serde_json::from_str::<serde_json::Value>(raw),
        serde_json::from_str::<serde_json::Value>(local_raw),
    ) else {
        return incoming.clone();
    };
    let (Some(list), Some(local_list)) = (parsed.as_array_mut(), local_parsed.as_array()) else {
        return incoming.clone();
    };

    for entry in list.iter_mut() {
        let is_secret = entry.get("secret").and_then(|s| s.as_bool()).unwrap_or(false);
        let is_blank = entry.get("value").and_then(|v| v.as_str()).unwrap_or("").is_empty();
        if !is_secret || !is_blank {
            continue;
        }
        let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let kept = local_list
            .iter()
            .find(|candidate| candidate.get("name").and_then(|n| n.as_str()) == Some(name))
            .and_then(|candidate| candidate.get("value"))
            .cloned();
        if let Some(kept) = kept {
            entry["value"] = kept;
        }
    }
    serde_json::Value::String(parsed.to_string())
}

/// Canonical text form of a value, used for both signatures and binding.
fn value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(flag) => (*flag as i64).to_string(),
        other => other.to_string(),
    }
}

fn row_sig(values: &[serde_json::Value]) -> String {
    let texts: Vec<String> = values.iter().map(value_text).collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    sig_of(&refs)
}

fn sql_value(value: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        serde_json::Value::Null => Sql::Null,
        serde_json::Value::Bool(flag) => Sql::Integer(*flag as i64),
        serde_json::Value::Number(number) => number
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| number.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        serde_json::Value::String(text) => Sql::Text(text.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn json_from_sql(value: rusqlite::types::Value) -> serde_json::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Sql::Null => serde_json::Value::Null,
        Sql::Integer(number) => serde_json::Value::from(number),
        Sql::Real(number) => serde_json::Value::from(number),
        Sql::Text(text) => serde_json::Value::String(text),
        Sql::Blob(_) => serde_json::Value::Null,
    }
}

/// Newest `updated_at` across a workspace's syncable tables. Polled locally
/// (never over the network) to notice edits worth pushing to peers.
#[tauri::command]
pub fn local_change_stamp(db: State<Db>, workspace_id: String) -> Result<i64, String> {
    let conn = db.0.lock().map_err(to_err)?;
    let mut newest = conn
        .query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);

    for spec in SYNC_TABLES {
        let value: i64 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(MAX(updated_at), 0) FROM {} WHERE workspace_id = ?1",
                    spec.name
                ),
                params![workspace_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        newest = newest.max(value);
    }
    Ok(newest)
}

/// Every row in `workspace_id` changed after `since`, tombstones included.
#[tauri::command]
pub fn sync_snapshot(
    db: State<Db>,
    workspace_id: String,
    since: i64,
) -> Result<SyncPayload, String> {
    let conn = db.0.lock().map_err(to_err)?;
    snapshot(&conn, &workspace_id, since)
}

pub fn snapshot(
    conn: &Connection,
    workspace_id: &str,
    since: i64,
) -> Result<SyncPayload, String> {
    let (workspace_name, workspace_updated_at, workspace_deleted) = conn
        .query_row(
            "SELECT name, updated_at, deleted FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .unwrap_or_else(|_| (String::new(), 0, false));

    let mut rows = Vec::new();
    for spec in SYNC_TABLES {
        let columns = spec.columns.join(", ");
        let sql = format!(
            "SELECT id, updated_at, deleted, {columns} FROM {}              WHERE workspace_id = ?1 AND updated_at > ?2",
            spec.name
        );
        let mut stmt = conn.prepare(&sql).map_err(to_err)?;
        let count = spec.columns.len();
        let mapped = stmt
            .query_map(params![workspace_id, since], |row| {
                let mut values = Vec::with_capacity(count);
                for index in 0..count {
                    let mut value =
                        json_from_sql(row.get::<_, rusqlite::types::Value>(index + 3)?);
                    if spec.name == "environments" && spec.columns[index] == "variables" {
                        value = redact_secret_variables(&value);
                    }
                    values.push(value);
                }
                Ok(SyncRow {
                    table: spec.name.to_string(),
                    id: row.get(0)?,
                    updated_at: row.get(1)?,
                    deleted: row.get::<_, i64>(2)? != 0,
                    values,
                })
            })
            .map_err(to_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(to_err)?;
        rows.extend(mapped);
    }

    Ok(SyncPayload {
        workspace_id: workspace_id.to_string(),
        workspace_name,
        workspace_updated_at,
        workspace_deleted,
        rows,
        now: now_ms(),
    })
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub applied: usize,
    pub skipped: usize,
    /// Newest timestamp seen, so the caller can advance its watermark.
    pub max_updated_at: i64,
}

/// Applies a peer's rows, keeping whichever version is newer.
#[tauri::command]
pub fn sync_apply(db: State<Db>, payload: SyncPayload) -> Result<ApplyReport, String> {
    let mut conn = db.0.lock().map_err(to_err)?;
    apply(&mut conn, &payload)
}

pub fn apply(conn: &mut Connection, payload: &SyncPayload) -> Result<ApplyReport, String> {
    let mut report = ApplyReport::default();
    let tx = conn.transaction().map_err(to_err)?;

    // The workspace itself, so a peer's new workspace appears rather than its
    // contents landing nowhere.
    let local_workspace: Option<i64> = tx
        .query_row(
            "SELECT updated_at FROM workspaces WHERE id = ?1",
            params![payload.workspace_id],
            |row| row.get(0),
        )
        .ok();
    match local_workspace {
        None => {
            let position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM workspaces",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            tx.execute(
                "INSERT INTO workspaces (id, name, position, updated_at, deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    payload.workspace_id,
                    payload.workspace_name,
                    position,
                    payload.workspace_updated_at,
                    payload.workspace_deleted as i64
                ],
            )
            .map_err(to_err)?;
        }
        Some(local) if payload.workspace_updated_at > local => {
            tx.execute(
                "UPDATE workspaces SET name = ?2, updated_at = ?3, deleted = ?4 WHERE id = ?1",
                params![
                    payload.workspace_id,
                    payload.workspace_name,
                    payload.workspace_updated_at,
                    payload.workspace_deleted as i64
                ],
            )
            .map_err(to_err)?;
        }
        _ => {}
    }

    for row in &payload.rows {
        report.max_updated_at = report.max_updated_at.max(row.updated_at);

        let Some(spec) = spec_for(&row.table) else {
            report.skipped += 1;
            continue;
        };
        if row.values.len() != spec.columns.len() {
            report.skipped += 1;
            continue;
        }

        let local: Option<i64> = tx
            .query_row(
                &format!("SELECT updated_at FROM {} WHERE id = ?1", spec.name),
                params![row.id],
                |r| r.get(0),
            )
            .ok();
        // Last write wins; an equal timestamp keeps the local copy so repeated
        // syncs are idempotent.
        if local.map(|local| row.updated_at <= local).unwrap_or(false) {
            report.skipped += 1;
            continue;
        }

        // Environments arrive with secret values blanked; keep ours.
        let mut values = row.values.clone();
        if spec.name == "environments" {
            let local_variables: Option<String> = tx
                .query_row(
                    "SELECT variables FROM environments WHERE id = ?1",
                    params![row.id],
                    |r| r.get(0),
                )
                .ok();
            if let Some(index) = spec.columns.iter().position(|c| *c == "variables") {
                values[index] =
                    merge_local_secrets(&values[index], local_variables.as_deref());
            }
        }

        let columns = spec.columns.join(", ");
        let placeholders: Vec<String> = (0..spec.columns.len())
            .map(|index| format!("?{}", index + 6))
            .collect();
        let assignments: Vec<String> = spec
            .columns
            .iter()
            .map(|column| format!("{column} = excluded.{column}"))
            .collect();

        let sql = format!(
            "INSERT INTO {} (id, workspace_id, updated_at, deleted, sig, {columns})
             VALUES (?1, ?2, ?3, ?4, ?5, {})
             ON CONFLICT(id) DO UPDATE SET
               workspace_id = excluded.workspace_id,
               updated_at   = excluded.updated_at,
               deleted      = excluded.deleted,
               sig          = excluded.sig,
               {}",
            spec.name,
            placeholders.join(", "),
            assignments.join(",\n               ")
        );

        let mut bindings: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(row.id.clone()),
            rusqlite::types::Value::Text(payload.workspace_id.clone()),
            rusqlite::types::Value::Integer(row.updated_at),
            rusqlite::types::Value::Integer(row.deleted as i64),
            rusqlite::types::Value::Text(row_sig(&values)),
        ];
        bindings.extend(values.iter().map(sql_value));

        tx.execute(&sql, rusqlite::params_from_iter(bindings))
            .map_err(to_err)?;
        report.applied += 1;
    }

    tx.commit().map_err(to_err)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(SCHEMA).expect("schema");
        conn.execute_batch(INDEXES).expect("indexes");
        conn.execute(
            "INSERT INTO workspaces (id, name, position, updated_at) VALUES ('w', 'Test', 0, 1)",
            [],
        )
        .expect("workspace");
        conn
    }

    fn request(id: &str, name: &str) -> TreeNode {
        TreeNode::Request {
            id: id.into(),
            name: name.into(),
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: vec![],
            body: String::new(),
            tests: empty_array(),
            config: empty_object(),
        }
    }

    fn folder(id: &str, name: &str, children: Vec<TreeNode>) -> TreeNode {
        TreeNode::Folder {
            id: id.into(),
            name: name.into(),
            children,
        }
    }

    fn names(nodes: &[TreeNode]) -> Vec<String> {
        nodes
            .iter()
            .map(|node| match node {
                TreeNode::Folder { name, children, .. } => {
                    format!("{name}[{}]", names(children).join(","))
                }
                TreeNode::Request { name, .. } => name.clone(),
            })
            .collect()
    }

    #[test]
    fn unchanged_saves_keep_their_timestamp() {
        let mut db = memory_db();
        let tree = vec![folder("f1", "Auth", vec![request("r1", "Login")])];
        write_tree(&mut db, "w", &tree).unwrap();

        let first: i64 = db
            .query_row("SELECT updated_at FROM requests WHERE id = 'r1'", [], |r| {
                r.get(0)
            })
            .unwrap();

        // Saving identical content must not look like an edit, or every save
        // would push the whole collection to every peer.
        write_tree(&mut db, "w", &tree).unwrap();
        let second: i64 = db
            .query_row("SELECT updated_at FROM requests WHERE id = 'r1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn rows_predating_sync_are_stamped_so_they_can_travel() {
        let mut a = memory_db();
        write_tree(&mut a, "w", &[request("r1", "Legacy")]).unwrap();
        // Simulate a row created before sync bookkeeping existed.
        a.execute("UPDATE requests SET updated_at = 0", []).unwrap();

        let invisible = snapshot(&a, "w", 0).unwrap();
        assert!(
            invisible.rows.iter().all(|row| row.table != "requests"),
            "a row at updated_at = 0 cannot be sent — this is the bug",
        );

        let stamped = stamp_unversioned_rows(&a).unwrap();
        assert!(stamped >= 1);

        let payload = snapshot(&a, "w", 0).unwrap();
        assert!(
            payload.rows.iter().any(|row| row.table == "requests"),
            "after stamping it must be included",
        );

        let mut b = memory_db();
        apply(&mut b, &payload).unwrap();
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["Legacy"]);
    }

    #[test]
    fn sync_moves_creates_edits_and_deletes() {
        let mut a = memory_db();
        let mut b = memory_db();

        // A creates a folder with two requests.
        write_tree(
            &mut a,
            "w",
            &[folder(
                "f1",
                "Auth",
                vec![request("r1", "Login"), request("r2", "Logout")],
            )],
        )
        .unwrap();

        let payload = snapshot(&a, "w", 0).unwrap();
        let report = apply(&mut b, &payload).unwrap();
        assert_eq!(report.applied, 3, "folder + two requests");
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["Auth[Login,Logout]"]);

        // Applying the same payload again changes nothing.
        let again = apply(&mut b, &payload).unwrap();
        assert_eq!(again.applied, 0);

        // A renames one request and deletes the other.
        let watermark = payload.rows.iter().map(|r| r.updated_at).max().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        write_tree(
            &mut a,
            "w",
            &[folder("f1", "Auth", vec![request("r1", "Sign in")])],
        )
        .unwrap();

        let delta = snapshot(&a, "w", watermark).unwrap();
        apply(&mut b, &delta).unwrap();
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["Auth[Sign in]"]);
    }

    #[test]
    fn newer_edit_wins_and_older_is_ignored() {
        let mut a = memory_db();
        let mut b = memory_db();

        write_tree(&mut a, "w", &[request("r1", "From A")]).unwrap();
        apply(&mut b, &snapshot(&a, "w", 0).unwrap()).unwrap();

        // B edits later than A, so B's version must survive a sync in either
        // direction.
        std::thread::sleep(std::time::Duration::from_millis(2));
        write_tree(&mut b, "w", &[request("r1", "From B")]).unwrap();

        let from_a = snapshot(&a, "w", 0).unwrap();
        apply(&mut b, &from_a).unwrap();
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["From B"]);

        let from_b = snapshot(&b, "w", 0).unwrap();
        apply(&mut a, &from_b).unwrap();
        assert_eq!(names(&read_tree(&a, "w").unwrap()), vec!["From B"]);
    }

    #[test]
    fn applied_rows_do_not_echo_back() {
        let mut a = memory_db();
        let mut b = memory_db();

        write_tree(&mut a, "w", &[request("r1", "Login")]).unwrap();
        let payload = snapshot(&a, "w", 0).unwrap();
        apply(&mut b, &payload).unwrap();

        // B saving the tree it just received must not mark the row as changed,
        // otherwise the two peers would push it back and forth forever.
        let before: i64 = b
            .query_row("SELECT updated_at FROM requests WHERE id = 'r1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let current = read_tree(&b, "w").unwrap();
        write_tree(&mut b, "w", &current).unwrap();
        let after: i64 = b
            .query_row("SELECT updated_at FROM requests WHERE id = 'r1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn a_peer_asking_for_an_unknown_workspace_gets_nothing() {
        // Each machine generates its own workspace ids, so machine B asking A
        // for B's id finds nothing — the bug behind "sync fetches no requests".
        // `snapshot` is right to return empty; the transport turns this into a
        // clear error, and the UI pairs the two ids up front.
        let mut a = memory_db();
        write_tree(&mut a, "w", &[request("r1", "Login")]).unwrap();

        let mine = snapshot(&a, "w", 0).unwrap();
        assert_eq!(mine.rows.len(), 1, "its own workspace has the row");

        let theirs = snapshot(&a, "some-other-machines-id", 0).unwrap();
        assert!(theirs.rows.is_empty());
        assert_eq!(theirs.workspace_name, "", "no such workspace here");

        assert!(workspace_exists(&a, "w").unwrap());
        assert!(!workspace_exists(&a, "some-other-machines-id").unwrap());
    }

    #[test]
    fn pairing_on_a_shared_id_syncs_both_ways() {
        // Once both machines use the same workspace id — which is what the
        // panel now arranges — rows flow normally.
        let mut a = memory_db();
        let mut b = memory_db();

        write_tree(&mut a, "w", &[request("r1", "List APIs")]).unwrap();
        let report = apply(&mut b, &snapshot(&a, "w", 0).unwrap()).unwrap();
        assert!(report.applied >= 1);
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["List APIs"]);
    }

    #[test]
    fn a_new_workspace_arrives_with_its_contents() {
        let mut a = memory_db();
        let mut b = Connection::open_in_memory().unwrap();
        b.execute_batch(SCHEMA).unwrap();
        b.execute_batch(INDEXES).unwrap();

        write_tree(&mut a, "w", &[request("r1", "Login")]).unwrap();
        apply(&mut b, &snapshot(&a, "w", 0).unwrap()).unwrap();

        let name: String = b
            .query_row("SELECT name FROM workspaces WHERE id = 'w'", [], |r| r.get(0))
            .expect("workspace created on the peer");
        assert_eq!(name, "Test");
        assert_eq!(names(&read_tree(&b, "w").unwrap()), vec!["Login"]);
    }
}

#[cfg(test)]
mod secret_tests {
    use super::*;

    fn variables(json: &str) -> serde_json::Value {
        serde_json::Value::String(json.to_string())
    }

    #[test]
    fn secret_values_never_leave_the_machine() {
        let redacted = redact_secret_variables(&variables(
            r#"[{"name":"baseUrl","value":"https://api"},{"name":"token","value":"hunter2","secret":true}]"#,
        ));
        let text = redacted.as_str().unwrap();
        assert!(text.contains("https://api"), "plain values still travel");
        assert!(!text.contains("hunter2"), "secret value must be stripped");
        assert!(text.contains("\"token\""), "its name still travels");
    }

    #[test]
    fn a_sync_does_not_wipe_a_local_secret() {
        let incoming = variables(
            r#"[{"name":"token","value":"","secret":true},{"name":"baseUrl","value":"https://new"}]"#,
        );
        let local = r#"[{"name":"token","value":"my-local-token","secret":true},{"name":"baseUrl","value":"https://old"}]"#;

        let merged = merge_local_secrets(&incoming, Some(local));
        let text = merged.as_str().unwrap();
        assert!(text.contains("my-local-token"), "local secret is kept");
        assert!(text.contains("https://new"), "non-secret still updates");
    }

    #[test]
    fn an_explicitly_sent_secret_is_respected() {
        // Only blanks are refilled; a peer that genuinely sends a value wins.
        let incoming = variables(r#"[{"name":"token","value":"from-peer","secret":true}]"#);
        let local = r#"[{"name":"token","value":"mine","secret":true}]"#;
        let merged = merge_local_secrets(&incoming, Some(local));
        assert!(merged.as_str().unwrap().contains("from-peer"));
    }
}
