// Types shared with the Rust backend. Field names use camelCase to match the
// `#[serde(rename_all = "camelCase")]` attributes on the Rust structs.

/** A name/value pair — the shape behind headers, query params and variables. */
export interface KeyValue {
  name: string;
  value: string;
  /** Form-data rows can carry a file instead of text. */
  kind?: "text" | "file";
  filePath?: string;
  /** Environment variables only: never synced, never exported. */
  secret?: boolean;
}

/** One part of a multipart body; the backend reads `filePath` from disk. */
export interface MultipartPart {
  name: string;
  value: string;
  filePath?: string | null;
  fileName?: string | null;
  contentType?: string | null;
}

/** A file attached to a GraphQL request, mapped onto a variable path. */
export interface GraphqlFile {
  /** Variable path, e.g. `file` or `input.files.0`. */
  variable: string;
  filePath: string;
}

export type Header = KeyValue;
export type Variable = KeyValue;

export interface Environment {
  id: string;
  name: string;
  variables: Variable[];
}

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers: Header[];
  body?: string | null;
  timeoutMs?: number | null;
  httpVersion?: string | null;
  verifyTls?: boolean | null;
  followRedirects?: boolean | null;
  multipart?: MultipartPart[] | null;
  /** A file sent as the entire body; the backend reads it from disk. */
  bodyFilePath?: string | null;
  /** When set, `cancelRequest` with the same id aborts this request. */
  cancelId?: string | null;
  /** Cap on redirects to follow; only used when redirects are followed. */
  maxRedirects?: number | null;
  /** Do not send a Referer header when following redirects. */
  noReferer?: boolean | null;
  /** Skip the shared cookie jar for this request, both directions. */
  noCookieJar?: boolean | null;
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  headers: Header[];
  body: string;
  /** Original bytes when not valid UTF-8; what "Save response" writes. */
  bodyBase64?: string | null;
  timeMs: number;
  sizeBytes: number;
  finalUrl: string;
  /** Protocol actually negotiated, e.g. "HTTP/2.0". */
  httpVersion: string;
}

export interface Flow {
  id: number;
  method: string;
  url: string;
  host: string;
  /** The app that made the request, or a device address for network clients. */
  app: string;
  requestHeaders: Header[];
  requestBody: string;
  status: number | null;
  statusText: string;
  responseHeaders: Header[];
  responseBody: string;
  startedMs: number;
  durationMs: number;
}

/** A cookie in the shared jar, as stored by the backend. */
export interface Cookie {
  domain: string;
  path: string;
  name: string;
  value: string;
  /** Unix milliseconds; null for a session cookie. */
  expiresMs: number | null;
  secure: boolean;
  httpOnly: boolean;
  /** "Strict", "Lax", "None", or empty when the server did not say. */
  sameSite: string;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
  flowCount: number;
  /** Addresses clients can point at; loopback only unless LAN mode is on. */
  addresses: string[];
}

export type BodyMode =
  | "none"
  | "formData"
  | "urlEncoded"
  | "raw"
  | "binary"
  | "graphql";

export type RawLanguage = "json" | "text" | "xml" | "html" | "javascript";

export type AuthType = "none" | "bearer" | "basic" | "apiKey" | "inherit";

export interface Auth {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  /** Where an API key is placed. */
  addTo: "header" | "query";
}

/** Protocols a request can speak. */
export type Protocol =
  | "rest"
  | "graphql"
  | "websocket"
  | "sse"
  | "socketio"
  | "mqtt"
  | "graphqlws"
  | "webrtc";

export type HttpVersion = "auto" | "http1" | "http2";

/** Protocols driven by a long-lived session rather than one round trip. */
export const STREAMING_PROTOCOLS: Protocol[] = [
  "websocket",
  "sse",
  "socketio",
  "mqtt",
  "graphqlws",
];

export function isStreaming(protocol: Protocol): boolean {
  return STREAMING_PROTOCOLS.includes(protocol);
}

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  rest: "REST",
  graphql: "GraphQL",
  websocket: "WebSocket",
  sse: "SSE",
  socketio: "Socket.IO",
  mqtt: "MQTT",
  graphqlws: "GraphQL Subs",
  webrtc: "WebRTC",
};

