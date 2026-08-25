import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CollectionSidebar } from "./CollectionSidebar";
import { HistoryPanel } from "./HistoryPanel";
import { ImportDialog } from "./ImportDialog";
import { save } from "@tauri-apps/plugin-dialog";
import { RequestPane } from "./RequestPane";
import { SIDEBAR_DEFAULT, SidebarShell } from "./SidebarShell";
import { TabStrip } from "./TabStrip";
import {
  cancelRequest,
  onStreamEvent,
  onStreamStatus,
  saveTabs,
  grpcCall,
  onGrpcMessage,
  sendRequest,
  setSetting,
  writeTextFile,
  streamConnect,
  streamDisconnect,
  streamSend,
} from "../../shared/lib/api";
import { runAssertions } from "../../shared/lib/assertions";
import { usePersist } from "../../shared/lib/persist";
import {
  buildWireRequest,
  enforceSecureUrl,
} from "../../shared/lib/request";
import { resolveInherited } from "../../shared/lib/inherit";
import { defaultLayout } from "../../shared/lib/paneLayout";
import { tlsFor } from "../../shared/lib/certificates";
import { currentAccessToken } from "../../shared/lib/oauth";
import { activeRows } from "../../shared/lib/rows";
import { runPostScript, runPreScript } from "../../shared/lib/scripts";
import {
  buildExport,
  normalizeDraft,
  serializeExport,
  suggestFilename,
} from "../../shared/lib/exportWorkspace";
import { newId, SETTINGS, workspaceDataOnce } from "../../shared/lib/storage";
import { buildStandaloneHtml } from "../../shared/lib/docsViewer";
import { interpolate } from "../../shared/lib/vars";
import {
  findRequest,
  insertNode,
  isFolder,
  parentIdOf,
  pathTo,
  siblingRequestNamed,
  uniqueRequestName,
  updateNode,
} from "../../shared/lib/tree";
import { requestLabel } from "../../shared/lib/ui";
import { useActiveRequest } from "../../shared/state/activeRequest";
import { notify, notifyError } from "../../shared/lib/notify";
import { useCollection } from "../../shared/state/collection";
import { useHandoff } from "../../shared/state/handoff";
import { logConsole } from "../../shared/state/console";
import {
  EXPORT_FORMATS,
  toOpenApi,
  toPostmanCollection,
  type ExportFormat,
} from "../../shared/lib/interop";
import { useHistory } from "../../shared/state/history";
import { useEnvironments } from "../../shared/state/environments";
import { useSettings } from "../../shared/state/settings";
import { useWorkspaceId, useWorkspaces } from "../../shared/state/workspaces";
import {
  defaultConfig,
  emptySession,
  isStreaming,
  normalizeConfig,
  type Protocol,
  type RequestDraft,
  type RequestTab,
  type SavedRequest,
  type HistoryEntry,
  type ScriptLogEntry,
  type SentRequest,
  type StoredTab,
  type TreeNode,
} from "../../shared/types";

function blankTab(overrides: Partial<RequestTab> = {}): RequestTab {
  return {
    id: newId(),
    name: null,
    sourceId: null,
    method: "GET",
    url: "",
    headers: [{ name: "", value: "" }],
    body: "",
    tests: [],
    config: defaultConfig(),
    preview: false,
    reqTab: "params",
    respTab: "body",
    // Stamped now rather than read as it renders: the arrangement is the
    // tab's own from the start, so arranging one request never moves another.
    layout: defaultLayout(),
    response: null,
    error: null,
    loading: false,
    results: [],
    sent: null,
    scriptLogs: [],
    stream: emptySession(),
    ...overrides,
  };
}

function blankRequest(
  name = "New Request",
  protocol: Protocol = "rest",
  method = "GET",
): SavedRequest {
  return {
    kind: "request",
    id: newId(),
    name,
    method: protocol === "graphql" ? "POST" : method,
    url: "",
    headers: [{ name: "", value: "" }],
    body: "",
    tests: [],
    config: {
      ...defaultConfig(),
      protocol,
      ...(protocol === "graphql" ? { bodyMode: "graphql" as const } : {}),
    },
  };
}

