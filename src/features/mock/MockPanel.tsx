import { Input, Select } from "../../shared/components/Field";
import { ItemTabs } from "../../shared/components/ItemTabs";
import { Toggle } from "../../shared/components/Toggle";
import { useEffect, useState } from "react";
import { RouteContextMenu, type MenuState } from "./RouteContextMenu";
import { RouteTree } from "./RouteTree";
import {
  descendantIds,
  flatten,
  moveInto,
  removeWithChildren,
  reorder,
  searchVisible,
} from "./routeOps";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import {
  applyMockRoutes,
  loadWorkspaceData,
  mockStatus,
  onMockHit,
  saveMockRoutes,
  setSetting,
  startMockServer,
  stopMockServer,
} from "../../shared/lib/api";
import {
  matchHeaders,
  matchHeaderValues,
  RESPONSE_HEADERS,
} from "../../shared/lib/headerSuggestions";
import { usePersist } from "../../shared/lib/persist";
import { newId, SETTINGS } from "../../shared/lib/storage";
import { methodColor, statusColor } from "../../shared/lib/ui";
import { useWorkspaceId } from "../../shared/state/workspaces";
import {
  MOCK_MODES,
  type MockHit,
  type MockMode,
  type MockRoute,
  type MockStatus,
} from "../../shared/types";
import { notifyError } from "../../shared/lib/notify";

