// Thin wrappers around the Tauri command layer so components never call
// `invoke` with stringly-typed names directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Cookie,
  Environment,
  Flow,
  Header,
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
  HistoryEntry,
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

/** Aborts the in-flight request that was sent with this `cancelId`. */
export function cancelRequest(id: string): Promise<void> {
  return invoke<void>("cancel_request", { id });
}

/** Writes base64-encoded bytes to disk — saving binary response bodies. */
export function saveBinaryFile(
  path: string,
  contentsBase64: string,
): Promise<void> {
  return invoke<void>("save_binary_file", { path, contentsBase64 });
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

// --- History -----------------------------------------------------------------

export function loadHistory(
  workspaceId: string,
  limit?: number,
): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("load_history", { workspaceId, limit });
}

export function recordHistory(
  workspaceId: string,
  entry: HistoryEntry,
): Promise<void> {
  return invoke<void>("record_history", { workspaceId, entry });
}

export function deleteHistoryEntry(id: string): Promise<void> {
  return invoke<void>("delete_history_entry", { id });
}

export function clearHistory(workspaceId: string): Promise<void> {
  return invoke<void>("clear_history", { workspaceId });
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

/** The workspaces a peer offers, for choosing which to pair with. */
export function listPeerWorkspaces(
  host: string,
  token: string,
): Promise<WorkspaceMeta[]> {
  return invoke<WorkspaceMeta[]>("list_peer_workspaces", { host, token });
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

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
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

// --- Email -------------------------------------------------------------------

export interface SmtpSpec {
  host: string;
  port: number;
  username: string;
  password: string;
  security: string;
  from: string;
  fromName: string;
}

/** Sends a plain-text email; `to` may be several addresses, comma-separated. */
export function sendEmail(
  smtp: SmtpSpec,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  return invoke<void>("send_email", { smtp, to, subject, body });
}

/** Connects and authenticates without sending anything. */
export function smtpCheck(smtp: SmtpSpec): Promise<void> {
  return invoke<void>("smtp_check", { smtp });
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

/** Fires when a peer stream connects or drops, with the reason on failure. */
export function onWatchState(
  cb: (host: string, connected: boolean, reason: string) => void,
): Promise<UnlistenFn> {
  return listen<[string, boolean, string]>("sync://watch-state", (event) =>
    cb(event.payload[0], event.payload[1], event.payload[2] ?? ""),
  );
}

export interface PeerDiagnosis {
  reachable: boolean;
  tokenOk: boolean;
  liveOk: boolean;
  clockSkewMs: number;
  workspaces: number;
  summary: string;
}

/** Checks a peer end to end and names the first thing that is wrong. */
export function diagnosePeer(
  host: string,
  token: string,
): Promise<PeerDiagnosis> {
  return invoke<PeerDiagnosis>("diagnose_peer", { host, token });
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

// --- gRPC ---------------------------------------------------------------------

export interface GrpcSpec {
  target: string;
  method: string;
  body: string;
  metadata: Header[];
  timeoutMs?: number | null;
  plaintext: boolean;
}

export interface GrpcResponse {
  body: string;
  status: string;
  timeMs: number;
  metadata: Header[];
}

/** Invokes a unary method, using the server's own descriptors for JSON. */
export function grpcCall(spec: GrpcSpec): Promise<GrpcResponse> {
  return invoke<GrpcResponse>("grpc_call", { spec });
}

/** The services a server exposes, via reflection. */
export function grpcServices(spec: GrpcSpec): Promise<string[]> {
  return invoke<string[]>("grpc_services", { spec });
}

// --- Proxy -------------------------------------------------------------------

export function startProxy(
  port: number,
  allInterfaces: boolean,
): Promise<number> {
  return invoke<number>("start_proxy", { port, allInterfaces });
}

export function stopProxy(): Promise<void> {
  return invoke<void>("stop_proxy");
}

export interface HeldRequest {
  id: number;
  method: string;
  url: string;
  headers: Header[];
  body: string;
  /** "request" on the way out, "response" on the way back. */
  kind: "request" | "response";
  status: number | null;
}

export interface InterceptDecision {
  action: "forward" | "abort";
  /** Replacement status, for a held response. */
  status?: number | null;
  method: string;
  url: string;
  headers: Header[];
  body: string;
}

/** Turns breakpoints on or off; disabling releases anything already held. */
export function setIntercept(
  enabled: boolean,
  filter: string,
  responses: boolean,
): Promise<void> {
  return invoke<void>("set_intercept", { enabled, filter, responses });
}

/** Releases one held request, with any edits. */
export function resumeRequest(
  id: number,
  decision: InterceptDecision,
): Promise<void> {
  return invoke<void>("resume_request", { id, decision });
}

/** Fires when a request is paused at a breakpoint. */
export function onProxyHold(
  handler: (held: HeldRequest) => void,
): Promise<UnlistenFn> {
  return listen<HeldRequest>("proxy://hold", (event) => handler(event.payload));
}

/** Points this computer's HTTP/HTTPS proxy at APIKit (or back to none). */
export function setSystemProxy(enable: boolean, port: number): Promise<void> {
  return invoke<void>("set_system_proxy", { enable, port });
}

/** Whether the OS already trusts the proxy's CA, so HTTPS survives interception. */
export function caTrusted(certPath: string): Promise<boolean> {
  return invoke<boolean>("ca_trusted", { certPath });
}

/** Asks the OS to trust the CA certificate; shows a system prompt. */
export function trustCaCertificate(certPath: string): Promise<void> {
  return invoke<void>("trust_ca_certificate", { certPath });
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

// --- Cookies ------------------------------------------------------------------

export function listCookies(): Promise<Cookie[]> {
  return invoke<Cookie[]>("list_cookies");
}

export function cookiesEnabled(): Promise<boolean> {
  return invoke<boolean>("cookies_enabled");
}

export function setCookiesEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_cookies_enabled", { enabled });
}

export function putCookie(cookie: Cookie): Promise<void> {
  return invoke<void>("put_cookie", { cookie });
}

export function deleteCookie(
  domain: string,
  path: string,
  name: string,
): Promise<void> {
  return invoke<void>("delete_cookie", { domain, path, name });
}

/** Clears every cookie, or just one domain's. */
export function clearCookies(domain?: string): Promise<void> {
  return invoke<void>("clear_cookies", { domain: domain ?? null });
}