/** Everything the builder tracks beyond the raw wire fields. */
export interface RequestConfig {
  protocol: Protocol;
  httpVersion: HttpVersion;
  bodyMode: BodyMode;
  rawLanguage: RawLanguage;
  formData: KeyValue[];
  urlEncoded: KeyValue[];
  graphqlQuery: string;
  graphqlVariables: string;
  /** Files uploaded with a GraphQL request (multipart request spec). */
  graphqlFiles: GraphqlFile[];
  /** A file sent as the whole request body, in `binary` mode. */
  binaryFilePath: string;
  auth: Auth;
  /** Draft message for streaming protocols. */
  streamMessage: string;
  mqttTopics: string;
  mqttPublishTopic: string;
  mqttClientId: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttQos: number;
  /** Comma-separated ICE servers for the WebRTC connectivity check. */
  iceServers: string;
  /** Markdown documentation shown in the request's Docs tab. */
  docs: string;
  /** JavaScript run before the request is sent. */
  preScript: string;
  /** JavaScript run once the response arrives. */
  postScript: string;

  // Per-request overrides of the global settings; null means "use global".
  verifyTls: boolean | null;
  followRedirects: boolean | null;
  timeoutMs: number | null;
  /** Cap on redirects to follow; null uses the client default (10). */
  maxRedirects: number | null;
  /** Do not send a Referer header when following redirects. */
  noReferer: boolean;
  /** Skip the shared cookie jar entirely for this request. */
  noCookieJar: boolean;
}

// --- Application settings ----------------------------------------------------

export interface AppSettings {
  accentColor: string;
  uiFont: string;
  monoFont: string;
  fontSize: number;
  defaultTimeoutMs: number;
  followRedirects: boolean;
  /** Reject invalid/self-signed certificates. */
  verifyTls: boolean;
  /** Rewrite http:// → https:// and ws:// → wss:// before connecting. */
  enforceSecure: boolean;
  defaultHttpVersion: HttpVersion;
  /** How many messages a streaming session keeps in memory. */
  maxStreamMessages: number;
  /** Closing the window hides it instead of quitting, so monitors keep running. */
  runInBackground: boolean;
  startAtLogin: boolean;
  /** Name attached to comments you write. */
  userName: string;
  // SMTP, for monitor email notifications. The password lives in the OS
  // keychain (`secretGet("smtpPassword")`), never here.
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string;
  /** The From address of outgoing mail. Empty → the username doubles as it. */
  smtpFrom: string;
  /** Display name next to the From address. */
  smtpFromName: string;
  /** Default recipients for monitors that don't set their own, comma-separated. */
  smtpDefaultTo: string;
}

export type SmtpSecurity = "ssl" | "starttls" | "none";

// --- LAN sync ----------------------------------------------------------------

export interface SyncPeer {
  id: string;
  name: string;
  /** host:port of the peer sharing its workspace. */
  host: string;
  token: string;
  enabled: boolean;
  /**
   * Which workspace this peer syncs. Both machines must agree on the id, so it
   * is chosen from the peer's list (or seeded from a workspace you push).
   */
  workspaceId: string;
  workspaceName: string;
  /** Watermarks, so each round only exchanges what changed. */
  pulledWatermark: number;
  pushedWatermark: number;
  lastSyncMs: number | null;
  lastError: string | null;
  lastSkewMs: number | null;
  /** Result of the last round, so an empty sync is visible rather than silent. */
  lastPushed: number | null;
  lastPulled: number | null;
}

export interface GithubConfig {
  repo: string;
  branch: string;
  path: string;
  token: string;
}

export interface GithubFile {
  content: string;
  sha: string | null;
  exists: boolean;
}

export interface GithubPushResult {
  sha: string;
  commitUrl: string;
}

/** The document written to disk on export and to GitHub on push. */
export interface WorkspaceExport {
  format: "webrequestkit";
  version: 1;
  exportedAt: string;
  workspace: string;
  tree: TreeNode[];
  environments: Environment[];
  monitors?: Monitor[];
  mockRoutes?: MockRoute[];
}

