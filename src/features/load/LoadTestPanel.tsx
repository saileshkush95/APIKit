import { Input, Select } from "../../shared/components/Field";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { save } from "@tauri-apps/plugin-dialog";
import {
  onLoadProgress,
  runLoadTest,
  sendRequest,
  stopLoadTest,
  writeTextFile,
} from "../../shared/lib/api";
import { notify, notifyError } from "../../shared/lib/notify";
import { LoadChart, type Sample } from "./LoadChart";
import {
  SidebarShell,
  SIDEBAR_DEFAULT,
} from "../client/SidebarShell";
import { setSetting } from "../../shared/lib/api";
import { usePersist } from "../../shared/lib/persist";
import { newId, SETTINGS, workspaceDataOnce } from "../../shared/lib/storage";
import { useWorkspaceId } from "../../shared/state/workspaces";
import { environmentVars } from "../../shared/lib/vars";
import { runAssertions } from "../../shared/lib/assertions";
import { PRESETS, presetFor, totalDuration } from "../../shared/lib/loadPresets";
import { buildWireRequest, enforceSecureUrl } from "../../shared/lib/request";
import { isFolder } from "../../shared/lib/tree";
import { methodColor } from "../../shared/lib/ui";
import { useActiveRequest } from "../../shared/state/activeRequest";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useSettings } from "../../shared/state/settings";
import {
  HTTP_METHODS,
  type LoadPhase,
  type LoadProgress,
  type LoadReport,
  type LoadTest,
  type LoadTestKind,
  type TreeNode,
} from "../../shared/types";


