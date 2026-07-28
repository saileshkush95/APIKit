import { Input, Select } from "../../shared/components/Field";
import { Toggle } from "../../shared/components/Toggle";
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelRequest, readTextFile } from "../../shared/lib/api";
import { parseDataFile, type DataSet } from "../../shared/lib/dataFile";
import { executeRequest } from "../../shared/lib/execute";
import { notifyError } from "../../shared/lib/notify";
import { findNode, isFolder } from "../../shared/lib/tree";
import { methodColor, statusColor } from "../../shared/lib/ui";
import { environmentVars } from "../../shared/lib/vars";
import { useCollection } from "../../shared/state/collection";
import {
  useEnvironments,
  useEnvironmentsStore,
} from "../../shared/state/environments";
import { useSettings } from "../../shared/state/settings";
import type { AssertionResult, SavedRequest, TreeNode } from "../../shared/types";

interface Entry {
  request: SavedRequest;
  path: string[];
}

interface RunResult extends Entry {
  /** 1-based run number when iterating the collection more than once. */
  iteration: number;
  status: number | null;
  statusText: string;
  timeMs: number;
  error: string | null;
  results: AssertionResult[];
  body: string;
}

/** Depth-first list of requests, so runs follow the visible sidebar order. */
function flatten(nodes: TreeNode[], path: string[] = []): Entry[] {
  return nodes.flatMap((node) =>
    isFolder(node)
      ? flatten(node.children, [...path, node.name])
      : [{ request: node, path }],
  );
}

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

interface RunnerProps {
  /** Folder to preselect, e.g. from the sidebar's "Run folder" action. */
  initialTarget?: string | null;
}