export interface SyncServerStatus {
  running: boolean;
  port: number | null;
  addresses: string[];
}

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  skipped: number;
  peerNow: number;
  localNow: number;
  pulledWatermark: number;
  pushedWatermark: number;
}

export function defaultSettings(): AppSettings {
  return {
    accentColor: "#ff6c37",
    uiFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    monoFont:
      "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    defaultTimeoutMs: 30_000,
    followRedirects: true,
    verifyTls: true,
    enforceSecure: false,
    defaultHttpVersion: "auto",
    maxStreamMessages: 500,
    runInBackground: false,
    startAtLogin: false,
    userName: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecurity: "starttls",
    smtpUsername: "",
    smtpFrom: "",
    smtpFromName: "APIKit",
    smtpDefaultTo: "",
  };
}

export function defaultAuth(): Auth {
  return {
    type: "none",
    token: "",
    username: "",
    password: "",
    key: "",
    value: "",
    addTo: "header",
  };
}

export function defaultConfig(): RequestConfig {
  return {
    protocol: "rest",
    httpVersion: "auto",
    bodyMode: "none",
    rawLanguage: "json",
    formData: [{ name: "", value: "" }],
    urlEncoded: [{ name: "", value: "" }],
    graphqlQuery: "",
    graphqlVariables: "{}",
    graphqlFiles: [],
    binaryFilePath: "",
    auth: defaultAuth(),
    streamMessage: "",
    mqttTopics: "#",
    mqttPublishTopic: "",
    mqttClientId: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttQos: 0,
    iceServers: "stun:stun.l.google.com:19302",
    docs: "",
    preScript: "",
    postScript: "",
    verifyTls: null,
    followRedirects: null,
    timeoutMs: null,
    maxRedirects: null,
    noReferer: false,
    noCookieJar: false,
  };
}

/** Fills in fields added after a workspace was first saved. */
export function normalizeConfig(config?: Partial<RequestConfig> | null): RequestConfig {
  const base = defaultConfig();
  if (!config) return base;
  return {
    ...base,
    ...config,
    auth: { ...base.auth, ...(config.auth ?? {}) },
    formData: config.formData?.length ? config.formData : base.formData,
    graphqlFiles: config.graphqlFiles ?? base.graphqlFiles,
    urlEncoded: config.urlEncoded?.length ? config.urlEncoded : base.urlEncoded,
  };
}

/** The editable payload of a request, shared by saved requests and open tabs. */
export interface RequestDraft {
  method: string;
  url: string;
  headers: Header[];
  body: string;
  tests: Assertion[];
  config: RequestConfig;
}

export interface Assertion {
  id: string;
  source: "status" | "responseTime" | "header" | "jsonBody" | "bodyText";
  /** Header name or JSON path, depending on `source`. */
  target: string;
  op:
    | "equals"
    | "notEquals"
    | "contains"
    | "lessThan"
    | "greaterThan"
    | "exists"
    | "matches";
  expected: string;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  actual: string;
  message: string;
}

export interface SavedRequest extends RequestDraft {
  kind: "request";
  id: string;
  name: string;
}

export interface Folder {
  kind: "folder";
  id: string;
  name: string;
  children: TreeNode[];
  /** Requests inside whose auth is "inherit" resolve to this. */
  auth?: Auth;
}

/** A collection is a list of these; folders nest arbitrarily deep. */
export type TreeNode = Folder | SavedRequest;

export interface RequestTab extends RequestDraft {
  id: string;
  /** Explicit tab title; `null` means "derive it from the URL". */
  name: string | null;
  /** Id of the saved request this tab edits, if any. */
  sourceId: string | null;
  reqTab: RequestTabKey;
  respTab: ResponseTabKey;

  /**
   * A preview tab is the one opened by a single click: it is replaced by the
   * next preview, and becomes permanent as soon as it is edited.
   */
  preview: boolean;