const MOCK_METHODS = [
  "ANY",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

function newRoute(parentId: string | null = null): MockRoute {
  return {
    id: newId(),
    enabled: true,
    method: "GET",
    path: "/api/example",
    status: 200,
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{\n  "ok": true\n}',
    delayMs: 0,
    parentId,
    isFolder: false,
    name: "",
    mode: "static",
    proxyTarget: "",
    matchQuery: "",
    matchHeaders: [],
    matchBody: "",
    failPercent: 0,
    cors: true,
  };
}

function newFolder(parentId: string | null = null): MockRoute {
  return {
    ...newRoute(parentId),
    isFolder: true,
    name: "New folder",
    path: "",
    body: "",
    headers: [],
  };
}


export function MockPanel() {
  const workspaceId = useWorkspaceId();
  const [routes, setRoutes] = useState<MockRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Routes opened as tabs, like the client's open requests.
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [editorTab, setEditorTab] = useState<
    "body" | "headers" | "matching" | "behaviour"
  >("body");

  const [status, setStatus] = useState<MockStatus>({
    running: false,
    port: null,
    hitCount: 0,
  });
  const [port, setPort] = useState(3001);
  const [hits, setHits] = useState<MockHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A fresh read, not the shared once-per-session snapshot: that snapshot is
    // taken at startup, so a second visit would load the routes from before
    // this session's edits — and persistence would write them back over the
    // newer ones.
    loadWorkspaceData(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        // Rows saved before folders existed have no parent; normalise so the
        // tree walk sees them at the root.
        setRoutes(
          workspace.mockRoutes.map((route) => ({
            ...route,
            parentId: route.parentId ?? null,
            isFolder: route.isFolder ?? false,
            name: route.name ?? "",
            mode: route.mode || "static",
            proxyTarget: route.proxyTarget ?? "",
            matchQuery: route.matchQuery ?? "",
            matchHeaders: route.matchHeaders ?? [],
            matchBody: route.matchBody ?? "",
            failPercent: route.failPercent ?? 0,
            cors: route.cors ?? false,
          })),
        );
        const first = workspace.mockRoutes.find((route) => !route.isFolder);
        setSelectedId(first?.id ?? null);
        // Seed the tab strip too, or the selected route would have no tab.
        setOpenIds(first ? [first.id] : []);
        const savedPort = Number(workspace.settings[SETTINGS.mockPort]);
        if (Number.isFinite(savedPort) && savedPort > 0) setPort(savedPort);
      })
      .catch((e) => notifyError("Could not load mock routes", e))
      .finally(() => !cancelled && setReady(true));

    mockStatus().then(setStatus).catch(() => {});
    const unlisten = onMockHit((hit) =>
      setHits((prev) => [hit, ...prev].slice(0, 200)),
    );

    return () => {
      cancelled = true;
      unlisten.then((un) => un());
    };
  }, [workspaceId]);

  // Persisted, and pushed to the running server so edits apply immediately.
  usePersist(routes, ready, async (value) => {
    await saveMockRoutes(workspaceId, value);
    await applyMockRoutes(value);
  });

  useEffect(() => {
    if (!status.running) return;
    const timer = setInterval(() => {
      mockStatus().then(setStatus).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [status.running]);

  async function toggleServer() {
    setBusy(true);
    setError(null);
    try {
      if (status.running) {
        await stopMockServer();
      } else {
        await startMockServer(workspaceId, port);
        await applyMockRoutes(routes);
        await setSetting(workspaceId, SETTINGS.mockPort, String(port));
      }
      setStatus(await mockStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function update(id: string, patch: Partial<MockRoute>) {
    setRoutes((prev) => {
      // The matcher reads each route's own flag, so switching a folder off has
      // to reach the routes inside it.
      const cascade =
        patch.enabled !== undefined &&
        prev.find((route) => route.id === id)?.isFolder
          ? new Set(descendantIds(prev, id))
          : new Set<string>();
      return prev.map((route) =>
        route.id === id
          ? { ...route, ...patch }
          : cascade.has(route.id)
            ? { ...route, enabled: patch.enabled! }
            : route,
      );
    });
  }

  /** New items land inside the selected folder, else beside the selection. */
  function targetParent(): string | null {
    const current = routes.find((route) => route.id === selectedId);
    if (!current) return null;
    return current.isFolder ? current.id : (current.parentId ?? null);
  }

  function addRoute() {
    const route = newRoute(targetParent());
    setRoutes((prev) => reorder([...prev, route]));
    openRoute(route.id);
    setChecked(new Set());
  }

  function addFolder() {
    const folder = newFolder(targetParent());
    setRoutes((prev) => reorder([...prev, folder]));
    setSelectedId(folder.id);
    setRenamingId(folder.id);
  }

  /** Opens a route in a tab, or focuses the tab it is already in. */
  function openRoute(id: string) {
    setSelectedId(id);
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function closeRoute(id: string) {
    setOpenIds((prev) => {
      const next = prev.filter((candidate) => candidate !== id);
      if (selectedId === id) {
        // Focus the neighbour, the way closing a browser tab does.
        const at = prev.indexOf(id);
        setSelectedId(next[at] ?? next[at - 1] ?? null);
      }
      return next;
    });
  }

  /** Click, ⌘-click and shift-click, matching the collection sidebar. */
  function selectRow(id: string, event: React.MouseEvent) {
    const visible = flatten(routes, collapsed).map((item) => item.route.id);
    if (event.shiftKey && selectedId) {
      const from = visible.indexOf(selectedId);
      const to = visible.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setChecked(new Set(visible.slice(start, end + 1)));
        setSelectedId(id);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (selectedId && !next.has(selectedId)) next.add(selectedId);
        return next;
      });
      setSelectedId(id);
      return;
    }
    setChecked(new Set());
    openRoute(id);
  }

  /** Everything a bulk action applies to: the multi-selection, or the row. */
  function actionIds(): string[] {
    if (checked.size > 0) return Array.from(checked);
    return selectedId ? [selectedId] : [];
  }

  function bulkSetEnabled(enabled: boolean) {
    const ids = new Set(
      actionIds().flatMap((id) => [id, ...descendantIds(routes, id)]),
    );
    setRoutes((prev) =>
      prev.map((route) =>
        ids.has(route.id) ? { ...route, enabled } : route,
      ),
    );
  }

  function bulkDelete() {
    const ids = actionIds();
    setRoutes((prev) => removeWithChildren(prev, ids));
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    setChecked(new Set());
  }

  function bulkDuplicate() {
    const ids = actionIds();
    // Copies land beside the originals, with fresh ids for the whole subtree.
    setRoutes((prev) => {
      const copies: MockRoute[] = [];
      for (const id of ids) {
        const source = prev.find((route) => route.id === id);
        if (!source) continue;
        const remap = new Map<string, string>();
        for (const oldId of [id, ...descendantIds(prev, id)]) {
          remap.set(oldId, newId());
        }
        for (const oldId of remap.keys()) {
          const original = prev.find((route) => route.id === oldId);
          if (!original) continue;
          copies.push({
            ...original,
            id: remap.get(oldId)!,
            parentId:
              original.id === id
                ? (source.parentId ?? null)
                : (remap.get(original.parentId ?? "") ?? null),
            name: original.id === id && original.name ? `${original.name} copy` : original.name,
          });
        }
      }
      return reorder([...prev, ...copies]);
    });
    setChecked(new Set());
  }

  function move(ids: string[], parentId: string | null, beforeId: string | null) {
    setRoutes((prev) => moveInto(prev, ids, parentId, beforeId));
  }

  function rename(id: string, value: string) {
    const trimmed = value.trim();
    if (trimmed !== "") {
      const route = routes.find((candidate) => candidate.id === id);
      update(id, route?.isFolder ? { name: trimmed } : { path: trimmed });
    }
    setRenamingId(null);
  }

  const visibleIds = searchVisible(routes, search);
  const selected = routes.find((r) => r.id === selectedId) ?? null;
  const selectionCount = checked.size > 0 ? checked.size : selected ? 1 : 0;
  const baseUrl = status.port ? `http://127.0.0.1:${status.port}` : null;

  return (
    <div className="flex min-h-0 w-full flex-col">
      {/* Server controls */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5">
        <button
          onClick={toggleServer}
          disabled={busy}
          className={`rounded px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 ${
            status.running
              ? "bg-err hover:opacity-90"
              : "bg-brand hover:bg-brand-bright"
          }`}
        >
          {status.running ? "Stop" : "Start"}
        </button>

        <Input
          size="compact"
          mono
          type="number"
          value={port}
          disabled={status.running}
          title="Port"
          onChange={(e) => setPort(Number(e.target.value))}
          className="w-[68px] flex-none"
        />

        <span
          className={`h-2 w-2 flex-none rounded-full ${
            status.running ? "bg-ok shadow-[0_0_6px_var(--color-ok)]" : "bg-muted"
          }`}
        />
        <span className="truncate font-mono text-[11px] text-muted">
          {baseUrl
            ? `${baseUrl} · ${status.hitCount} hit${
                status.hitCount === 1 ? "" : "s"
              }`
            : "Stopped"}
        </span>

        {error && <span className="text-[11px] text-err">{error}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Route list */}
        <div className="flex w-72 flex-none flex-col border-r border-edge bg-panel">
          <div className="flex flex-none items-center gap-1 border-b border-edge px-2 py-1">
            <Input
              size="compact"
              value={search}
              placeholder="Filter routes…"
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1"
            />
            <button
              onClick={addFolder}
              className="rounded px-1.5 py-1 text-[11px] leading-none text-muted hover:bg-elevated hover:text-ink"
              title="New folder"
            >
              🗀+
            </button>
            <button
              onClick={addRoute}
              className="rounded px-1.5 text-base leading-none text-muted hover:bg-elevated hover:text-ink"
              title="New route"
            >
              +
            </button>
          </div>

          {selectionCount > 1 && (
            <div className="flex flex-none flex-wrap items-center gap-1 border-b border-edge bg-elevated/50 px-2 py-1 text-[11px]">
              <span className="text-muted">{selectionCount} selected</span>
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => bulkSetEnabled(true)}
                  className="rounded px-1.5 py-0.5 text-muted hover:text-ink"
                  title="Enable"
                >
                  On
                </button>
                <button
                  onClick={() => bulkSetEnabled(false)}
                  className="rounded px-1.5 py-0.5 text-muted hover:text-ink"
                  title="Disable"
                >
                  Off
                </button>
                <button
                  onClick={bulkDuplicate}
                  className="rounded px-1.5 py-0.5 text-muted hover:text-ink"
                >
                  Duplicate
                </button>
                <button
                  onClick={bulkDelete}
                  className="rounded px-1.5 py-0.5 text-muted hover:text-err"
                >
                  Delete
                </button>
                <button
                  onClick={() => setChecked(new Set())}
                  className="rounded px-1 py-0.5 text-muted hover:text-ink"
                  title="Clear selection"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            <RouteTree
              routes={routes}
              selectedId={selectedId}
              checked={checked}
              collapsed={collapsed}
              visibleIds={visibleIds}
              onSelect={selectRow}
              onToggleCollapse={(id) =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onUpdate={update}
              onMove={move}
              onContextMenu={(id, e) => {
                e.preventDefault();
                const route = routes.find((candidate) => candidate.id === id);
                if (!route) return;
                // Right-clicking outside the highlighted set acts on that row.
                if (!checked.has(id)) {
                  setChecked(new Set());
                  setSelectedId(id);
                }
                setMenu({ x: e.clientX, y: e.clientY, route });
              }}
              renamingId={renamingId}
              onRename={rename}
            />
          </div>

          <p className="flex-none border-t border-edge px-2 py-1 text-[10px] leading-relaxed text-muted">
            Drag to reorder or nest · right-click for actions · ⌘/shift-click to
            multi-select
          </p>
        </div>

        {menu && (
          <RouteContextMenu
            state={menu}
            selectedCount={selectionCount}
            onClose={() => setMenu(null)}
            onNewRoute={(parentId) => {
              const route = newRoute(parentId);
              setRoutes((prev) => reorder([...prev, route]));
              setSelectedId(route.id);
            }}
            onNewFolder={(parentId) => {
              const folder = newFolder(parentId);
              setRoutes((prev) => reorder([...prev, folder]));
              setSelectedId(folder.id);
              setRenamingId(folder.id);
            }}
            onRename={setRenamingId}
            onDuplicate={bulkDuplicate}
            onDelete={bulkDelete}
            onSetEnabled={bulkSetEnabled}
          />
        )}

        {/* Route editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <ItemTabs
            tabs={openIds.flatMap((id) => {
              const route = routes.find((candidate) => candidate.id === id);
              if (!route) return [];
              return [
                {
                  id,
                  prefix: route.isFolder ? "📁" : route.method,
                  prefixClass: route.isFolder ? "" : methodColor(route.method),
                  label: route.isFolder ? route.name || "Folder" : route.path,
                },
              ];
            })}
            activeId={selectedId ?? ""}
            onSelect={setSelectedId}
            onClose={closeRoute}
            onNew={addRoute}
            newTitle="New route"
          />
          {selected?.isFolder ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-base">📁</span>
                <Input
                  size="compact"
                  value={selected.name}
                  placeholder="Folder name"
                  onChange={(e) => update(selected.id, { name: e.target.value })}
                  className="w-64"
                />
                <button
                  onClick={bulkDelete}
                  className="ml-auto rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-err hover:text-err"
                >
                  Delete folder
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted">
                Folders group routes and do not serve anything themselves.
                Turning a folder off disables every route inside it. Drag routes
                onto a folder to move them in.
              </p>
            </div>
          ) : selected ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Select
                  size="compact"
                  value={selected.method}
                  onChange={(e) =>
                    update(selected.id, { method: e.target.value })
                  }
                  className={`w-24 flex-none cursor-pointer font-mono font-bold ${methodColor(
                    selected.method,
                  )}`}
                >
                  {MOCK_METHODS.map((m) => (
                    <option key={m} value={m} className="text-ink">
                      {m}
                    </option>
                  ))}
                </Select>
                <Input
                  size="compact"
                  mono
                  value={selected.path}
                  spellCheck={false}
                  placeholder="/api/users/*"
                  onChange={(e) =>
                    update(selected.id, { path: e.target.value })
                  }
                  className="min-w-0 flex-1"
                />
                <label className="flex flex-none items-center gap-1 text-[11px] text-muted">
                  Status
                  <Input
                    size="compact"
                    mono
                    type="number"
                    value={selected.status}
                    onChange={(e) =>
                      update(selected.id, { status: Number(e.target.value) })
                    }
                    className="w-16"
                  />
                </label>
                <label className="flex flex-none items-center gap-1 text-[11px] text-muted">
                  Delay
                  <Input
                    size="compact"
                    mono
                    type="number"
                    min={0}
                    value={selected.delayMs}
                    onChange={(e) =>
                      update(selected.id, {
                        delayMs: Math.max(0, Number(e.target.value)),
                      })
                    }
                    className="w-16"
                  />
                  ms
                </label>
                <Select
                  size="compact"
                  value={selected.mode}
                  onChange={(e) =>
                    update(selected.id, { mode: e.target.value as MockMode })
                  }
                  className="w-28 flex-none cursor-pointer"
                  title={
                    MOCK_MODES.find((mode) => mode.value === selected.mode)?.blurb
                  }
                >
                  {MOCK_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </Select>
                <button
                  onClick={bulkDelete}
                  className="flex-none rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-err hover:text-err"
                >
                  Delete
                </button>
              </div>

              {selected.mode === "proxy" && (
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] text-muted">Forward to</span>
                  <Input
                    size="compact"
                    mono
                    value={selected.proxyTarget}
                    spellCheck={false}
                    placeholder="https://api.example.com"
                    onChange={(e) =>
                      update(selected.id, { proxyTarget: e.target.value })
                    }
                    className="min-w-0 flex-1"
                  />
                </div>
              )}

              <p className="mb-2 text-[11px] text-muted">
                {MOCK_MODES.find((mode) => mode.value === selected.mode)?.blurb}{" "}
                A trailing <code className="font-mono text-brand">*</code>{" "}
                matches any suffix. Routes are matched top to bottom.
              </p>

              {/* Response parts as tabs, like the client's request editor. */}
              <div className="mb-2 flex items-center gap-1 border-b border-edge">
                {(
                  [
                    ["body", "Body", selected.body.trim() !== "" ? "●" : ""],
                    [
                      "headers",
                      "Headers",
                      selected.headers.filter((h) => h.name.trim() !== "").length ||
                        "",
                    ],
                    [
                      "matching",
                      "Matching",
                      selected.matchQuery ||
                      selected.matchBody ||
                      selected.matchHeaders.some((h) => h.name.trim() !== "")
                        ? "●"
                        : "",
                    ],
                    [
                      "behaviour",
                      "Behaviour",
                      selected.failPercent > 0 || selected.delayMs > 0 ? "●" : "",
                    ],
                  ] as const
                ).map(([key, label, badge]) => (
                  <button
                    key={key}
                    onClick={() => setEditorTab(key)}
                    className={`-mb-px border-b-2 px-3 py-1 text-xs ${
                      editorTab === key
                        ? "border-brand font-medium text-ink"
                        : "border-transparent text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                    {badge !== "" && (
                      <span className="ml-1.5 text-[9px] text-ok">{badge}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className={editorTab === "headers" ? "" : "hidden"}>
                <KeyValueEditor
                  rows={
                    selected.headers.length
                      ? selected.headers
                      : [{ name: "", value: "" }]
                  }
                  onChange={(headers) => update(selected.id, { headers })}
                  keyPlaceholder="Header"
                  valuePlaceholder="Value"
                  highlightVariables
                  suggestName={(query) => matchHeaders(query, RESPONSE_HEADERS)}
                  suggestValue={matchHeaderValues}
                />
              </div>

              <div className={editorTab === "body" ? "" : "hidden"}>
                {selected.mode === "proxy" ? (
                  <p className="p-4 text-center text-[11px] text-muted">
                    Proxy mode returns the upstream server's response, so this
                    route has no body of its own.
                  </p>
                ) : (
                  <>
                    {(selected.mode === "sequence" ||
                      selected.mode === "sse") && (
                      <p className="mb-1 text-[11px] text-muted">
                        Separate each{" "}
                        {selected.mode === "sse" ? "event" : "response"} with a
                        line containing{" "}
                        <code className="font-mono text-brand">---</code>.
                        {selected.mode === "sse" &&
                          " Delay sets the gap between events (minimum 500ms)."}
                      </p>
                    )}
                    <textarea
                      value={selected.body}
                      spellCheck={false}
                      onChange={(e) =>
                        update(selected.id, { body: e.target.value })
                      }
                      className="h-64 w-full resize-y rounded-md border border-edge bg-panel p-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-brand"
                    />
                  </>
                )}
              </div>

              {editorTab === "matching" && (
                <div className="flex flex-col gap-3">
                  <p className="text-[11px] text-muted">
                    Extra conditions, so several routes can share a path and
                    answer different requests. Empty conditions are ignored.
                  </p>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Required query pairs
                    <Input
                      size="compact"
                      mono
                      value={selected.matchQuery}
                      spellCheck={false}
                      placeholder="status=active&page=1"
                      onChange={(e) =>
                        update(selected.id, { matchQuery: e.target.value })
                      }
                      className="w-96 max-w-full"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Body contains
                    <Input
                      size="compact"
                      mono
                      value={selected.matchBody}
                      spellCheck={false}
                      placeholder='"userId": 42'
                      onChange={(e) =>
                        update(selected.id, { matchBody: e.target.value })
                      }
                      className="w-96 max-w-full"
                    />
                  </label>
                  <div>
                    <div className="mb-1 text-[11px] text-muted">
                      Required headers — a name with no value only requires the
                      header to be present
                    </div>
                    <KeyValueEditor
                      rows={
                        selected.matchHeaders.length
                          ? selected.matchHeaders
                          : [{ name: "", value: "" }]
                      }
                      onChange={(matchHeaders) =>
                        update(selected.id, { matchHeaders })
                      }
                      keyPlaceholder="Header"
                      valuePlaceholder="Expected value"
                      suggestName={(query) => matchHeaders(query)}
                    />
                  </div>
                </div>
              )}

              {editorTab === "behaviour" && (
                <div className="flex flex-col gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-muted">
                    Fail
                    <Input
                      size="compact"
                      mono
                      type="number"
                      min={0}
                      max={100}
                      value={selected.failPercent}
                      onChange={(e) =>
                        update(selected.id, {
                          failPercent: Math.min(
                            100,
                            Math.max(0, Number(e.target.value)),
                          ),
                        })
                      }
                      className="w-16"
                    />
                    % of requests with a 500, to exercise a client's error
                    handling
                  </label>
                  <Toggle
                    checked={selected.cors}
                    onChange={(cors) => update(selected.id, { cors })}
                    label="CORS — answer preflights and allow any origin"
                  />
                  <p className="text-[11px] text-muted">
                    Delay is set beside the status code, and applies before the
                    response is produced.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted">
              Select a route to edit it.
            </div>
          )}

          {/* Hit log */}
          <div className="flex h-40 flex-none flex-col border-t border-edge">
            <div className="flex flex-none items-center justify-between border-b border-edge px-3 py-1.5">
              <span className="text-xs font-semibold text-muted">
                Incoming requests
              </span>
              <button
                onClick={() => setHits([])}
                className="rounded px-2 py-0.5 text-xs text-muted hover:bg-elevated hover:text-ink"
              >
                Clear
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {hits.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">
                  Requests hitting the mock server appear here.
                </p>
              ) : (
                hits.map((hit, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 border-b border-edge px-3 py-1 font-mono text-xs"
                  >
                    <span
                      className={`w-12 flex-none font-bold ${methodColor(
                        hit.method,
                      )}`}
                    >
                      {hit.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{hit.path}</span>
                    {!hit.routeId && (
                      <span className="flex-none text-[10px] text-muted">
                        unmatched
                      </span>
                    )}
                    <span className={`flex-none ${statusColor(hit.status)}`}>
                      {hit.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
