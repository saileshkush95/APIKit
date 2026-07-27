import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollectionSidebar } from "./CollectionSidebar";
import { ImportDialog } from "./ImportDialog";
import { save } from "@tauri-apps/plugin-dialog";
import { RequestPane } from "./RequestPane";
import { TabStrip } from "./TabStrip";
import {
  onStreamEvent,
  onStreamStatus,
  saveTabs,
  sendRequest,
  setSetting,
  writeTextFile,
  streamConnect,
  streamDisconnect,
  streamSend,
} from "../lib/api";
import { runAssertions } from "../lib/assertions";
import { usePersist } from "../lib/persist";
import { buildWireRequest, enforceSecureUrl } from "../lib/request";
import { runPostScript, runPreScript } from "../lib/scripts";
import {
  buildExport,
  serializeExport,
  suggestFilename,
} from "../lib/exportWorkspace";
import { newId, SETTINGS, workspaceDataOnce } from "../lib/storage";
import { interpolate } from "../lib/vars";
import {
  findRequest,
  insertNode,
  isFolder,
  pathTo,
  updateNode,
} from "../lib/tree";
import { requestLabel } from "../lib/ui";
import { useActiveRequest } from "../state/activeRequest";
import { useCollection } from "../state/collection";
import { useEnvironments } from "../state/environments";
import { useSettings } from "../state/settings";
import { useWorkspaceId, useWorkspaces } from "../state/workspaces";
import {
  defaultConfig,
  emptySession,
  isStreaming,
  normalizeConfig,
  type RequestDraft,
  type RequestTab,
  type SavedRequest,
  type ScriptLogEntry,
  type StoredTab,
  type TreeNode,
} from "../types";

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
    reqTab: "params",
    respTab: "body",
    response: null,
    error: null,
    loading: false,
    results: [],
    scriptLogs: [],
    stream: emptySession(),
    ...overrides,
  };
}

