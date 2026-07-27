import { Input, Select } from "../../shared/components/Field";
import { useEffect, useMemo, useRef, useState } from "react";
import { executeRequest } from "../../shared/lib/execute";
import { findNode, isFolder } from "../../shared/lib/tree";
import { methodColor, statusColor } from "../../shared/lib/ui";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
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
  const { vars, active, setVariables } = useEnvironments();
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
  const cancelRef = useRef(false);

  const folders = useMemo(() => folderOptions(tree), [tree]);

  const entries = useMemo(() => {
    if (targetId === "") return flatten(tree);
    const node = findNode(tree, targetId);
    return node && isFolder(node) ? flatten(node.children, [node.name]) : [];
  }, [tree, targetId]);

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

    for (let iteration = 1; iteration <= iterations; iteration++) {
    for (const entry of entries) {
      if (cancelRef.current) break;
      setCurrentName(entry.request.name);
      const result = await executeRequest(entry.request, {
        vars,
        settings,
        onVariables: setVariables,
      });
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
        },
      ]);
      if (delayMs > 0 && !cancelRef.current) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (cancelRef.current) break;
    }

    setCurrentName(null);
    setRunning(false);
  }

  return (
    <div className="flex min-h-0 w-full flex-col">
      {/* Controls */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Run
          <Select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="wrk-field w-56"
          >
            <option value="">Entire collection</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          Iterations
          <Input
            type="number"
            min={1}
            value={iterations}
            onChange={(e) => setIterations(Math.max(1, Number(e.target.value)))}
            className="wrk-field mono w-16"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          Delay
          <Input
            type="number"
            min={0}
            step={50}
            value={delayMs}
            onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value)))}
            className="wrk-field mono w-20"
          />
          ms
        </label>

        <span className="text-xs text-muted">
          {entries.length} request{entries.length === 1 ? "" : "s"} ·{" "}
          {active ? active.name : "no environment"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {running && (
            <button
              onClick={() => (cancelRef.current = true)}
              className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:border-err hover:text-err"
            >
              Stop
            </button>
          )}
          <button
            onClick={run}
            disabled={running || entries.length === 0}
            className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:cursor-default disabled:opacity-50"
          >
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {/* Summary */}
      {(results.length > 0 || running) && (
        <div className="flex flex-none items-center gap-4 border-b border-edge px-4 py-2 text-xs">
          <span className="text-muted">
            {results.length}/{entries.length * iterations} run
          </span>
          <span className="text-ok">{totals.passed} passed</span>
          <span className={totals.failed > 0 ? "text-err" : "text-muted"}>
            {totals.failed} failed
          </span>
          {totals.errors > 0 && (
            <span className="text-err">{totals.errors} errored</span>
          )}
          <span className="text-muted">{totals.timeMs} ms total</span>
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
          results.map((result) => {
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
