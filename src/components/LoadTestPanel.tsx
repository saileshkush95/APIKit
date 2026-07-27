import { useEffect, useState } from "react";
import {
  onLoadProgress,
  runLoadTest,
  sendRequest,
  stopLoadTest,
} from "../lib/api";
import { runAssertions } from "../lib/assertions";
import { PRESETS, presetFor, totalDuration } from "../lib/loadPresets";
import { buildWireRequest, enforceSecureUrl } from "../lib/request";
import { isFolder } from "../lib/tree";
import { methodColor } from "../lib/ui";
import { useActiveRequest } from "../state/activeRequest";
import { useCollection } from "../state/collection";
import { useEnvironments } from "../state/environments";
import { useSettings } from "../state/settings";
import {
  HTTP_METHODS,
  type LoadPhase,
  type LoadProgress,
  type LoadReport,
  type LoadTestKind,
  type TreeNode,
} from "../types";

interface Props {
  /** Opens the collection runner on a folder (used by the Chain preset). */
  onOpenRunner: (folderId: string | null) => void;
}

const fieldCls =
  "rounded border border-edge bg-panel px-2 py-1 text-xs text-ink outline-none focus:border-brand";

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

export function LoadTestPanel({ onOpenRunner }: Props) {
  const { active } = useActiveRequest();
  const { tree } = useCollection();
  const { vars } = useEnvironments();
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
  const [assertionRun, setAssertionRun] = useState<{
    done: number;
    passed: number;
    failed: number;
    messages: string[];
  } | null>(null);

  useEffect(() => {
    const unlisten = onLoadProgress(setProgress);
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  function choose(next: LoadTestKind) {
    setKind(next);
    setPhases(presetFor(next).phases);
    setReport(null);
    setAssertionRun(null);
    setError(null);
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

    // The active request supplies headers, auth and body; this panel only
    // overrides the method and URL.
    const base = active
      ? buildWireRequest(active, vars)
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

  return (
    <div className="min-h-0 w-full overflow-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
        {/* Preset cards */}
        <section className="rounded-lg border border-edge bg-panel">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <h2 className="text-sm font-semibold">Quick Start</h2>
            <span className="text-xs text-muted">Choose a test type</span>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.kind}
                onClick={() => choose(preset.kind)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-4 ${
                  kind === preset.kind
                    ? "border-brand bg-elevated"
                    : "border-edge hover:border-brand/60 hover:bg-elevated/50"
                }`}
                title={preset.blurb}
              >
                <span className={`text-lg leading-none ${preset.accent}`}>
                  {preset.icon}
                </span>
                <span className={`text-xs font-semibold ${preset.accent}`}>
                  {preset.label}
                </span>
              </button>
            ))}
          </div>
          <p className="border-t border-edge px-4 py-2 text-xs text-muted">
            {presetFor(kind).blurb}
          </p>
        </section>

        {/* Chain delegates to the collection runner. */}
        {kind === "chain" ? (
          <section className="rounded-lg border border-edge bg-panel p-4">
            <p className="mb-3 text-xs text-muted">
              A chain runs saved requests in order, with pre/post scripts passing
              variables between them.
            </p>
            <div className="flex items-center gap-2">
              <select
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                className={`${fieldCls} w-64 cursor-pointer`}
              >
                <option value="">Entire collection</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onOpenRunner(folderId || null)}
                className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright"
              >
                Run chain
              </button>
            </div>
          </section>
        ) : (
          <>
            {/* Target */}
            <section className="rounded-lg border border-edge bg-panel p-4">
              <div className="mb-3 flex items-center gap-2">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className={`${fieldCls} cursor-pointer font-mono font-bold ${methodColor(
                    method,
                  )}`}
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m} className="text-ink">
                      {m}
                    </option>
                  ))}
                </select>
                <input
                  value={url}
                  spellCheck={false}
                  placeholder={
                    active?.url || "https://api.example.com/endpoint"
                  }
                  onChange={(e) => setUrl(e.target.value)}
                  className={`${fieldCls} min-w-0 flex-1 font-mono`}
                />
                <button
                  onClick={useActive}
                  disabled={!active}
                  className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                  title="Copy method, URL, headers, auth and body from the open request"
                >
                  Use Active Request
                </button>
              </div>
              <p className="text-[11px] text-muted">
                {active
                  ? `Headers, auth and body come from "${active.name}" in the client.`
                  : "Open a request in the client to reuse its headers, auth and body."}
              </p>
            </section>

            {/* Phases or iterations */}
            <section className="rounded-lg border border-edge bg-panel p-4">
              {kind === "assertions" ? (
                <label className="flex items-center gap-2 text-xs text-muted">
                  Iterations
                  <input
                    type="number"
                    min={1}
                    value={iterations}
                    onChange={(e) =>
                      setIterations(Math.max(1, Number(e.target.value)))
                    }
                    className={`${fieldCls} w-24 font-mono`}
                  />
                  <span>
                    runs the request {iterations}× and checks its assertions
                  </span>
                </label>
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-ink">Phases</h3>
                    <span className="text-xs text-muted">
                      {totalDuration(phases)}s total
                    </span>
                  </div>
                  <table className="w-full border-collapse text-xs">
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
                            <input
                              value={phase.label}
                              onChange={(e) =>
                                patchPhase(i, { label: e.target.value })
                              }
                              className={`${fieldCls} w-full`}
                            />
                          </td>
                          <td className="p-1">
                            <input
                              type="number"
                              min={1}
                              value={phase.vus}
                              onChange={(e) =>
                                patchPhase(i, {
                                  vus: Math.max(1, Number(e.target.value)),
                                })
                              }
                              className={`${fieldCls} w-24 font-mono`}
                            />
                          </td>
                          <td className="p-1">
                            <input
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
                              className={`${fieldCls} w-24 font-mono`}
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
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() =>
                        setPhases((prev) => [
                          ...prev,
                          { label: `phase ${prev.length + 1}`, vus: 10, durationSecs: 15 },
                        ])
                      }
                      className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
                    >
                      + Add phase
                    </button>
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Think time
                      <input
                        type="number"
                        min={0}
                        value={thinkTimeMs}
                        onChange={(e) =>
                          setThinkTimeMs(Math.max(0, Number(e.target.value)))
                        }
                        className={`${fieldCls} w-20 font-mono`}
                      />
                      ms between requests per user
                    </label>
                  </div>
                </>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={start}
                  disabled={running}
                  className="rounded-md bg-brand px-5 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
                >
                  {running ? "Running…" : "Go"}
                </button>
                {running && kind !== "assertions" && (
                  <button
                    onClick={() => stopLoadTest()}
                    className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:border-err hover:text-err"
                  >
                    Stop
                  </button>
                )}
                {progress && (
                  <span className="text-xs text-muted">
                    {progress.label} — {progress.elapsedSecs}/
                    {progress.durationSecs}s · {progress.requests} requests ·{" "}
                    {ms(progress.avgMs)} avg
                  </span>
                )}
              </div>

              {error && (
                <div className="mt-3 rounded border border-err bg-err/10 px-3 py-2 text-xs text-err">
                  {error}
                </div>
              )}
            </section>
          </>
        )}

        {/* Assertion results */}
        {assertionRun && (
          <section className="rounded-lg border border-edge bg-panel">
            <div className="flex items-center gap-3 border-b border-edge px-4 py-2.5 text-xs">
              <h3 className="text-sm font-semibold">Assertion Results</h3>
              <span className="text-muted">
                {assertionRun.done}/{iterations} iterations
              </span>
              <span className="text-ok">{assertionRun.passed} passed</span>
              <span
                className={assertionRun.failed > 0 ? "text-err" : "text-muted"}
              >
                {assertionRun.failed} failed
              </span>
            </div>
            {assertionRun.messages.length > 0 && (
              <div className="p-3">
                {assertionRun.messages.map((message, i) => (
                  <div key={i} className="py-0.5 font-mono text-[11px] text-err">
                    {message}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Load results */}
        {report && (
          <section className="rounded-lg border border-edge bg-panel">
            <div className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
              <h3 className="text-sm font-semibold">
                {presetFor(kind).label} Results
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
              <span className="ml-auto text-xs text-muted">
                {report.totalRequests} requests · {report.totalFailures} failed ·{" "}
                {(report.durationMs / 1000).toFixed(1)}s
              </span>
            </div>

            <div
              className="grid divide-x divide-edge"
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, report.phases.length)}, minmax(0, 1fr))`,
              }}
            >
              {report.phases.map((phase) => (
                <div key={phase.label} className="p-4 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-muted">
                    {phase.label}
                  </div>
                  <div
                    className={`mt-1 text-xl font-bold ${latencyTone(
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
                    {["Phase", "Requests", "RPS", "min", "p50", "p95", "p99", "max", "Statuses"].map(
                      (heading) => (
                        <th key={heading} className="p-2">
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {report.phases.map((phase) => (
                    <tr key={phase.label} className="border-t border-edge">
                      <td className="p-2">{phase.label}</td>
                      <td className="p-2 font-mono">{phase.requests}</td>
                      <td className="p-2 font-mono">{phase.rps.toFixed(1)}</td>
                      <td className="p-2 font-mono">{ms(phase.minMs)}</td>
                      <td className="p-2 font-mono">{ms(phase.p50Ms)}</td>
                      <td className="p-2 font-mono">{ms(phase.p95Ms)}</td>
                      <td className="p-2 font-mono">{ms(phase.p99Ms)}</td>
                      <td className="p-2 font-mono">{ms(phase.maxMs)}</td>
                      <td className="p-2 font-mono text-muted">
                        {phase.statuses
                          .map(([status, count]) => `${status}×${count}`)
                          .join("  ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {kind === "spike" && report.phases.length === 3 && (
              <div className="flex items-center gap-3 border-t border-edge px-4 py-2.5 text-xs">
                <span className="rounded bg-brand/20 px-2 py-0.5 font-semibold text-brand">
                  Recovery
                </span>
                <span className="text-muted">
                  {report.phases[2].avgMs <= report.phases[0].avgMs * 1.5
                    ? `Response times returned to baseline within the ${report.phases[2].durationSecs}s recovery window.`
                    : `Still ${(report.phases[2].avgMs / Math.max(1, report.phases[0].avgMs)).toFixed(1)}× baseline after the spike — recovery incomplete.`}
                </span>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