function hydrate(stored: StoredTab): RequestTab {
  return {
    ...stored,
    headers: stored.headers.length
      ? stored.headers
      : [{ name: "", value: "" }],
    tests: stored.tests ?? [],
    config: normalizeConfig(stored.config),
    preview: false,
    respTab: "body",
    response: null,
    error: null,
    loading: false,
    results: [],
    sent: null,
    scriptLogs: [],
    stream: emptySession(),
  };
}

function dehydrate(tab: RequestTab): StoredTab {
  return {
    id: tab.id,
    name: tab.name,
    sourceId: tab.sourceId,
    method: tab.method,
    url: tab.url,
    headers: tab.headers,
    body: tab.body,
    tests: tab.tests,
    config: tab.config,
    reqTab: tab.reqTab,
    split: tab.split,
    layout: tab.layout,
  };
}

function draftOf(source: RequestDraft): RequestDraft {
  return {
    method: source.method,
    url: source.url,
    // Trailing blank rows are an editing artefact, not a real difference.
    headers: source.headers.filter((h) => h.name !== "" || h.value !== ""),
    body: source.body,
    tests: source.tests,
    config: source.config,
  };
}

function sameDraft(a: RequestDraft, b: RequestDraft): boolean {
  return JSON.stringify(draftOf(a)) === JSON.stringify(draftOf(b));
}

interface ApiClientProps {
  /** A request from the welcome screen; the timestamp makes it repeatable. */
  intent?: { kind: "new" | "import"; at: number } | null;
}