  // Runtime-only state — not persisted.
  response: HttpResponseData | null;
  error: string | null;
  loading: boolean;
  results: AssertionResult[];
  /** The request as sent, shown in the response's Request tab. */
  sent: SentRequest | null;
  scriptLogs: ScriptLogEntry[];
  stream: StreamSession;
}

// --- History -----------------------------------------------------------------

/** One sent request. Per machine, so it is not synced. */
export interface HistoryEntry {
  id: string;
  atMs: number;
  name: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  /** The request as sent, for reopening or saving to the collection. */
  request: RequestDraft;
  error: string | null;
}

// --- Comments ----------------------------------------------------------------

export interface Comment {
  id: string;
  requestId: string;
  /** Set when this is a reply to another comment. */
  parentId: string | null;
  author: string;
  body: string;
  createdAt: number;
}

// --- Monitoring --------------------------------------------------------------

export type MonitorTargetKind =
  | "request"
  | "folder"
  | "collection"
  | "url";

export interface Monitor {
  id: string;
  name: string;
  targetKind: MonitorTargetKind;
  targetId: string | null;
  intervalSecs: number;
  enabled: boolean;
  /** Environment to run against; null uses whichever is active. */
  environmentId: string | null;
  notify: boolean;
  /** Email when the monitor starts failing and again when it recovers. */
  emailNotify: boolean;
  /** Recipients, comma-separated. */
  emailTo: string;
  /** Email only after this many consecutive failed checks (flap damping). */
  emailAfter: number;
  /** Also email when the monitor turns healthy again. */
  emailRecovery: boolean;
  // Used when `targetKind` is "url" — an endpoint checked directly, without a
  // saved request behind it.
  method: string;
  url: string;
  headers: Header[];
  body: string;
  expectedStatus: number;
}

export interface MonitorRun {
  id: string;
  monitorId: string;
  atMs: number;
  ok: boolean;
  requests: number;
  failures: number;
  avgMs: number;
  detail: string;
}

export const MONITOR_INTERVALS: { value: number; label: string }[] = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "1 hour" },
];

// --- Load testing ------------------------------------------------------------

export type LoadTestKind =
  | "load"
  | "stress"
  | "spike"
  | "soak"
  | "assertions"
  | "chain";

export interface LoadPhase {
  label: string;
  vus: number;
  durationSecs: number;
}

export interface LoadConfig {
  request: HttpRequestSpec;
  phases: LoadPhase[];
  thinkTimeMs: number;
}

export interface PhaseReport {
  label: string;
  vus: number;
  durationSecs: number;
  requests: number;
  failures: number;
  statuses: [number, number][];
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rps: number;
}

export interface LoadReport {
  phases: PhaseReport[];
  totalRequests: number;
  totalFailures: number;
  durationMs: number;
  cancelled: boolean;
}

/**
 * A saved load test. Tests are listed in the sidebar like requests are in the
 * client, so a tuned soak or spike is kept rather than rebuilt each time.
 */
export interface LoadTest {
  id: string;
  name: string;
  kind: LoadTestKind;
  method: string;
  url: string;
  phases: LoadPhase[];
  thinkTimeMs: number;
  /** Iterations for the assertion suite. */
  iterations: number;
  /** Pinned environment; null follows whichever is active. */
  environmentId: string | null;
  /** Target folder for a chain test. */
  folderId: string | null;
}

export interface LoadProgress {
  phaseIndex: number;
  label: string;
  elapsedSecs: number;
  durationSecs: number;
  requests: number;
  failures: number;
  avgMs: number;
}

// --- Streaming sessions ------------------------------------------------------

export interface StreamEvent {
  sessionId: string;
  direction: "in" | "out" | "system";
  data: string;
  label: string | null;
  atMs: number;
}

export type StreamState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface StreamStatus {
  sessionId: string;
  state: Exclude<StreamState, "idle">;
  detail: string | null;
}

export interface ScriptLogEntry {
  phase: "pre" | "post";
  level: "log" | "error";
  message: string;
}

/** Runtime state of a tab's live connection. */
export interface StreamSession {
  sessionId: string | null;
  state: StreamState;
  detail: string | null;
  events: StreamEvent[];
}

