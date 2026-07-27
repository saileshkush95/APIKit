// Thin wrappers around the Tauri command layer so components never call
// `invoke` with stringly-typed names directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Environment,
  Flow,
  HttpRequestSpec,
  HttpResponseData,
  LoadConfig,
  LoadProgress,
  LoadReport,
  MockHit,
  MockRoute,
  MockStatus,
  Comment,
  GithubConfig,
  GithubFile,
  GithubPushResult,
  Monitor,
  MonitorRun,
  SyncOutcome,
  SyncServerStatus,
  ProxyStatus,
  StoredTab,
  StreamConnectConfig,
  StreamEvent,
  StreamStatus,
  TreeNode,
  WorkspaceData,
  WorkspaceMeta,
} from "../types";

export function sendRequest(spec: HttpRequestSpec): Promise<HttpResponseData> {
  return invoke<HttpResponseData>("send_request", { spec });
}

// --- Workspaces --------------------------------------------------------------

export function listWorkspaces(): Promise<WorkspaceMeta[]> {
  return invoke<WorkspaceMeta[]>("list_workspaces");
}

export function createWorkspace(name: string): Promise<WorkspaceMeta> {
  return invoke<WorkspaceMeta>("create_workspace", { name });
}

export function renameWorkspace(id: string, name: string): Promise<void> {
  return invoke<void>("rename_workspace", { id, name });
}

export function deleteWorkspace(id: string): Promise<void> {
  return invoke<void>("delete_workspace", { id });
}

// --- Workspace contents (SQLite) --------------------------------------------

export function loadWorkspaceData(workspaceId: string): Promise<WorkspaceData> {
  return invoke<WorkspaceData>("load_workspace_data", { workspaceId });
}

export function saveTree(
  workspaceId: string,
  nodes: TreeNode[],
): Promise<void> {
  return invoke<void>("save_tree", { workspaceId, nodes });
}

export function saveEnvironments(
  workspaceId: string,
  environments: Environment[],
): Promise<void> {
  return invoke<void>("save_environments", { workspaceId, environments });
}

export function saveTabs(
  workspaceId: string,
  tabs: StoredTab[],
): Promise<void> {
  return invoke<void>("save_tabs", { workspaceId, tabs });
}

export function saveMockRoutes(
  workspaceId: string,
  routes: MockRoute[],
): Promise<void> {
  return invoke<void>("save_mock_routes", { workspaceId, routes });
}

/** `scope` is a workspace id, or `GLOBAL_SCOPE` for app-wide values. */
export function setSetting(
  scope: string,
  key: string,
  value: string,
): Promise<void> {
  return invoke<void>("set_setting", { scope, key, value });
}

/** Tells the backend whether closing the window should quit the app. */
export function setBackgroundMode(enabled: boolean): Promise<void> {
  return invoke<void>("set_background_mode", { enabled });
}

// --- Comments ----------------------------------------------------------------

export function saveComment(
  workspaceId: string,
  comment: Comment,
): Promise<void> {
  return invoke<void>("save_comment", { workspaceId, comment });
}

export function deleteComment(commentId: string): Promise<void> {
  return invoke<void>("delete_comment", { commentId });
}

// --- LAN sync ----------------------------------------------------------------

export function startSyncServer(port: number, token: string): Promise<number> {
  return invoke<number>("start_sync_server", { port, token });
}

export function stopSyncServer(): Promise<void> {
  return invoke<void>("stop_sync_server");
}

export function syncServerStatus(): Promise<SyncServerStatus> {
  return invoke<SyncServerStatus>("sync_server_status");
}

/** Returns the peer's clock, for reachability and skew checks. */
export function pingPeer(host: string): Promise<number> {
  return invoke<number>("ping_peer", { host });
}

export function syncWithPeer(
  host: string,
  token: string,
  workspaceId: string,
  pulledWatermark: number,
  pushedWatermark: number,
): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("sync_with_peer", {
    host,
    token,
    workspaceId,
    pulledWatermark,
    pushedWatermark,
  });
}

/** Fires when a sync changed the database and the UI should reload. */
export function onSyncApplied(cb: (applied: number) => void): Promise<UnlistenFn> {
  return listen<number>("sync://applied", (event) => cb(event.payload));
}

// --- GitHub sync & export ----------------------------------------------------

export function githubPull(config: GithubConfig): Promise<GithubFile> {
  return invoke<GithubFile>("github_pull", { config });
}

export function githubPush(
  config: GithubConfig,
  content: string,
  sha: string | null,
  message: string,
): Promise<GithubPushResult> {
  return invoke<GithubPushResult>("github_push", {
    config,
    content,
    sha,
    message,
  });
}