export function RunnerPanel({ initialTarget }: RunnerProps = {}) {
  const { tree } = useCollection();
  const { vars, active, environments, setVariables } = useEnvironments();
  const { settings } = useSettings();

  const [targetId, setTargetId] = useState<string>(initialTarget ?? "");

  useEffect(() => {
    setTargetId(initialTarget ?? "");
  }, [initialTarget]);
  const [delayMs, setDelayMs] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Requests the user has unticked; everything else in `entries` runs.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // Empty string means "whatever is active", matching the previous behaviour.
  const [environmentId, setEnvironmentId] = useState("");
  const [data, setData] = useState<{ path: string; set: DataSet } | null>(null);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const cancelRef = useRef(false);
  // The in-flight request's cancel handle, so Stop aborts it immediately
  // instead of waiting out the timeout.
  const inFlightRef = useRef<string | null>(null);

  const folders = useMemo(() => folderOptions(tree), [tree]);

  const allEntries = useMemo(() => {
    if (targetId === "") return flatten(tree);
    const node = findNode(tree, targetId);
    return node && isFolder(node) ? flatten(node.children, [node.name]) : [];
  }, [tree, targetId]);

  const entries = useMemo(
    () => allEntries.filter((entry) => !skipped.has(entry.request.id)),
    [allEntries, skipped],
  );

  // A data file drives the iteration count: one pass per row.
  const effectiveIterations = data ? data.set.rows.length : iterations;

  /** Variables for a run: the pinned environment, or the active one. */
  function runVars(): Record<string, string> {
    if (environmentId === "") return vars;
    const pinned = environments.find((env) => env.id === environmentId);
    if (!pinned) return vars;
    // Session variables (set by scripts) still apply on top of the pinned set.
    return {
      ...environmentVars(pinned),
      ...useEnvironmentsStore.getState().sessionVars,
    };
  }

  async function pickDataFile() {
    const selected = await open({
      multiple: false,
      title: "Choose a CSV or JSON data file",
      filters: [{ name: "Data", extensions: ["csv", "json", "tsv", "txt"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const set = parseDataFile(await readTextFile(selected), selected);
      setData({ path: selected, set });
    } catch (e) {
      notifyError("Could not read the data file", e);
    }
  }

  async function stop() {
    cancelRef.current = true;
    // Abort the send that is already on the wire.
    if (inFlightRef.current) {
      await cancelRequest(inFlightRef.current).catch(() => {});
    }
  }

  const visibleResults = failedOnly
    ? results.filter(
        (result) =>
          result.error !== null ||
          result.results.some((assertion) => !assertion.passed),
      )
    : results;

  const totals = results.reduce(
    (acc, r) => {
      acc.passed += r.results.filter((a) => a.passed).length;
      acc.failed += r.results.filter((a) => !a.passed).length;
      acc.timeMs += r.timeMs;
      if (r.error) acc.errors += 1;
      return acc;
    },
    { passed: 0, failed: 0, timeMs: 0, errors: 0 },
  );

  async function run() {
    cancelRef.current = false;
    setRunning(true);
    setResults([]);
    setExpandedRow(null);

    const base = runVars();
    let aborted = false;

    for (let iteration = 1; iteration <= effectiveIterations; iteration++) {
      // With a data file, this iteration's row wins over the environment, so
      // {{email}} resolves to the row's value.
      const iterationVars = data
        ? { ...base, ...data.set.rows[iteration - 1] }
        : base;

      for (const entry of entries) {
        if (cancelRef.current) break;
        setCurrentName(entry.request.name);
        const cancelId = `runner:${entry.request.id}:${iteration}`;
        inFlightRef.current = cancelId;
        const result = await executeRequest(entry.request, {
          vars: iterationVars,
          settings,
          onVariables: setVariables,
          tree,
          cancelId,
        });
        inFlightRef.current = null;
        setResults((prev) => [
          ...prev,
          {
            ...entry,
            iteration,
            status: result.status,
            statusText: result.statusText,
            timeMs: result.timeMs,
            error: result.error,
            results: result.results,
            body: result.body,
          },
        ]);

        const failed =
          result.error !== null ||
          result.results.some((assertion) => !assertion.passed);
        if (stopOnFailure && failed) {
          aborted = true;
          break;
        }
        if (delayMs > 0 && !cancelRef.current) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (cancelRef.current || aborted) break;
    }

    setCurrentName(null);
    setRunning(false);
    inFlightRef.current = null;
  }

  return (
    <div className="flex min-h-0 w-full flex-col">
      {/* Controls */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Run
          <Select
            size="compact"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-48"
          >
            <option value="">Entire collection</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Environment
          <Select
            size="compact"
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
            className="w-40"
            title="Pin an environment so a run cannot pick up whichever one happens to be active"
          >
            <option value="">
              Active{active ? ` — ${active.name}` : " — none"}
            </option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Iterations
          <Input
            size="compact"
            mono
            type="number"
            min={1}
            value={effectiveIterations}
            disabled={data !== null}
            title={data ? "Set by the data file: one iteration per row" : undefined}
            onChange={(e) => setIterations(Math.max(1, Number(e.target.value)))}
            className="w-14"
          />
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Delay
          <Input
            size="compact"
            mono
            type="number"
            min={0}
            step={50}
            value={delayMs}
            onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value)))}
            className="w-16"
          />
          ms
        </label>

        <Toggle
          checked={stopOnFailure}
          onChange={setStopOnFailure}
          label="Stop on failure"
          title="Abort the whole run as soon as a request errors or an assertion fails"
        />

        <div className="ml-auto flex items-center gap-2">
          {running && (
            <button
              onClick={stop}
              className="rounded border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-err hover:text-err"
            >
              Stop
            </button>
          )}
          <button
            onClick={run}
            disabled={running || entries.length === 0}
            className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-bright disabled:cursor-default disabled:opacity-50"
          >
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {/* Data file */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-edge px-3 py-1 text-[11px]">
        <span className="text-muted">Data file</span>
        {data ? (
          <>
            <span
              className="max-w-[22rem] truncate font-mono text-ink"
              title={data.path}
            >
              {data.path.split("/").pop()}
            </span>
            <span className="text-muted">
              {data.set.rows.length} row
              {data.set.rows.length === 1 ? "" : "s"} ·{" "}
              {data.set.columns.map((column) => `{{${column}}}`).join(" ")}
            </span>
            <button
              onClick={() => setData(null)}
              className="rounded px-1 text-muted hover:text-err"
              title="Remove"
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <button
              onClick={pickDataFile}
              className="rounded border border-edge px-2 py-0.5 text-muted hover:border-brand hover:text-ink"
            >
              Choose CSV or JSON…
            </button>
            <span className="text-muted">
              Optional — each row becomes one iteration, its columns available as
              variables.
            </span>
          </>
        )}
      </div>

      {/* Request selection */}
      <details className="flex-none border-b border-edge">
        <summary className="cursor-pointer px-3 py-1 text-[11px] text-muted">
          {entries.length} of {allEntries.length} request
          {allEntries.length === 1 ? "" : "s"} selected
          {effectiveIterations > 1 && ` · ${effectiveIterations} iterations`}
        </summary>
        <div className="max-h-48 overflow-auto border-t border-edge">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px]">
            <button
              onClick={() => setSkipped(new Set())}
              className="text-muted hover:text-ink"
            >
              Select all
            </button>
            <button
              onClick={() =>
                setSkipped(new Set(allEntries.map((entry) => entry.request.id)))
              }
              className="text-muted hover:text-ink"
            >
              Select none
            </button>
          </div>
          {allEntries.map((entry) => (
            <div
              key={entry.request.id}
              className="flex items-center gap-2 px-3 py-0.5 text-[11px] hover:bg-elevated/40"
            >
              <Toggle
                checked={!skipped.has(entry.request.id)}
                onChange={(include) =>
                  setSkipped((prev) => {
                    const next = new Set(prev);
                    if (include) next.delete(entry.request.id);
                    else next.add(entry.request.id);
                    return next;
                  })
                }
                title="Include in the run"
              />
              <span
                className={`w-11 flex-none font-mono text-[10px] font-bold ${methodColor(
                  entry.request.method,
                )}`}
              >
                {entry.request.method.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {entry.path.length > 0 && (
                  <span className="text-muted">
                    {entry.path.join(" / ")} /{" "}
                  </span>
                )}
                {entry.request.name}
              </span>
            </div>
          ))}
        </div>
      </details>

      {/* Summary */}
      {(results.length > 0 || running) && (
        <div className="flex flex-none items-center gap-4 border-b border-edge px-4 py-2 text-xs">
          <span className="text-muted">
            {results.length}/{entries.length * effectiveIterations} run
          </span>
          <span className="text-ok">{totals.passed} passed</span>
          <span className={totals.failed > 0 ? "text-err" : "text-muted"}>
            {totals.failed} failed
          </span>
          {totals.errors > 0 && (
            <span className="text-err">{totals.errors} errored</span>
          )}
          <span className="text-muted" title="Sum of request durations">
            {totals.timeMs} ms
          </span>
          <Toggle
            checked={failedOnly}
            onChange={setFailedOnly}
            label="Failures only"
            title="Show only rows that errored or failed an assertion"
          />
          {currentName && (
            <span className="ml-auto truncate text-muted">
              Sending {currentName}…
            </span>
          )}
        </div>
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {results.length === 0 && !running ? (
          <p className="p-6 text-center text-muted">
            {entries.length === 0
              ? "Nothing to run — save some requests first."
              : "Run the collection to execute every saved request and its assertions."}
          </p>
        ) : (
          visibleResults.map((result) => {
            const failed = result.results.filter((a) => !a.passed).length;
            const open =
              expandedRow === `${result.iteration}:${result.request.id}`;
            const rowState = result.error
              ? "border-l-err"
              : failed > 0
                ? "border-l-err"
                : "border-l-ok";
            return (
              <div
                key={`${result.iteration}:${result.request.id}`}
                className="border-b border-edge"
              >
                <div
                  onClick={() =>
                    setExpandedRow(open ? null : `${result.iteration}:${result.request.id}`)
                  }
                  className={`flex cursor-default items-center gap-3 border-l-2 px-4 py-2 text-xs hover:bg-elevated/40 ${rowState}`}
                >
                  <span
                    className={`w-12 flex-none font-mono font-bold ${methodColor(
                      result.request.method,
                    )}`}
                  >
                    {result.request.method.toUpperCase()}
                  </span>
                  {iterations > 1 && (
                    <span className="w-8 flex-none font-mono text-[10px] text-muted">
                      #{result.iteration}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {result.path.length > 0 && (
                      <span className="text-muted">
                        {result.path.join(" / ")} /{" "}
                      </span>
                    )}
                    {result.request.name}
                  </span>
                  {result.error ? (
                    <span className="flex-none text-err">error</span>
                  ) : (
                    <span
                      className={`flex-none font-mono ${statusColor(
                        result.status,
                      )}`}
                    >
                      {result.status}
                    </span>
                  )}
                  <span className="w-16 flex-none text-right font-mono text-muted">
                    {result.timeMs} ms
                  </span>
                  <span
                    className={`w-16 flex-none text-right font-mono ${
                      failed > 0 ? "text-err" : "text-ok"
                    }`}
                  >
                    {result.results.length > 0
                      ? `${result.results.length - failed}/${result.results.length}`
                      : "—"}
                  </span>
                </div>

                {open && (
                  <div className="bg-panel px-4 py-2 text-xs">
                    <div className="mb-1 font-mono text-muted">
                      {result.request.url}
                    </div>
                    {result.error && (
                      <div className="whitespace-pre-wrap font-mono text-err">
                        {result.error}
                      </div>
                    )}
                    {result.results.map((assertion, i) => (
                      <div
                        key={i}
                        className={`py-0.5 ${
                          assertion.passed ? "text-muted" : "text-err"
                        }`}
                      >
                        {assertion.passed ? "✓" : "✕"} {assertion.message}
                      </div>
                    ))}
                    {!result.error && result.results.length === 0 && (
                      <div className="text-muted">No assertions defined.</div>
                    )}
                    {result.body !== "" && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-muted">
                          Response body ({result.body.length} bytes)
                        </summary>
                        <pre className="mt-1 max-h-64 overflow-auto rounded border border-edge bg-canvas p-2 font-mono text-[11px] whitespace-pre-wrap">
                          {result.body.slice(0, 20_000)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