export function ApiClient({ intent }: ApiClientProps) {
  const navigate = useNavigate();
  const onRun = (folderId: string | null) =>
    navigate({ to: "/runner", search: folderId ? { folder: folderId } : {} });
  const workspaceId = useWorkspaceId();
  const {
    tree,
    setTree,
    collectionDefaults,
    setCollectionDefaults,
    ready: collectionReady,
    expanded,
    toggleExpanded,
  } = useCollection();
  const {
    vars,
    setVariables,
    environments,
    collectionVariables,
    activeId: activeEnvironmentId,
    create: createEnvironment,
    update: updateEnvironment,
  } = useEnvironments();
  const { settings } = useSettings();
  const { record } = useHistory();
  const { setActive } = useActiveRequest();
  const { active: activeWorkspace } = useWorkspaces();

  const [tabs, setTabs] = useState<RequestTab[]>([blankTab()]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sidebar, setSidebar] = useState<"collection" | "history">("collection");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Read inside the stream listener, which is registered once.
  const maxMessagesRef = useRef(settings.maxStreamMessages);
  maxMessagesRef.current = settings.maxStreamMessages;

  useEffect(() => {
    let cancelled = false;
    // Synchronously, before the load: tabs still hold the previous workspace's
    // requests, and leaving `ready` true would let the debounced save write
    // them into the workspace being switched *to*.
    setReady(false);

    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        const restored = workspace.tabs.map(hydrate);
        if (restored.length > 0) {
          setTabs(restored);
          const saved = workspace.settings[SETTINGS.activeTab];
          setActiveId(
            saved && restored.some((t) => t.id === saved)
              ? saved
              : restored[0].id,
          );
        } else {
          // A workspace with nothing open starts blank; without this the
          // previous workspace's tabs would simply stay on screen.
          const blank = blankTab();
          setTabs([blank]);
          setActiveId(blank.id);
        }

        const width = Number(workspace.settings[SETTINGS.sidebarWidth]);
        if (Number.isFinite(width) && width > 0) setSidebarWidth(width);
        setSidebarCollapsed(
          workspace.settings[SETTINGS.sidebarCollapsed] === "true",
        );
      })
      .catch((e) => notifyError("Could not restore open tabs", e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  usePersist(tabs, ready, (value) =>
    saveTabs(workspaceId, value.map(dehydrate)),
  );

  useEffect(() => {
    if (!ready) return;
    setSetting(
      workspaceId,
      SETTINGS.sidebarCollapsed,
      String(sidebarCollapsed),
    ).catch(() => {});
  }, [ready, workspaceId, sidebarCollapsed]);

  // Messages of a gRPC server stream, logged as they arrive. The response pane
  // only gets the collected array when the call ends, so without this a
  // long-lived stream would look like a hung request the whole time.
  useEffect(() => {
    const unlisten = onGrpcMessage((message) => {
      logConsole({
        level: "response",
        source: "gRPC stream",
        message: `#${message.index + 1}`,
        detail: { body: message.body },
      });
    });
    return () => {
      unlisten.then((un) => un()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Debounced, because this one *does* change continuously while dragging.
    const timer = setTimeout(() => {
      setSetting(
        workspaceId,
        SETTINGS.sidebarWidth,
        String(Math.round(sidebarWidth)),
      ).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, workspaceId, sidebarWidth]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  useEffect(() => {
    if (ready && activeTab) {
      setSetting(workspaceId, SETTINGS.activeTab, activeTab.id).catch(() => {});
    }
  }, [ready, activeTab?.id, workspaceId]);

  // Published so the load-test panel can offer "use active request".
  useEffect(() => {
    setActive(
      activeTab
        ? {
            name: activeTab.name ?? requestLabel(activeTab.url),
            method: activeTab.method,
            url: activeTab.url,
            headers: activeTab.headers,
            body: activeTab.body,
            tests: activeTab.tests,
            config: activeTab.config,
          }
        : null,
    );
  }, [activeTab, setActive]);

  /** Fields whose change means the user is working in the tab, not just looking. */
  const EDITS: (keyof RequestTab)[] = [
    "method",
    "url",
    "headers",
    "body",
    "tests",
    "config",
    "name",
  ];

  const updateTab = useCallback(
    (id: string, patch: Partial<RequestTab>) => {
      const edited = EDITS.some((field) => field in patch);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === id
            ? { ...tab, ...patch, preview: edited ? false : tab.preview }
            : tab,
        ),
      );
    },
    [],
  );

  const openTab = useCallback((tab: RequestTab) => {
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const newTab = useCallback(() => openTab(blankTab()), [openTab]);

  function closeTab(id: string) {
    setTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      const next = remaining.length > 0 ? remaining : [blankTab()];
      if (id === activeId) {
        const index = prev.findIndex((t) => t.id === id);
        const fallback = next[Math.min(index, next.length - 1)];
        setActiveId(fallback.id);
      }
      return next;
    });
  }

  /**
   * Opens a request. A single click opens it as a preview, which the next
   * single click replaces — so browsing a collection does not leave a trail of
   * tabs. Editing it, or a double click, makes it stay.
   */
  function openRequest(request: SavedRequest, { keep = false } = {}) {
    const existing = tabs.find((t) => t.sourceId === request.id);
    if (existing) {
      setActiveId(existing.id);
      // A second click on the tab you are already previewing keeps it.
      if (keep && existing.preview) {
        updateTab(existing.id, { preview: false });
      }
      return;
    }

    const opened = blankTab({
      name: request.name,
      sourceId: request.id,
      method: request.method,
      url: request.url,
      headers: request.headers.length
        ? [...request.headers, { name: "", value: "" }]
        : [{ name: "", value: "" }],
      body: request.body,
      tests: request.tests ?? [],
      config: normalizeConfig(request.config),
      preview: !keep,
    });

    const replaceable = tabs.find((tab) => tab.preview);
    if (!keep && replaceable) {
      // Reuse the preview slot so its position in the strip is kept.
      setTabs((prev) =>
        prev.map((tab) => (tab.id === replaceable.id ? opened : tab)),
      );
      setActiveId(opened.id);
      return;
    }
    openTab(opened);
  }

  function createRequest(
    parentId: string | null,
    protocol: Protocol = "rest",
    method = "GET",
  ) {
    const request = blankRequest(
      uniqueRequestName(tree, parentId, "New Request"),
      protocol,
      method,
    );
    setTree(insertNode(tree, parentId, request));
    if (parentId) toggleExpanded(parentId, true);
    openRequest(request, { keep: true });
  }

  /** Renames the tab, and the saved request behind it when there is one. */
  function renameTab(tab: RequestTab, name: string) {
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (!tab.sourceId || !findRequest(tree, tab.sourceId)) {
      updateTab(tab.id, { name: trimmed });
      return;
    }
    // Uniqueness is scoped to the request's sibling, so a name already used by
    // another request in the same folder is refused rather than silently split.
    if (
      siblingRequestNamed(
        tree,
        parentIdOf(tree, tab.sourceId),
        trimmed,
        tab.sourceId,
      )
    ) {
      notify(
        "error",
        `A request named “${trimmed}” already exists in this folder`,
      );
      const saved = findRequest(tree, tab.sourceId);
      if (saved) updateTab(tab.id, { name: saved.name });
      return;
    }
    updateTab(tab.id, { name: trimmed });
    setTree(
      updateNode(tree, tab.sourceId, (node) =>
        isFolder(node) ? node : { ...node, name: trimmed },
      ),
    );
  }

  /** Writes the active tab back to its saved request, creating one if needed. */
  function saveTab(tab: RequestTab) {
    const draft = draftOf(tab);
    if (tab.sourceId && findRequest(tree, tab.sourceId)) {
      setTree(
        updateNode(tree, tab.sourceId, (node) =>
          isFolder(node) ? node : { ...node, ...draft, name: node.name },
        ),
      );
      return;
    }
    const name = uniqueRequestName(
      tree,
      null,
      tab.name ?? requestLabel(tab.url, "New Request"),
    );
    const request: SavedRequest = { ...blankRequest(name), ...draft, name };
    setTree(insertNode(tree, null, request));
    updateTab(tab.id, { sourceId: request.id, name });
  }

  async function send(tab: RequestTab) {
    updateTab(tab.id, { loading: true, error: null, scriptLogs: [] });
    // gRPC speaks protobuf over HTTP/2 and is answered by its own command; the
    // rest of the pipeline — scripts, assertions, history — does not apply.
    if (tab.config.protocol === "grpc") {
      await sendGrpc(tab);
      return;
    }
    logConsole({
      level: "request",
      source: "Client",
      message: tab.url,
      detail: { method: tab.method, url: tab.url },
    });

    const logs: ScriptLogEntry[] = [];
    // "Inherit from parent" resolves against the folder tree at send time,
    // so moving a request re-resolves without touching the request itself.
    // Auth, headers, request options and the surrounding scripts all resolve
    // against the tree at send time, so moving a request into another folder
    // changes what it inherits without touching the request itself.
    const inherited = resolveInherited(tree, tab.sourceId, collectionDefaults, tab);
    const { config, headers } = inherited;
    const oauth = await currentAccessToken(config.auth, vars);
    const built = buildWireRequest({ ...tab, config, headers }, vars, oauth);

    // Pre-request scripts may rewrite anything about the request: the folders'
    // and the collection's from the outside in, then the request's own.
    let wire = built;
    const written: Record<string, string> = {};
    for (const source of [...inherited.preScripts, config.preScript]) {
      const step = runPreScript(source, wire, { ...vars, ...written });
      wire = step.request;
      Object.assign(written, step.outcome.variables);
      logs.push(
        ...step.outcome.logs.map((entry) => ({ phase: "pre" as const, ...entry })),
      );
      if (step.outcome.error) {
        logs.push({ phase: "pre", level: "error", message: step.outcome.error });
      }
    }
    setVariables(written);
    const sentUrl = enforceSecureUrl(wire.url, settings.enforceSecure);
    const sentHeaders = activeRows(wire.headers);
    const sent: SentRequest = {
      method: wire.method,
      url: sentUrl,
      headers: sentHeaders,
      // A file body has no text to show, so name the file instead — otherwise
      // the "what was sent" view would claim the body was empty.
      body: built.bodyFilePath ? `<file: ${built.bodyFilePath}>` : wire.body,
      parts: built.multipart?.map((part) => ({
        name: part.name,
        value: part.value,
        fileName: part.filePath ?? undefined,
      })),
    };

    try {
      const response = await sendRequest({
        method: wire.method,
        url: sentUrl,
        headers: sentHeaders,
        body: wire.body || null,
        // Per-request settings win over the global defaults.
        timeoutMs: config.timeoutMs ?? settings.defaultTimeoutMs,
        httpVersion: config.httpVersion,
        verifyTls: config.verifyTls ?? settings.verifyTls,
        followRedirects: config.followRedirects ?? settings.followRedirects,
        maxRedirects: config.maxRedirects,
        noReferer: config.noReferer,
        noCookieJar: config.noCookieJar,
        ...tlsFor(wire.url, settings),
        multipart: built.multipart ?? null,
        bodyFilePath: built.bodyFilePath ?? null,
        // The tab id doubles as the cancel handle: one in-flight request per
        // tab is all the UI allows.
        cancelId: tab.id,
      });

      // Post-response scripts run alongside the declarative assertions: the
      // request's own first, then outwards through the folders and collection.
      const scriptTests = [];
      for (const source of [config.postScript, ...inherited.postScripts]) {
        const post = runPostScript(source, response, { ...vars, ...written });
        Object.assign(written, post.variables);
        logs.push(
          ...post.logs.map((entry) => ({ phase: "post" as const, ...entry })),
        );
        if (post.error) {
          logs.push({ phase: "post", level: "error", message: post.error });
        }
        scriptTests.push(...post.tests);
      }
      setVariables(written);

      record(tab.name ?? requestLabel(tab.url), draftOf(tab), { response });

      // Script output goes to the console too, so a chained run reads in one
      // place rather than one tab at a time.
      for (const entry of logs) {
        logConsole({
          level: entry.level === "error" ? "error" : "log",
          source: `Script ${entry.phase}`,
          message: entry.message,
        });
      }
      logConsole({
        level: "response",
        source: "Client",
        message: `${response.status} ${response.statusText} — ${tab.url}`,
        detail: {
          method: tab.method,
          url: tab.url,
          status: response.status,
          timeMs: response.timeMs,
          sizeBytes: response.sizeBytes,
          headers: response.headers,
          body: response.body,
        },
      });

      const results = [...runAssertions(tab.tests, response), ...scriptTests];
      updateTab(tab.id, {
        response,
        results,
        sent,
        scriptLogs: logs,
        error: null,
        loading: false,
        respTab: results.some((r) => !r.passed) ? "tests" : "body",
      });
    } catch (e) {
      const message = String(e);
      logConsole({
        level: "error",
        source: "Client",
        message: `${message} — ${tab.url}`,
        detail: { method: tab.method, url: tab.url },
      });
      // A cancel is the user's own doing, not something to keep in history.
      if (message !== "Request canceled") {
        record(tab.name ?? requestLabel(tab.url), draftOf(tab), {
          error: message,
        });
      }
      updateTab(tab.id, {
        error: message,
        response: null,
        results: [],
        // Kept on failure too: seeing what was sent is how you find out why.
        sent,
        scriptLogs: logs,
        loading: false,
      });
    }
  }

  /**
   * The Headers tab as it goes out, for the transports that take a plain list
   * rather than going through `buildWireRequest`: gRPC metadata and the
   * streaming handshake. Inheritance applies to them for the same reason it
   * applies to a REST send — it is the same tab — and the values are resolved
   * here because those two paths never reach the interpolation step that the
   * REST path gets from `buildWireRequest`.
   */
  function outgoingHeaders(tab: RequestTab) {
    return activeRows(
      resolveInherited(tree, tab.sourceId, collectionDefaults, tab).headers,
    ).map((row) => ({
      name: interpolate(row.name, vars),
      value: interpolate(row.value, vars),
    }));
  }

  /** A unary gRPC call, rendered into the same response pane. */
  async function sendGrpc(tab: RequestTab) {
    const target = interpolate(tab.url, vars);
    const method = interpolate(tab.config.grpcMethod, vars);
    const metadata = outgoingHeaders(tab);
    const sent = {
      method: "POST",
      url: `${target}/${method}`,
      headers: metadata,
      body: tab.body,
    };
    logConsole({
      level: "request",
      source: "gRPC",
      message: `${method} — ${target}`,
      detail: { method: "gRPC", url: target },
    });
    try {
      const reply = await grpcCall({
        target,
        method,
        body: interpolate(tab.body, vars),
        metadata,
        timeoutMs: tab.config.timeoutMs ?? settings.defaultTimeoutMs,
        plaintext: tab.config.grpcPlaintext,
        protoFiles: tab.config.grpcProtoFiles ?? [],
        importPaths: tab.config.grpcImportPaths ?? [],
        // Tags the stream events so a reply cannot be attributed to the wrong
        // tab when two streams are open at once.
        callId: tab.id,
      });
      logConsole({
        level: "response",
        source: "gRPC",
        message: `OK — ${method}`,
        detail: { url: target, timeMs: reply.timeMs, body: reply.body },
      });
      updateTab(tab.id, {
        response: {
          status: 200,
          statusText: reply.status,
          headers: reply.metadata,
          body: reply.body,
          timeMs: reply.timeMs,
          sizeBytes: new TextEncoder().encode(reply.body).length,
          finalUrl: target,
          httpVersion: "HTTP/2.0",
        },
        results: [],
        sent,
        error: null,
        loading: false,
        respTab: "body",
      });
    } catch (e) {
      const message = String(e);
      logConsole({ level: "error", source: "gRPC", message });
      updateTab(tab.id, {
        error: message,
        response: null,
        results: [],
        loading: false,
        sent,
      });
    }
  }

  function cancelSend(tab: RequestTab) {
    // The backend resolves the pending send with "Request canceled";
    // the normal error path then clears the loading state.
    cancelRequest(tab.id).catch(() => {});
  }

  // --- Streaming protocols ---------------------------------------------------

  // Session events are routed to whichever tab owns the session id.
  useEffect(() => {
    const unlistenEvent = onStreamEvent((event) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.stream.sessionId === event.sessionId
            ? {
                ...tab,
                // Bounded so a chatty topic cannot grow the tab forever.
                stream: {
                  ...tab.stream,
                  events: [...tab.stream.events, event].slice(
                    -maxMessagesRef.current,
                  ),
                },
              }
            : tab,
        ),
      );
    });

    const unlistenStatus = onStreamStatus((status) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.stream.sessionId === status.sessionId
            ? {
                ...tab,
                stream: {
                  ...tab.stream,
                  state: status.state,
                  detail: status.detail,
                },
              }
            : tab,
        ),
      );
    });

    return () => {
      unlistenEvent.then((un) => un());
      unlistenStatus.then((un) => un());
    };
  }, []);

  async function toggleConnection(tab: RequestTab) {
    if (tab.stream.sessionId) {
      await streamDisconnect(tab.stream.sessionId).catch(() => {});
      updateTab(tab.id, {
        stream: { ...tab.stream, sessionId: null, state: "closed" },
      });
      return;
    }

    const { config } = tab;
    updateTab(tab.id, {
      stream: { ...emptySession(), state: "connecting" },
    });
    try {
      const sessionId = await streamConnect({
        kind: config.protocol,
        url: enforceSecureUrl(interpolate(tab.url, vars), settings.enforceSecure),
        headers: outgoingHeaders(tab),
        topics: config.mqttTopics
          .split(",")
          .map((topic) => topic.trim())
          .filter(Boolean),
        query: config.graphqlQuery,
        variables: config.graphqlVariables,
        clientId: config.mqttClientId || null,
        username: config.mqttUsername || null,
        password: config.mqttPassword || null,
        qos: config.mqttQos,
      });
      updateTab(tab.id, {
        stream: { ...emptySession(), sessionId, state: "connecting" },
      });
    } catch (e) {
      updateTab(tab.id, {
        stream: { ...emptySession(), state: "error", detail: String(e) },
      });
    }
  }

  async function sendStreamMessage(tab: RequestTab) {
    if (!tab.stream.sessionId) return;
    try {
      await streamSend(tab.stream.sessionId, {
        text: interpolate(tab.config.streamMessage, vars),
        topic: tab.config.mqttPublishTopic || null,
      });
    } catch (e) {
      updateTab(tab.id, {
        stream: { ...tab.stream, state: "error", detail: String(e) },
      });
    }
  }

  useEffect(() => {
    if (!intent) return;
    if (intent.kind === "import") setImporting(true);
    else createRequest(null);
    // `at` changes each time, so asking twice works.
  }, [intent?.at]);

  // A request handed over from another view — a flow captured by the proxy.
  //
  // Deliberately waits for both loads: restoring saved tabs replaces the whole
  // tab list, and the collection starts empty until its own load lands — so
  // acting early would either discard the tab or save into a tree about to be
  // overwritten. Taken once, so coming back here later does not reopen it.
  // Subscribed rather than read once at mount: a handoff can also arrive while
  // the client is already open — opening a URL found in a response, say.
  const pendingHandoff = useHandoff((s) => s.pending);
  useEffect(() => {
    if (!ready || !collectionReady || !pendingHandoff) return;
    const handoff = useHandoff.getState().take();
    if (!handoff) return;
    if (handoff.kind === "saved") {
      const request = findRequest(tree, handoff.requestId);
      // Gone by the time we got here — deleted, or on another machine's sync.
      if (request) openRequest(request, { keep: true });
      else notifyError("That request no longer exists", "");
      return;
    }
    if (handoff.save) {
      const request: SavedRequest = {
        ...blankRequest(handoff.name),
        ...normalizeDraft(handoff.draft),
        name: handoff.name,
      };
      setTree(insertNode(tree, null, request));
      notify("success", `Saved “${handoff.name}” to the collection`);
    } else {
      openDraft(handoff.name, handoff.draft);
    }
  }, [ready, collectionReady, pendingHandoff]);

  /** Opens a draft as a preview tab, replacing any preview tab already open. */
  function openDraft(name: string, source: RequestDraft) {
    const draft = normalizeDraft(source);
    const opened = blankTab({
      name,
      method: draft.method,
      url: draft.url,
      headers: [...draft.headers, { name: "", value: "" }],
      body: draft.body,
      tests: draft.tests,
      config: draft.config,
      preview: true,
    });

    const replaceable = tabs.find((tab) => tab.preview);
    if (replaceable) {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === replaceable.id ? opened : tab)),
      );
      setActiveId(opened.id);
      return;
    }
    openTab(opened);
  }

  /** Reopens a recorded request exactly as it was sent. */
  function openHistoryEntry(entry: HistoryEntry) {
    openDraft(entry.name || requestLabel(entry.url), entry.request);
  }

  /** Promotes a recorded request into the collection. */
  function saveHistoryEntry(entry: HistoryEntry) {
    const draft = normalizeDraft(entry.request);
    const name = uniqueRequestName(
      tree,
      null,
      entry.name || requestLabel(entry.url, "Saved request"),
    );
    const request: SavedRequest = { ...blankRequest(name), ...draft, name };
    setTree(insertNode(tree, null, request));
    notify("success", `Saved “${name}” to the collection`);
  }

  /**
   * Writes the collection to a file the user picks, in one of three formats.
   *
   * The native format is lossless; the other two can only carry what Postman
   * and OpenAPI have a place for, so whatever was dropped is reported rather
   * than left to be discovered later. Every format redacts credentials.
   */
  async function exportWorkspace(format: ExportFormat) {
    const name = activeWorkspace?.name ?? "Workspace";
    const pinned = environments.find((env) => env.id === activeEnvironmentId);

    const document =
      format === "postman"
        ? toPostmanCollection(
            name,
            tree,
            pinned ?? environments[0],
            collectionDefaults ?? undefined,
          )
        : format === "openapi"
          ? toOpenApi(name, tree)
          : format === "html"
            ? {
                text: buildStandaloneHtml(
                  {
                    kind: "collection",
                    name,
                    defaults: collectionDefaults ?? {},
                    tree,
                  },
                  {
                    environments,
                    collectionVariables,
                    activeEnvironmentId,
                  },
                ),
                filename: `${name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "") || "collection"}.html`,
                warnings: [] as string[],
              }
            : {
                text: serializeExport(
                  buildExport({
                    workspace: name,
                    tree,
                    environments,
                    collectionVariables,
                    collectionDefaults,
                  }),
                ),
                filename: suggestFilename(name),
                warnings: [] as string[],
              };

    const path = await save({
      title: EXPORT_FORMATS.find((entry) => entry.value === format)?.title,
      defaultPath: document.filename,
      filters:
        format === "html"
          ? [{ name: "HTML", extensions: ["html"] }]
          : [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;

    await writeTextFile(path, document.text);

    if (document.warnings.length > 0) {
      notify("info", `Exported with ${document.warnings.length} note${document.warnings.length === 1 ? "" : "s"}`);
      for (const warning of document.warnings) {
        logConsole({ level: "log", source: "Export", message: warning });
      }
    } else {
      notify("success", `Exported “${name}”`);
    }
  }

  // A tab carries its own name so that an unsaved one can have any name at
  // all, which left it holding the old one after its saved request was renamed
  // from the sidebar. The name is not part of `draftOf`, so following the tree
  // here cannot make a tab look unsaved.
  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (!tab.sourceId) return tab;
        const saved = findRequest(tree, tab.sourceId);
        if (!saved || saved.name === tab.name) return tab;
        changed = true;
        return { ...tab, name: saved.name };
      });
      return changed ? next : prev;
    });
  }, [tree]);

  // Tabs unbind rather than vanish when their saved request is deleted, so
  // in-flight edits are never lost.
  const unbindTabs = useCallback((ids: string[]) => {
    const removed = new Set(ids);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.sourceId && removed.has(tab.sourceId)
          ? { ...tab, sourceId: null }
          : tab,
      ),
    );
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        newTab();
      } else if (key === "b") {
        e.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      } else if (key === "s") {
        e.preventDefault();
        if (activeTab) saveTab(activeTab);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!activeTab || !activeTab.url) return;
        if (isStreaming(activeTab.config.protocol)) toggleConnection(activeTab);
        else send(activeTab);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dirtyIds = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of tabs) {
      if (!tab.sourceId) continue;
      const saved = findRequest(tree, tab.sourceId);
      if (saved && !sameDraft(tab, saved)) dirty.add(tab.id);
    }
    return dirty;
  }, [tabs, tree]);

  const activeRequestId = activeTab?.sourceId ?? null;
  const breadcrumb = activeRequestId ? pathTo(tree, activeRequestId) : [];

  return (
    <div className="flex min-h-0 w-full">
      <SidebarShell
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        header={(
          [
            ["collection", "Collection"],
            ["history", "History"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSidebar(key)}
            className={`flex-1 px-2 py-1.5 text-xs ${
              sidebar === key
                ? "border-b-2 border-brand text-ink"
                : "border-b-2 border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      >
        {sidebar === "history" ? (
          <HistoryPanel
            onOpen={(entry) => openHistoryEntry(entry)}
            onSave={(entry) => saveHistoryEntry(entry)}
          />
        ) : (
      <CollectionSidebar
        nodes={tree}
        onChange={(nodes: TreeNode[]) => setTree(nodes)}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        activeRequestId={activeRequestId}
        onOpen={(request) => openRequest(request)}
        onOpenPermanent={(request) => openRequest(request, { keep: true })}
        onCreateRequest={createRequest}
        onRequestsDeleted={unbindTabs}
        onRun={onRun}
        onImport={() => setImporting(true)}
        onExport={exportWorkspace}
      />
        )}
      </SidebarShell>

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImport={(nodes, environment, defaults) => {
            setTree([...tree, ...nodes]);
            // The spec's server URL and auth placeholders become a ready-to-use
            // environment, selected straight away.
            const created = createEnvironment(environment.name);
            updateEnvironment(created.id, { variables: environment.variables });
            // A Postman collection's own description and headers become the
            // workspace defaults, so they flow down to the imported requests.
            if (defaults) {
              setCollectionDefaults({ ...collectionDefaults, ...defaults });
            }
          }}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id ?? ""}
          dirtyIds={dirtyIds}
          onSelect={setActiveId}
          onKeep={(id) => updateTab(id, { preview: false })}
          onClose={closeTab}
          onNew={newTab}
        />
        {activeTab && (
          <RequestPane
            onCancel={() => activeTab && cancelSend(activeTab)}
            tab={activeTab}
            onChange={(patch) => updateTab(activeTab.id, patch)}
            onSend={() => send(activeTab)}
            onSave={() => saveTab(activeTab)}
            onRename={(name) => renameTab(activeTab, name)}
            onToggleConnection={() => toggleConnection(activeTab)}
            onStreamSend={() => sendStreamMessage(activeTab)}
            onClearStream={() =>
              updateTab(activeTab.id, {
                stream: { ...activeTab.stream, events: [] },
              })
            }
            dirty={dirtyIds.has(activeTab.id)}
            breadcrumb={breadcrumb}
          />
        )}
      </div>
    </div>
  );
}