function blankRequest(name = "New Request"): SavedRequest {
  return {
    kind: "request",
    id: newId(),
    name,
    method: "GET",
    url: "",
    headers: [{ name: "", value: "" }],
    body: "",
    tests: [],
    config: defaultConfig(),
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
    respTab: "body",
    response: null,
    error: null,
    loading: false,
    results: [],
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
  /** Opens the runner on a folder (or the whole collection when null). */
  onRun: (folderId: string | null) => void;
}

export function ApiClient({ onRun }: ApiClientProps) {
  const workspaceId = useWorkspaceId();
  const { tree, setTree, expanded, toggleExpanded } = useCollection();
  const {
    vars,
    setVariables,
    environments,
    create: createEnvironment,
    update: updateEnvironment,
  } = useEnvironments();
  const { settings } = useSettings();
  const { setActive } = useActiveRequest();
  const { active: activeWorkspace } = useWorkspaces();

  const [tabs, setTabs] = useState<RequestTab[]>([blankTab()]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [importing, setImporting] = useState(false);

  // Read inside the stream listener, which is registered once.
  const maxMessagesRef = useRef(settings.maxStreamMessages);
  maxMessagesRef.current = settings.maxStreamMessages;

  useEffect(() => {
    let cancelled = false;
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
        }
      })
      .catch((e) => console.error("failed to load tabs", e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  usePersist(tabs, ready, (value) =>
    saveTabs(workspaceId, value.map(dehydrate)),
  );

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

  const updateTab = useCallback(
    (id: string, patch: Partial<RequestTab>) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
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

  /** Focuses an existing tab for a saved request, or opens a new one. */
  function openRequest(request: SavedRequest) {
    const existing = tabs.find((t) => t.sourceId === request.id);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    openTab(
      blankTab({
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
      }),
    );
  }

  function createRequest(parentId: string | null) {
    const request = blankRequest();
    setTree(insertNode(tree, parentId, request));
    if (parentId) toggleExpanded(parentId, true);
    openRequest(request);
  }

  /** Renames the tab, and the saved request behind it when there is one. */
  function renameTab(tab: RequestTab, name: string) {
    const trimmed = name.trim();
    if (trimmed === "") return;
    updateTab(tab.id, { name: trimmed });
    if (tab.sourceId && findRequest(tree, tab.sourceId)) {
      setTree(
        updateNode(tree, tab.sourceId, (node) =>
          isFolder(node) ? node : { ...node, name: trimmed },
        ),
      );
    }
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
    const name = tab.name ?? requestLabel(tab.url, "New Request");
    const request: SavedRequest = { ...blankRequest(name), ...draft, name };
    setTree(insertNode(tree, null, request));
    updateTab(tab.id, { sourceId: request.id, name });
  }

  async function send(tab: RequestTab) {
    updateTab(tab.id, { loading: true, error: null, scriptLogs: [] });

    const logs: ScriptLogEntry[] = [];
    const built = buildWireRequest(tab, vars);

    // Pre-request script may rewrite anything about the request.
    const pre = runPreScript(tab.config.preScript, built, vars);
    logs.push(
      ...pre.outcome.logs.map((entry) => ({ phase: "pre" as const, ...entry })),
    );
    if (pre.outcome.error) {
      logs.push({ phase: "pre", level: "error", message: pre.outcome.error });
    }
    setVariables(pre.outcome.variables);

    const wire = pre.request;
    try {
      const response = await sendRequest({
        method: wire.method,
        url: enforceSecureUrl(wire.url, settings.enforceSecure),
        headers: wire.headers.filter((h) => h.name.trim() !== ""),
        body: wire.body || null,
        timeoutMs: settings.defaultTimeoutMs,
        httpVersion: tab.config.httpVersion,
        verifyTls: settings.verifyTls,
        followRedirects: settings.followRedirects,
        multipart: built.multipart ?? null,
      });

      // Post-response script runs alongside the declarative assertions.
      const post = runPostScript(tab.config.postScript, response, {
        ...vars,
        ...pre.outcome.variables,
      });
      logs.push(
        ...post.logs.map((entry) => ({ phase: "post" as const, ...entry })),
      );
      if (post.error) {
        logs.push({ phase: "post", level: "error", message: post.error });
      }
      setVariables(post.variables);

      const results = [...runAssertions(tab.tests, response), ...post.tests];
      updateTab(tab.id, {
        response,
        results,
        scriptLogs: logs,
        error: null,
        loading: false,
        respTab: results.some((r) => !r.passed) ? "tests" : "body",
      });
    } catch (e) {
      updateTab(tab.id, {
        error: String(e),
        response: null,
        results: [],
        scriptLogs: logs,
        loading: false,
      });
    }
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
        headers: tab.headers.filter((h) => h.name.trim() !== ""),
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

  /** Writes the collection and environments to a file the user picks. */
  async function exportWorkspace() {
    const name = activeWorkspace?.name ?? "Workspace";
    const path = await save({
      title: "Export workspace",
      defaultPath: suggestFilename(name),
      filters: [{ name: "WebRequestKit", extensions: ["json"] }],
    });
    if (!path) return;
    const document = buildExport({ workspace: name, tree, environments });
    await writeTextFile(path, serializeExport(document));
  }

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
      <CollectionSidebar
        nodes={tree}
        onChange={(nodes: TreeNode[]) => setTree(nodes)}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        activeRequestId={activeRequestId}
        onOpen={openRequest}
        onCreateRequest={createRequest}
        onRequestsDeleted={unbindTabs}
        onRun={onRun}
        onImport={() => setImporting(true)}
        onExport={exportWorkspace}
      />

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImport={(nodes, environment) => {
            setTree([...tree, ...nodes]);
            // The spec's server URL and auth placeholders become a ready-to-use
            // environment, selected straight away.
            const created = createEnvironment(environment.name);
            updateEnvironment(created.id, { variables: environment.variables });
          }}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id ?? ""}
          dirtyIds={dirtyIds}
          onSelect={setActiveId}
          onClose={closeTab}
          onNew={newTab}
        />
        {activeTab && (
          <RequestPane
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