function folderOptions(
  nodes: TreeNode[],
  depth = 0,
): { id: string; label: string }[] {
  return nodes.flatMap((node) =>
    isFolder(node)
      ? [
          { id: node.id, label: `${"— ".repeat(depth)}${node.name}` },
          ...folderOptions(node.children, depth + 1),
        ]
      : [],
  );
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

/** Colours a phase's latency relative to the first phase (the baseline). */
function latencyTone(value: number, baseline: number): string {
  if (baseline === 0) return "text-ink";
  if (value > baseline * 3) return "text-err";
  if (value > baseline * 1.5) return "text-warn";
  return "text-ok";
}

export function LoadTestPanel() {
  const navigate = useNavigate();
  const onOpenRunner = (folderId: string | null) =>
    navigate({ to: "/runner", search: folderId ? { folder: folderId } : {} });
  const { active } = useActiveRequest();
  const { tree } = useCollection();
  const { vars, active: activeEnv, environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState("");
  const [tab, setTab] = useState<"setup" | "live" | "results">("setup");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { settings } = useSettings();

  const [kind, setKind] = useState<LoadTestKind>("load");
  const [phases, setPhases] = useState<LoadPhase[]>(presetFor("load").phases);
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [thinkTimeMs, setThinkTimeMs] = useState(0);
  const [iterations, setIterations] = useState(20);
  const [folderId, setFolderId] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [report, setReport] = useState<LoadReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Progress arrives as cumulative per-phase counters; the history turns them
  // into per-interval latency and throughput, which is what a chart needs.
  const [latency, setLatency] = useState<Sample[]>([]);
  const [throughput, setThroughput] = useState<Sample[]>([]);
  const startedAtRef = useRef(0);
  const lastSampleRef = useRef<{
    phaseIndex: number;
    requests: number;
    sumMs: number;
    atSecs: number;
  } | null>(null);
  const [assertionRun, setAssertionRun] = useState<{
    done: number;
    passed: number;
    failed: number;
    messages: string[];
  } | null>(null);

  // Saved tests, listed in the sidebar the way the client lists requests. A
  // tuned soak or spike is worth keeping, not rebuilding from a preset.
  const workspaceId = useWorkspaceId();
  const [tests, setTests] = useState<LoadTest[]>([]);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [listReady, setListReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListReady(false);
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        const raw = workspace.settings[SETTINGS.loadTests];
        const saved: LoadTest[] = raw ? JSON.parse(raw) : [];
        setTests(saved);
        setSelectedTestId(saved[0]?.id ?? null);
        if (saved[0]) applyTest(saved[0]);
      })
      .catch(() => {})
      .finally(() => !cancelled && setListReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  usePersist(tests, listReady, (value) =>
    setSetting(workspaceId, SETTINGS.loadTests, JSON.stringify(value)),
  );

  // Editing any field updates the selected test, so the sidebar entry always
  // reflects what the pane shows — no explicit save step.
  useEffect(() => {
    if (!selectedTestId || !listReady) return;
    setTests((prev) =>
      prev.map((test) =>
        test.id === selectedTestId
          ? {
              ...test,
              kind,
              phases,
              method,
              url,
              thinkTimeMs,
              iterations,
              environmentId: environmentId || null,
              folderId: folderId || null,
            }
          : test,
      ),
    );
    // `selectedTestId` is intentionally the only identity in the deps: the rest
    // are the values being mirrored.
  }, [
    selectedTestId,
    listReady,
    kind,
    phases,
    method,
    url,
    thinkTimeMs,
    iterations,
    environmentId,
    folderId,
  ]);

  /** Loads a saved test's configuration into the editor. */
  function applyTest(test: LoadTest) {
    setKind(test.kind);
    setPhases(test.phases);
    setMethod(test.method);
    setUrl(test.url);
    setThinkTimeMs(test.thinkTimeMs);
    setIterations(test.iterations);
    setEnvironmentId(test.environmentId ?? "");
    setFolderId(test.folderId ?? "");
  }

  /** Writes the editor's current values back onto the selected test. */
  function patchSelected(patch: Partial<LoadTest>) {
    if (!selectedTestId) return;
    setTests((prev) =>
      prev.map((test) =>
        test.id === selectedTestId ? { ...test, ...patch } : test,
      ),
    );
  }

  function selectTest(test: LoadTest) {
    setSelectedTestId(test.id);
    applyTest(test);
    setReport(null);
    setAssertionRun(null);
    setLatency([]);
    setThroughput([]);
    setTab("setup");
  }

  function createTest(fromKind: LoadTestKind = "load") {
    const preset = presetFor(fromKind);
    const test: LoadTest = {
      id: newId(),
      name: `${preset.label} ${tests.length + 1}`,
      kind: fromKind,
      method: "GET",
      url: "",
      phases: preset.phases,
      thinkTimeMs: 0,
      iterations: 20,
      environmentId: null,
      folderId: null,
    };
    setTests((prev) => [...prev, test]);
    selectTest(test);
    setRenamingId(test.id);
  }

  function duplicateTest(id: string) {
    const source = tests.find((test) => test.id === id);
    if (!source) return;
    const copy = { ...source, id: newId(), name: `${source.name} copy` };
    setTests((prev) => [...prev, copy]);
    selectTest(copy);
  }

  function deleteTest(id: string) {
    setTests((prev) => prev.filter((test) => test.id !== id));
    if (selectedTestId === id) setSelectedTestId(null);
  }

  useEffect(() => {
    const unlisten = onLoadProgress((next) => {
      setProgress(next);

      const atSecs = Math.max(
        0,
        Math.round((performance.now() - startedAtRef.current) / 1000),
      );
      // `avgMs` is a running mean, so the interval mean comes from the sums.
      const sumMs = next.avgMs * next.requests;
      const previous = lastSampleRef.current;
      const samePhase = previous?.phaseIndex === next.phaseIndex;
      const deltaRequests = next.requests - (samePhase ? previous!.requests : 0);
      const deltaSum = sumMs - (samePhase ? previous!.sumMs : 0);
      const deltaSecs = Math.max(
        0.5,
        atSecs - (previous ? previous.atSecs : 0),
      );
      lastSampleRef.current = {
        phaseIndex: next.phaseIndex,
        requests: next.requests,
        sumMs,
        atSecs,
      };
      if (deltaRequests <= 0) return;

      const point = {
        atSecs,
        phaseIndex: next.phaseIndex,
        phaseLabel: next.label,
      };
      setLatency((prev) => [
        ...prev,
        { ...point, value: deltaSum / deltaRequests },
      ]);
      setThroughput((prev) => [
        ...prev,
        { ...point, value: deltaRequests / deltaSecs },
      ]);
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  /** Saves the finished report as JSON or CSV. */
  async function exportReport(format: "json" | "csv") {
    if (!report) return;
    const path = await save({
      title: "Save load report",
      defaultPath: `load-report.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;

    const contents =
      format === "json"
        ? JSON.stringify(
            { kind, url: url || active?.url, phases, report },
            null,
            2,
          )
        : [
            "phase,vus,duration_secs,requests,failures,rps,min_ms,p50_ms,p95_ms,p99_ms,max_ms,avg_ms",
            ...report.phases.map((phase) =>
              [
                `"${phase.label}"`,
                phase.vus,
                phase.durationSecs,
                phase.requests,
                phase.failures,
                phase.rps.toFixed(2),
                Math.round(phase.minMs),
                Math.round(phase.p50Ms),
                Math.round(phase.p95Ms),
                Math.round(phase.p99Ms),
                Math.round(phase.maxMs),
                Math.round(phase.avgMs),
              ].join(","),
            ),
          ].join("\n");

    try {
      await writeTextFile(path, contents);
      notify("success", `Report saved to ${path}`);
    } catch (e) {
      notifyError("Could not save the report", e);
    }
  }

  function choose(next: LoadTestKind) {
    setKind(next);
    setPhases(presetFor(next).phases);
    setReport(null);
    setAssertionRun(null);
    setError(null);
    // The previous run's results belong to the previous test type.
    setLatency([]);
    setThroughput([]);
    setTab("setup");
  }

  /** Copies method, URL, headers and body from the request open in the client. */
  function useActive() {
    if (!active) return;
    setMethod(active.method);
    setUrl(active.url);
  }

  function patchPhase(index: number, patch: Partial<LoadPhase>) {
    setPhases((prev) =>
      prev.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)),
    );
  }

  async function start() {
    setError(null);
    setReport(null);
    setProgress(null);
    setLatency([]);
    setThroughput([]);
    startedAtRef.current = performance.now();
    lastSampleRef.current = null;

    // The active request supplies headers, auth and body; this panel only
    // overrides the method and URL.
    const pinned = environments.find((env) => env.id === environmentId);
    const runVars = pinned ? environmentVars(pinned) : vars;
    const base = active
      ? buildWireRequest(active, runVars)
      : { method, url, headers: [], body: "" };

    const target = url.trim() === "" ? base.url : url;
    if (target.trim() === "") {
      setError("Enter a URL, or open a request in the client and use it here.");
      return;
    }

    if (kind === "assertions") {
      await runAssertionSuite(base, target);
      return;
    }

    setRunning(true);
    // The charts are the point while it runs; the report matters afterwards.
    setTab("live");
    try {
      const result = await runLoadTest({
        request: {
          method: method || base.method,
          url: enforceSecureUrl(target, settings.enforceSecure),
          headers: base.headers.filter((h) => h.name.trim() !== ""),
          body: base.body || null,
          timeoutMs: settings.defaultTimeoutMs,
          verifyTls: settings.verifyTls,
          httpVersion: settings.defaultHttpVersion,
        },
        phases,
        thinkTimeMs,
      });
      setReport(result);
      setTab("results");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function runAssertionSuite(
    base: { method: string; url: string; headers: { name: string; value: string }[]; body: string },
    target: string,
  ) {
    if (!active) {
      setError("Open a request in the client — assertions come from it.");
      return;
    }
    setRunning(true);
    // An assertion suite has no charts, so its results are the live view.
    setTab("results");
    const summary = { done: 0, passed: 0, failed: 0, messages: [] as string[] };
    setAssertionRun({ ...summary });

    for (let i = 0; i < iterations; i++) {
      try {
        const response = await sendRequest({
          method: method || base.method,
          url: enforceSecureUrl(target, settings.enforceSecure),
          headers: base.headers.filter((h) => h.name.trim() !== ""),
          body: base.body || null,
          timeoutMs: settings.defaultTimeoutMs,
          verifyTls: settings.verifyTls,
        });
        for (const result of runAssertions(active.tests, response)) {
          if (result.passed) summary.passed += 1;
          else {
            summary.failed += 1;
            if (summary.messages.length < 20) {
              summary.messages.push(`#${i + 1} ${result.message}`);
            }
          }
        }
      } catch (e) {
        summary.failed += 1;
        if (summary.messages.length < 20) {
          summary.messages.push(`#${i + 1} ${String(e)}`);
        }
      }
      summary.done += 1;
      setAssertionRun({ ...summary, messages: [...summary.messages] });
    }

    setRunning(false);
  }

  const folders = folderOptions(tree);
  const baseline = report?.phases[0]?.avgMs ?? 0;

  // A tab with nothing behind it is worse than no tab: the pane just looks
  // broken. Live and Results unlock once there is something in them.
  const hasLive = running || latency.length > 0;

  return (
    <div className="flex min-h-0 w-full">
      {/* Test types, where the client keeps its collection. */}
      <SidebarShell
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        header={
          <div className="flex flex-1 items-center gap-1 px-2 py-1">
            <span className="flex-1 text-xs font-semibold text-ink">Tests</span>
            <button
              onClick={() => createTest(kind)}
              className="rounded px-1.5 text-base leading-none text-muted hover:bg-elevated hover:text-ink"
              title="New test"
            >
              +
            </button>
          </div>
        }
      >
        {tests.length === 0 ? (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-muted">
            No saved tests. Create one, pick its type, and it stays here for next
            time.
          </p>
        ) : (
          tests.map((test) => {
            const preset = presetFor(test.kind);
            return (
              <div
                key={test.id}
                onClick={() => selectTest(test)}
                onDoubleClick={() => setRenamingId(test.id)}
                className={`flex cursor-default items-center gap-2 px-2 py-1.5 text-xs ${
                  test.id === selectedTestId
                    ? "bg-elevated text-ink"
                    : "text-muted hover:bg-elevated/60"
                }`}
              >
                <span
                  className={`w-4 flex-none text-center ${preset.accent}`}
                  title={preset.label}
                >
                  {preset.icon}
                </span>
                {renamingId === test.id ? (
                  <input
                    autoFocus
                    defaultValue={test.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name) patchSelected({ name });
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-brand bg-panel px-1 py-0.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{test.name}</span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateTest(test.id);
                  }}
                  className="flex-none px-1 text-[11px] text-muted opacity-0 group-hover:opacity-100 hover:text-ink"
                  title="Duplicate"
                >
                  ⧉
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTest(test.id);
                  }}
                  className="flex-none px-1 text-[11px] text-muted hover:text-err"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </SidebarShell>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Target bar, in the same place as the client's URL bar. */}
        {kind === "chain" ? (
          <div className="flex flex-none items-center gap-2 border-b border-edge p-2">
            <Select
              size="compact"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-64 cursor-pointer"
            >
              <option value="">Entire collection</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.label}
                </option>
              ))}
            </Select>
            <button
              onClick={() => onOpenRunner(folderId || null)}
              className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-bright"
            >
              Run chain
            </button>
            <span className="text-[11px] text-muted">
              Chains run in the collection runner, where scripts pass variables
              between requests.
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-none items-center gap-2 border-b border-edge p-2">
              <Select
                size="compact"
                value={kind}
                onChange={(e) => choose(e.target.value as LoadTestKind)}
                className="w-32 flex-none cursor-pointer"
                title={presetFor(kind).blurb}
              >
                {PRESETS.map((preset) => (
                  <option key={preset.kind} value={preset.kind}>
                    {preset.label}
                  </option>
                ))}
              </Select>
              <Select
                size="compact"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={`w-24 flex-none cursor-pointer font-mono font-bold ${methodColor(
                  method,
                )}`}
              >
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m} className="text-ink">
                    {m}
                  </option>
                ))}
              </Select>
              <Input
                size="compact"
                mono
                value={url}
                spellCheck={false}
                placeholder={active?.url || "https://api.example.com/endpoint"}
                onChange={(e) => setUrl(e.target.value)}
                className="min-w-0 flex-1"
              />
              <button
                onClick={useActive}
                disabled={!active}
                className="flex-none rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                title="Copy method, URL, headers, auth and body from the open request"
              >
                Use active
              </button>
              <Select
                size="compact"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                className="w-36 flex-none"
                title="Pin an environment so a test cannot silently hit whichever one happens to be active"
              >
                <option value="">
                  Active{activeEnv ? ` — ${activeEnv.name}` : " — none"}
                </option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </Select>
              {running && kind !== "assertions" ? (
                <button
                  onClick={() => stopLoadTest()}
                  className="flex-none rounded bg-err px-3 py-1 text-xs font-semibold text-white"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={start}
                  disabled={running}
                  className="flex-none rounded bg-brand px-4 py-1 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
                >
                  {running ? "Running…" : "Run"}
                </button>
              )}
            </div>

            {/* Tabs, in the same place as the client's request tabs. */}
            <div className="flex flex-none items-center gap-1 border-b border-edge px-2">
              {(
                [
                  ["setup", "Setup", "", true],
                  ["live", "Live", running ? "●" : ""],
                  [
                    "results",
                    "Results",
                    report ? String(report.phases.length) : "",
                  ],
                ] as const
              ).map(([key, label, badge]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`-mb-px flex-none border-b-2 px-3 py-1.5 text-xs ${
                    tab === key
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
              <span className="ml-auto min-w-0 truncate pl-3 text-[11px] text-muted">
                {active
                  ? `headers, auth and body from “${active.name}”`
                  : "no request open — sending bare requests"}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === "setup" &&
                (kind === "assertions" ? (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Iterations
                    <Input
                      size="compact"
                      mono
                      type="number"
                      min={1}
                      value={iterations}
                      onChange={(e) =>
                        setIterations(Math.max(1, Number(e.target.value)))
                      }
                      className="w-20"
                    />
                    <span>
                      runs the request {iterations}× and checks its assertions
                    </span>
                  </label>
                ) : (
                  <>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-ink">Phases</h3>
                      <span className="text-[11px] text-muted">
                        {totalDuration(phases)}s total
                      </span>
                    </div>
                    <table className="w-full max-w-2xl border-collapse text-xs">
                      <thead>
                        <tr className="text-left text-[11px] text-muted">
                          <th className="p-1">Label</th>
                          <th className="p-1">Virtual users</th>
                          <th className="p-1">Duration (s)</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {phases.map((phase, i) => (
                          <tr key={i}>
                            <td className="p-1">
                              <Input
                                size="compact"
                                value={phase.label}
                                onChange={(e) =>
                                  patchPhase(i, { label: e.target.value })
                                }
                                className="w-full"
                              />
                            </td>
                            <td className="p-1">
                              <Input
                                size="compact"
                                mono
                                type="number"
                                min={1}
                                value={phase.vus}
                                onChange={(e) =>
                                  patchPhase(i, {
                                    vus: Math.max(1, Number(e.target.value)),
                                  })
                                }
                                className="w-24"
                              />
                            </td>
                            <td className="p-1">
                              <Input
                                size="compact"
                                mono
                                type="number"
                                min={1}
                                max={3600}
                                value={phase.durationSecs}
                                onChange={(e) =>
                                  patchPhase(i, {
                                    durationSecs: Math.min(
                                      3600,
                                      Math.max(1, Number(e.target.value)),
                                    ),
                                  })
                                }
                                className="w-24"
                              />
                            </td>
                            <td className="p-1">
                              <button
                                onClick={() =>
                                  setPhases((prev) =>
                                    prev.filter((_, index) => index !== i),
                                  )
                                }
                                className="px-1.5 text-muted hover:text-err"
                                title="Remove phase"
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <button
                        onClick={() =>
                          setPhases((prev) => [
                            ...prev,
                            {
                              label: `phase ${prev.length + 1}`,
                              vus: 10,
                              durationSecs: 15,
                            },
                          ])
                        }
                        className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-brand hover:text-ink"
                      >
                        + Add phase
                      </button>
                      <label className="flex items-center gap-1.5 text-[11px] text-muted">
                        Think time
                        <Input
                          size="compact"
                          mono
                          type="number"
                          min={0}
                          value={thinkTimeMs}
                          onChange={(e) =>
                            setThinkTimeMs(Math.max(0, Number(e.target.value)))
                          }
                          className="w-20"
                        />
                        ms between requests per user
                      </label>
                    </div>
                  </>
                ))}

              {tab === "live" && (
                <>
                  {progress && (
                    <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
                      <span className="font-medium text-ink">
                        {progress.label}
                      </span>
                      <span>
                        {progress.elapsedSecs}/{progress.durationSecs}s
                      </span>
                      <span>{progress.requests} requests</span>
                      <span>{ms(progress.avgMs)} avg</span>
                      {progress.failures > 0 && (
                        <span className="text-err">
                          {progress.failures} failed
                        </span>
                      )}
                    </div>
                  )}
                  {kind === "assertions" ? (
                    <p className="text-[11px] text-muted">
                      Assertion suites report in the Results tab.
                    </p>
                  ) : !hasLive ? (
                    <p className="p-6 text-center text-xs text-muted">
                      Latency and throughput are charted here while a test runs.
                    </p>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      <LoadChart
                        title="Latency"
                        samples={latency}
                        format={(value) => `${Math.round(value)}ms`}
                      />
                      <LoadChart
                        title="Throughput"
                        samples={throughput}
                        format={(value) => `${value.toFixed(1)}/s`}
                      />
                    </div>
                  )}
                </>
              )}

              {tab === "results" && (
                <>
                  {assertionRun && (
                    <section className="mb-3 rounded-lg border border-edge bg-panel">
                      <div className="flex items-center gap-3 border-b border-edge px-3 py-2 text-xs">
                        <h3 className="text-xs font-semibold">
                          Assertion results
                        </h3>
                        <span className="text-muted">
                          {assertionRun.done}/{iterations} iterations
                        </span>
                        <span className="text-ok">
                          {assertionRun.passed} passed
                        </span>
                        <span
                          className={
                            assertionRun.failed > 0 ? "text-err" : "text-muted"
                          }
                        >
                          {assertionRun.failed} failed
                        </span>
                      </div>
                      {assertionRun.messages.length > 0 && (
                        <div className="p-3">
                          {assertionRun.messages.map((message, i) => (
                            <div
                              key={i}
                              className="py-0.5 font-mono text-[11px] text-err"
                            >
                              {message}
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {report ? (
                    <section className="rounded-lg border border-edge bg-panel">
                      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-3 py-2">
                        <h3 className="text-xs font-semibold">
                          {presetFor(kind).label} results
                        </h3>
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                            report.cancelled
                              ? "bg-warn/20 text-warn"
                              : "bg-ok/20 text-ok"
                          }`}
                        >
                          {report.cancelled ? "STOPPED" : "DONE"}
                        </span>
                        <span className="text-[11px] text-muted">
                          {report.totalRequests} requests ·{" "}
                          {report.totalFailures} failed ·{" "}
                          {(report.durationMs / 1000).toFixed(1)}s
                        </span>
                        <div className="ml-auto flex items-center gap-1.5">
                          <button
                            onClick={() => exportReport("json")}
                            className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                          >
                            JSON
                          </button>
                          <button
                            onClick={() => exportReport("csv")}
                            className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                          >
                            CSV
                          </button>
                        </div>
                      </div>

                      <div
                        className="grid divide-x divide-edge"
                        style={{
                          gridTemplateColumns: `repeat(${Math.max(
                            1,
                            report.phases.length,
                          )}, minmax(0, 1fr))`,
                        }}
                      >
                        {report.phases.map((phase) => (
                          <div key={phase.label} className="p-3 text-center">
                            <div className="text-[10px] tracking-wide text-muted uppercase">
                              {phase.label}
                            </div>
                            <div
                              className={`mt-1 text-lg font-bold ${latencyTone(
                                phase.avgMs,
                                baseline,
                              )}`}
                            >
                              {ms(phase.avgMs)} avg
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted">
                              {phase.vus} VUs · {phase.durationSecs}s
                            </div>
                            <div className="mt-1 text-[11px] text-muted">
                              p95 {ms(phase.p95Ms)} · {phase.rps.toFixed(1)} rps
                            </div>
                            {phase.failures > 0 && (
                              <div className="mt-1 text-[11px] text-err">
                                {phase.failures} failed
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="overflow-x-auto border-t border-edge">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="text-left text-[11px] text-muted">
                              {[
                                "Phase",
                                "Requests",
                                "RPS",
                                "min",
                                "p50",
                                "p95",
                                "p99",
                                "max",
                                "Statuses",
                              ].map((heading) => (
                                <th key={heading} className="p-2">
                                  {heading}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {report.phases.map((phase) => (
                              <tr
                                key={phase.label}
                                className="border-t border-edge"
                              >
                                <td className="p-2">{phase.label}</td>
                                <td className="p-2 font-mono">
                                  {phase.requests}
                                </td>
                                <td className="p-2 font-mono">
                                  {phase.rps.toFixed(1)}
                                </td>
                                <td className="p-2 font-mono">
                                  {ms(phase.minMs)}
                                </td>
                                <td className="p-2 font-mono">
                                  {ms(phase.p50Ms)}
                                </td>
                                <td className="p-2 font-mono">
                                  {ms(phase.p95Ms)}
                                </td>
                                <td className="p-2 font-mono">
                                  {ms(phase.p99Ms)}
                                </td>
                                <td className="p-2 font-mono">
                                  {ms(phase.maxMs)}
                                </td>
                                <td className="p-2 font-mono text-muted">
                                  {phase.statuses
                                    .map(
                                      ([status, count]) => `${status}×${count}`,
                                    )
                                    .join("  ") || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {kind === "spike" && report.phases.length === 3 && (
                        <div className="flex items-center gap-3 border-t border-edge px-3 py-2 text-xs">
                          <span className="rounded bg-brand/20 px-2 py-0.5 font-semibold text-brand">
                            Recovery
                          </span>
                          <span className="text-muted">
                            {report.phases[2].avgMs <=
                            report.phases[0].avgMs * 1.5
                              ? `Response times returned to baseline within the ${report.phases[2].durationSecs}s recovery window.`
                              : `Still ${(
                                  report.phases[2].avgMs /
                                  Math.max(1, report.phases[0].avgMs)
                                ).toFixed(1)}× baseline after the spike — recovery incomplete.`}
                          </span>
                        </div>
                      )}
                    </section>
                  ) : (
                    !assertionRun && (
                      <p className="p-6 text-center text-xs text-muted">
                        Run a test to see its report here.
                      </p>
                    )
                  )}
                </>
              )}

              {error && (
                <div className="mt-3 rounded border border-err bg-err/10 px-3 py-2 text-xs text-err">
                  {error}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