export function emptySession(): StreamSession {
  return { sessionId: null, state: "idle", detail: null, events: [] };
}

export interface StreamConnectConfig {
  kind: string;
  url: string;
  headers: Header[];
  topics: string[];
  query: string;
  variables: string;
  clientId: string | null;
  username: string | null;
  password: string | null;
  qos: number;
}

export type RequestTabKey =
  | "params"
  | "auth"
  | "headers"
  | "body"
  | "tests"
  | "scripts"
  | "docs"
  | "comments"
  | "connection"
  | "settings";
export type ResponseTabKey =
  | "body"
  | "cookies"
  | "headers"
  | "request"
  | "tests";

/** What actually went over the wire, after variables, auth and scripts. */
export interface SentRequest {
  method: string;
  url: string;
  headers: Header[];
  body: string;
  /** Present when the body was sent as multipart. */
  parts?: { name: string; value: string; fileName?: string }[];
}

/** The persisted slice of a tab — response state is deliberately transient. */
export interface StoredTab extends Omit<RequestDraft, "config"> {
  id: string;
  name: string | null;
  sourceId: string | null;
  reqTab: RequestTabKey;
  /** Persisted as opaque JSON; normalized on load. */
  config: Partial<RequestConfig>;
}

/** A canned response served by the built-in mock server. */
export interface MockRoute {
  id: string;
  enabled: boolean;
  method: string;
  /** Path pattern; supports a trailing `*` wildcard. */
  path: string;
  status: number;
  headers: Header[];
  body: string;
  delayMs: number;
  /**
   * Routes live in folders. The tree is stored flat — a folder is an entry with
   * `isFolder`, everything points at its parent (null = root) — and depth-first
   * order is also the order routes are matched in.
   */
  parentId: string | null;
  isFolder: boolean;
  /** Folder name; routes are labelled by their path instead. */
  name: string;
  /** How the response is produced. */
  mode: MockMode;
  /** Base URL that "proxy" mode forwards to. */
  proxyTarget: string;
  /** Query pairs that must all be present, in `a=1&b=2` form. */
  matchQuery: string;
  /** Headers that must all be present with these values. */
  matchHeaders: Header[];
  /** Substring the request body must contain. */
  matchBody: string;
  /** Percentage of matching requests answered with a 500 instead. */
  failPercent: number;
  /** Answer preflights and add permissive CORS headers. */
  cors: boolean;
}

export type MockMode = "static" | "template" | "sequence" | "proxy" | "sse";

export const MOCK_MODES: { value: MockMode; label: string; blurb: string }[] = [
  {
    value: "static",
    label: "Static",
    blurb: "Always returns the body exactly as written.",
  },
  {
    value: "template",
    label: "Dynamic",
    blurb:
      "Substitutes {{uuid}}, {{now}}, {{timestamp}}, {{randomInt}}, {{method}}, {{path}}, {{body}}, {{query.name}} and {{header.name}} per request.",
  },
  {
    value: "sequence",
    label: "Sequence",
    blurb:
      "Cycles through bodies separated by a line containing ---, so successive calls differ. Useful for polling a job that eventually completes.",
  },
  {
    value: "proxy",
    label: "Proxy",
    blurb:
      "Forwards the request to a real server and returns its response, so part of an API can be mocked while the rest passes through.",
  },
  {
    value: "sse",
    label: "Event stream",
    blurb:
      "Streams the --- separated chunks as server-sent events, spaced by the delay, so a client consuming a live feed can be exercised.",
  },
];

export interface MockStatus {
  running: boolean;
  port: number | null;
  hitCount: number;
}

export interface MockHit {
  method: string;
  path: string;
  status: number;
  routeId: string | null;
  atMs: number;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
}

/** Everything one workspace holds, as returned by `load_workspace_data`. */
export interface WorkspaceData {
  tree: TreeNode[];
  environments: Environment[];
  tabs: StoredTab[];
  mockRoutes: MockRoute[];
  monitors: Monitor[];
  comments: Comment[];
  monitorRuns: MonitorRun[];
  settings: Record<string, string>;
}

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