/** Verifies the token and that the repository is writable. */
export function githubCheck(config: GithubConfig): Promise<string> {
  return invoke<string>("github_check", { config });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

// --- Credentials -------------------------------------------------------------
// Tokens live in the OS keychain, never in the workspace database.

export function secretSet(key: string, value: string): Promise<void> {
  return invoke<void>("secret_set", { key, value });
}

export function secretGet(key: string): Promise<string> {
  return invoke<string>("secret_get", { key });
}

export function secretDelete(key: string): Promise<void> {
  return invoke<void>("secret_delete", { key });
}

// --- Live sync ---------------------------------------------------------------

/** Newest change timestamp locally, polled to notice edits worth pushing. */
export function localChangeStamp(workspaceId: string): Promise<number> {
  return invoke<number>("local_change_stamp", { workspaceId });
}

export function notifyLocalChange(): Promise<void> {
  return invoke<void>("notify_local_change");
}

export function syncWatchPeer(host: string, token: string): Promise<void> {
  return invoke<void>("sync_watch_peer", { host, token });
}

export function syncUnwatchPeer(host: string): Promise<void> {
  return invoke<void>("sync_unwatch_peer", { host });
}

/** Fires when a watched peer reports that its data changed. */
export function onPeerChanged(cb: (host: string) => void): Promise<UnlistenFn> {
  return listen<string>("sync://peer-changed", (event) => cb(event.payload));
}

/** Fires when a peer stream connects or drops. */
export function onWatchState(
  cb: (host: string, connected: boolean) => void,
): Promise<UnlistenFn> {
  return listen<[string, boolean]>("sync://watch-state", (event) =>
    cb(event.payload[0], event.payload[1]),
  );
}

// --- Monitoring --------------------------------------------------------------

export function saveMonitors(
  workspaceId: string,
  monitors: Monitor[],
): Promise<void> {
  return invoke<void>("save_monitors", { workspaceId, monitors });
}

export function recordMonitorRun(run: MonitorRun): Promise<void> {
  return invoke<void>("record_monitor_run", { run });
}

export function clearMonitorRuns(monitorId: string): Promise<void> {
  return invoke<void>("clear_monitor_runs", { monitorId });
}

// --- Mock server -------------------------------------------------------------

export function startMockServer(
  workspaceId: string,
  port: number,
): Promise<number> {
  return invoke<number>("start_mock_server", { workspaceId, port });
}

export function stopMockServer(): Promise<void> {
  return invoke<void>("stop_mock_server");
}

export function mockStatus(): Promise<MockStatus> {
  return invoke<MockStatus>("mock_status");
}

/** Pushes edited routes to a running mock server. */
export function applyMockRoutes(routes: MockRoute[]): Promise<void> {
  return invoke<void>("apply_mock_routes", { routes });
}

/** Subscribe to mock server hits. Returns an unlisten function. */
export function onMockHit(cb: (hit: MockHit) => void): Promise<UnlistenFn> {
  return listen<MockHit>("mock://hit", (event) => cb(event.payload));
}

// --- Streaming protocols -----------------------------------------------------

/** Opens a WebSocket / SSE / Socket.IO / MQTT / GraphQL-WS session. */
export function streamConnect(config: StreamConnectConfig): Promise<string> {
  return invoke<string>("stream_connect", { config });
}

export function streamSend(
  sessionId: string,
  message: { text: string; topic?: string | null },
): Promise<void> {
  return invoke<void>("stream_send", { sessionId, message });
}

export function streamDisconnect(sessionId: string): Promise<void> {
  return invoke<void>("stream_disconnect", { sessionId });
}

export function onStreamEvent(
  cb: (event: StreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<StreamEvent>("stream://event", (event) => cb(event.payload));
}

export function onStreamStatus(
  cb: (status: StreamStatus) => void,
): Promise<UnlistenFn> {
  return listen<StreamStatus>("stream://status", (event) => cb(event.payload));
}

// --- Load testing ------------------------------------------------------------

export function runLoadTest(config: LoadConfig): Promise<LoadReport> {
  return invoke<LoadReport>("run_load_test", { config });
}

export function stopLoadTest(): Promise<void> {
  return invoke<void>("stop_load_test");
}

export function onLoadProgress(
  cb: (progress: LoadProgress) => void,
): Promise<UnlistenFn> {
  return listen<LoadProgress>("load://progress", (event) => cb(event.payload));
}

// --- Proxy -------------------------------------------------------------------

export function startProxy(port: number): Promise<number> {
  return invoke<number>("start_proxy", { port });
}

export function stopProxy(): Promise<void> {
  return invoke<void>("stop_proxy");
}

export function proxyStatus(): Promise<ProxyStatus> {
  return invoke<ProxyStatus>("proxy_status");
}

export function getFlows(): Promise<Flow[]> {
  return invoke<Flow[]>("get_flows");
}

export function clearFlows(): Promise<void> {
  return invoke<void>("clear_flows");
}

export function getCaCertificatePem(): Promise<string> {
  return invoke<string>("get_ca_certificate_pem");
}

export function caCertificatePath(): Promise<string> {
  return invoke<string>("ca_certificate_path");
}

/** Subscribe to live proxy flows. Returns an unlisten function. */
export function onProxyFlow(cb: (flow: Flow) => void): Promise<UnlistenFn> {
  return listen<Flow>("proxy://flow", (event) => cb(event.payload));
}
