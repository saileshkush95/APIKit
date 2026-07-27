import { useEffect, useState } from "react";
import { KeyValueEditor } from "./KeyValueEditor";
import {
  applyMockRoutes,
  mockStatus,
  onMockHit,
  saveMockRoutes,
  setSetting,
  startMockServer,
  stopMockServer,
} from "../lib/api";
import { usePersist } from "../lib/persist";
import { newId, SETTINGS, workspaceDataOnce } from "../lib/storage";
import { methodColor, statusColor } from "../lib/ui";
import { useWorkspaceId } from "../state/workspaces";
import type { MockHit, MockRoute, MockStatus } from "../types";

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

function newRoute(): MockRoute {
  return {
    id: newId(),
    enabled: true,
    method: "GET",
    path: "/api/example",
    status: 200,
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{\n  "ok": true\n}',
    delayMs: 0,
  };
}

const fieldCls =
  "rounded border border-edge bg-panel px-2 py-1 text-xs text-ink outline-none focus:border-brand";

export function MockPanel() {
  const workspaceId = useWorkspaceId();
  const [routes, setRoutes] = useState<MockRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

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
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        setRoutes(workspace.mockRoutes);
        setSelectedId(workspace.mockRoutes[0]?.id ?? null);
        const savedPort = Number(workspace.settings[SETTINGS.mockPort]);
        if (Number.isFinite(savedPort) && savedPort > 0) setPort(savedPort);
      })
      .catch((e) => console.error("failed to load mock routes", e))
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
    setRoutes((prev) =>
      prev.map((route) => (route.id === id ? { ...route, ...patch } : route)),
    );
  }

  function addRoute() {
    const route = newRoute();
    setRoutes((prev) => [...prev, route]);
    setSelectedId(route.id);
  }

  const selected = routes.find((r) => r.id === selectedId) ?? null;
  const baseUrl = status.port ? `http://127.0.0.1:${status.port}` : null;

  return (
    <div className="flex min-h-0 w-full flex-col">
      {/* Server controls */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <span
          className={`flex items-center gap-1.5 text-xs ${
            status.running ? "text-ok" : "text-muted"
          }`}
        >
          <span className="text-base leading-none">●</span>
          {status.running ? "Running" : "Stopped"}
        </span>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          Port
          <input
            type="number"
            value={port}
            disabled={status.running}
            onChange={(e) => setPort(Number(e.target.value))}
            className={`${fieldCls} w-24 font-mono disabled:opacity-50`}
          />
        </label>

        <button
          onClick={toggleServer}
          disabled={busy}
          className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${
            status.running
              ? "bg-err hover:opacity-90"
              : "bg-brand hover:bg-brand-bright"
          }`}
        >
          {status.running ? "Stop" : "Start"}
        </button>

        {baseUrl && (
          <span className="font-mono text-xs text-muted">
            {baseUrl} · {status.hitCount} hit
            {status.hitCount === 1 ? "" : "s"}
          </span>
        )}

        {error && <span className="text-xs text-err">{error}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Route list */}
        <div className="flex w-64 flex-none flex-col border-r border-edge bg-panel">
          <div className="flex flex-none items-center justify-between border-b border-edge px-3 py-1.5">
            <span className="text-xs font-semibold text-muted">Routes</span>
            <button
              onClick={addRoute}
              className="rounded px-1.5 text-base leading-none text-muted hover:bg-elevated hover:text-ink"
              title="New route"
            >
              +
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {routes.length === 0 && (
              <p className="px-3 py-3 text-xs leading-relaxed text-muted">
                No routes yet. Add one to start serving canned responses.
              </p>
            )}
            {routes.map((route) => (
              <div
                key={route.id}
                onClick={() => setSelectedId(route.id)}
                className={`flex cursor-default items-center gap-2 px-3 py-1.5 text-xs ${
                  route.id === selectedId
                    ? "bg-elevated text-ink"
                    : "text-muted hover:bg-elevated/60"
                } ${route.enabled ? "" : "opacity-50"}`}
              >
                <input
                  type="checkbox"
                  checked={route.enabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update(route.id, { enabled: e.target.checked })
                  }
                  className="flex-none accent-[var(--color-brand)]"
                  title="Enabled"
                />
                <span
                  className={`w-10 flex-none font-mono text-[10px] font-bold ${methodColor(
                    route.method,
                  )}`}
                >
                  {route.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {route.path}
                </span>
                <span className={`flex-none font-mono ${statusColor(route.status)}`}>
                  {route.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Route editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <select
                  value={selected.method}
                  onChange={(e) =>
                    update(selected.id, { method: e.target.value })
                  }
                  className={`${fieldCls} cursor-pointer font-mono font-bold ${methodColor(
                    selected.method,
                  )}`}
                >
                  {MOCK_METHODS.map((m) => (
                    <option key={m} value={m} className="text-ink">
                      {m}
                    </option>
                  ))}
                </select>
                <input
                  value={selected.path}
                  spellCheck={false}
                  placeholder="/api/users/*"
                  onChange={(e) =>
                    update(selected.id, { path: e.target.value })
                  }
                  className={`${fieldCls} min-w-0 flex-1 font-mono`}
                />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  Status
                  <input
                    type="number"
                    value={selected.status}
                    onChange={(e) =>
                      update(selected.id, { status: Number(e.target.value) })
                    }
                    className={`${fieldCls} w-20 font-mono`}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  Delay
                  <input
                    type="number"
                    min={0}
                    value={selected.delayMs}
                    onChange={(e) =>
                      update(selected.id, {
                        delayMs: Math.max(0, Number(e.target.value)),
                      })
                    }
                    className={`${fieldCls} w-20 font-mono`}
                  />
                  ms
                </label>
                <button
                  onClick={() => {
                    setRoutes((prev) =>
                      prev.filter((r) => r.id !== selected.id),
                    );
                    setSelectedId(null);
                  }}
                  className="rounded border border-edge px-2 py-1 text-xs text-muted hover:border-err hover:text-err"
                >
                  Delete
                </button>
              </div>

              <p className="mb-3 text-[11px] text-muted">
                A trailing <code className="font-mono text-brand">*</code>{" "}
                matches any suffix, e.g.{" "}
                <code className="font-mono">/api/users/*</code>. Routes are
                matched top to bottom.
              </p>

              <div className="mb-4">
                <div className="mb-1 text-xs font-semibold text-muted">
                  Response headers
                </div>
                <KeyValueEditor
                  rows={
                    selected.headers.length
                      ? selected.headers
                      : [{ name: "", value: "" }]
                  }
                  onChange={(headers) => update(selected.id, { headers })}
                  keyPlaceholder="Header"
                  valuePlaceholder="Value"
                />
              </div>

              <div className="mb-1 text-xs font-semibold text-muted">
                Response body
              </div>
              <textarea
                value={selected.body}
                spellCheck={false}
                onChange={(e) => update(selected.id, { body: e.target.value })}
                className="h-56 w-full resize-y rounded-md border border-edge bg-panel p-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none focus:border-brand"
              />
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
