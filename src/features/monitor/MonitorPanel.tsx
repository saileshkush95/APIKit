import { Toggle } from "../../shared/components/Toggle";
import { Input, Select } from "../../shared/components/Field";
import { useMemo, useState } from "react";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { isFolder } from "../../shared/lib/tree";
import { methodColor } from "../../shared/lib/ui";
import { TagInput } from "../../shared/components/TagInput";
import { smtpConfigured } from "../../shared/lib/email";
import {
  matchHeaders,
  matchHeaderValues,
} from "../../shared/lib/headerSuggestions";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useMonitors } from "../../shared/state/monitors";
import { useSettings } from "../../shared/state/settings";
import { SmtpSettings } from "./SmtpSettings";
import {
  HTTP_METHODS,
  MONITOR_INTERVALS,
  type Monitor,
  type MonitorRun,
  type MonitorTargetKind,
  type TreeNode,
} from "../../shared/types";


type MonitorSection = "checks" | "email";

const SECTIONS: { key: MonitorSection; label: string; icon: string }[] = [
  { key: "checks", label: "Health checks", icon: "◉" },
  { key: "email", label: "Email alerts", icon: "✉" },
];

function options(
  nodes: TreeNode[],
  kind: "folder" | "request",
  depth = 0,
): { id: string; label: string }[] {
  return nodes.flatMap((node) => {
    const indent = "— ".repeat(depth);
    if (isFolder(node)) {
      const children = options(node.children, kind, depth + 1);
      return kind === "folder"
        ? [{ id: node.id, label: `${indent}${node.name}` }, ...children]
        : children;
    }
    return kind === "request"
      ? [{ id: node.id, label: `${indent}${node.method} ${node.name}` }]
      : [];
  });
}

function since(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Uptime bar: one cell per recent check, oldest on the left. */
function History({ runs }: { runs: MonitorRun[] }) {
  const recent = [...runs].reverse().slice(-40);
  if (recent.length === 0) {
    return <span className="text-[11px] text-muted">No checks yet</span>;
  }
  return (
    <div className="flex items-end gap-[2px]">
      {recent.map((run) => (
        <span
          key={run.id}
          className={`h-4 w-1.5 rounded-[1px] ${
            run.ok ? "bg-ok" : "bg-err"
          }`}
          title={`${new Date(run.atMs).toLocaleString()} — ${
            run.ok ? "healthy" : run.detail
          } (${Math.round(run.avgMs)}ms)`}
        />
      ))}
    </div>
  );
}

export function MonitorPanel() {
  const { monitors, runs, busy, create, update, remove, runNow, clearHistory } =
    useMonitors();
  const { tree } = useCollection();
  const { environments } = useEnvironments();
  const { settings } = useSettings();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [section, setSection] = useState<MonitorSection>("checks");
  const smtpOk = smtpConfigured(settings);

  const byMonitor = useMemo(() => {
    const map = new Map<string, MonitorRun[]>();
    for (const run of runs) {
      const list = map.get(run.monitorId) ?? [];
      list.push(run);
      map.set(run.monitorId, list);
    }
    // Runs arrive newest-first from storage; keep that order per monitor.
    return map;
  }, [runs]);

  const folders = useMemo(() => options(tree, "folder"), [tree]);
  const requests = useMemo(() => options(tree, "request"), [tree]);

  function stats(monitor: Monitor) {
    const history = byMonitor.get(monitor.id) ?? [];
    const ok = history.filter((run) => run.ok).length;
    const uptime = history.length ? (ok / history.length) * 100 : null;
    const avg = history.length
      ? history.reduce((sum, run) => sum + run.avgMs, 0) / history.length
      : null;
    return { history, uptime, avg, last: history[0] ?? null };
  }

  return (
    <div className="flex min-h-0 w-full">
      {/* Section list, mirroring the Settings page */}
      <nav className="flex w-52 flex-none flex-col border-r border-edge p-3">
        <h1 className="px-2 pb-3 text-base font-semibold">Monitors</h1>
        {SECTIONS.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setSection(entry.key)}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs ${
              section === entry.key
                ? "bg-elevated font-medium text-ink"
                : "text-muted hover:bg-elevated/60 hover:text-ink"
            }`}
          >
            <span className="w-4 flex-none text-center text-[13px]">
              {entry.icon}
            </span>
            {entry.label}
          </button>
        ))}
        <p className="mt-auto px-2 text-[11px] leading-relaxed text-muted">
          Checks run while the app is open.
        </p>
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-5">
        {section === "email" && <SmtpSettings />}

        {section === "checks" && (
        <>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold">Health checks</h1>
            <p className="text-xs text-muted">
              Scheduled health checks. They run while the app is open and record
              every result.
            </p>
          </div>
          <button
            onClick={create}
            className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright"
          >
            + New monitor
          </button>
        </div>

        {monitors.length === 0 && (
          <p className="rounded-lg border border-edge bg-panel p-6 text-center text-xs text-muted">
            No monitors yet. Create one to check a request, a folder or the whole
            collection on a schedule.
          </p>
        )}

        {monitors.map((monitor) => {
          const { history, uptime, avg, last } = stats(monitor);
          const open = expanded === monitor.id;
          const checking = busy.has(monitor.id);

          return (
            <section
              key={monitor.id}
              className="overflow-hidden rounded-lg border border-edge bg-panel"
            >
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span
                  className={`h-2.5 w-2.5 flex-none rounded-full ${
                    checking
                      ? "bg-warn"
                      : !monitor.enabled
                        ? "bg-muted"
                        : last?.ok === false
                          ? "bg-err"
                          : last
                            ? "bg-ok"
                            : "bg-muted"
                  }`}
                  title={
                    checking
                      ? "checking"
                      : monitor.enabled
                        ? "scheduled"
                        : "paused"
                  }
                />
                <input
                  value={monitor.name}
                  spellCheck={false}
                  onChange={(e) => update(monitor.id, { name: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-ink outline-none hover:border-edge focus:border-brand"
                />

                <History runs={history} />

                <div className="flex items-center gap-3 text-xs">
                  <span
                    className={
                      uptime === null
                        ? "text-muted"
                        : uptime === 100
                          ? "text-ok"
                          : uptime >= 95
                            ? "text-warn"
                            : "text-err"
                    }
                  >
                    {uptime === null ? "—" : `${uptime.toFixed(1)}% up`}
                  </span>
                  <span className="text-muted">
                    {avg === null ? "—" : `${Math.round(avg)}ms avg`}
                  </span>
                  <span className="w-16 text-right text-muted">
                    {last ? since(last.atMs) : "never"}
                  </span>
                </div>

                <Toggle
                  checked={monitor.enabled}
                  onChange={(enabled) => update(monitor.id, { enabled })}
                  label={monitor.enabled ? "On" : "Off"}
                  title="Enable the schedule"
                />

                <button
                  onClick={() => runNow(monitor.id)}
                  disabled={checking}
                  className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                >
                  {checking ? "Checking…" : "Run now"}
                </button>
                <button
                  onClick={() => setExpanded(open ? null : monitor.id)}
                  className="rounded px-1.5 py-1 text-xs text-muted hover:bg-elevated hover:text-ink"
                  title="Settings and history"
                >
                  {open ? "▲" : "▼"}
                </button>
              </div>

              {last && !last.ok && (
                <div className="border-t border-edge bg-err/5 px-4 py-2 text-xs text-err">
                  {last.detail}
                </div>
              )}

              {open && (
                <div className="border-t border-edge px-4 py-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Check
                      <Select
                        value={monitor.targetKind}
                        onChange={(e) =>
                          update(monitor.id, {
                            targetKind: e.target.value as MonitorTargetKind,
                            targetId: null,
                          })
                        }
                        className={"wrk-field cursor-pointer"}
                      >
                        <option value="collection">Entire collection</option>
                        <option value="folder">A folder</option>
                        <option value="request">A single request</option>
                        <option value="url">A custom endpoint</option>
                      </Select>
                    </label>

                    {monitor.targetKind !== "collection" &&
                      monitor.targetKind !== "url" && (
                      <Select
                        value={monitor.targetId ?? ""}
                        onChange={(e) =>
                          update(monitor.id, { targetId: e.target.value || null })
                        }
                        className={"wrk-field w-64 cursor-pointer"}
                      >
                        <option value="">Select…</option>
                        {(monitor.targetKind === "folder"
                          ? folders
                          : requests
                        ).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    )}

                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Every
                      <Select
                        value={monitor.intervalSecs}
                        onChange={(e) =>
                          update(monitor.id, {
                            intervalSecs: Number(e.target.value),
                          })
                        }
                        className={"wrk-field cursor-pointer"}
                      >
                        {MONITOR_INTERVALS.map((interval) => (
                          <option key={interval.value} value={interval.value}>
                            {interval.label}
                          </option>
                        ))}
                      </Select>
                    </label>

                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      Environment
                      <Select
                        value={monitor.environmentId ?? ""}
                        onChange={(e) =>
                          update(monitor.id, {
                            environmentId: e.target.value || null,
                          })
                        }
                        className={"wrk-field cursor-pointer"}
                      >
                        <option value="">Active environment</option>
                        {environments.map((env) => (
                          <option key={env.id} value={env.id}>
                            {env.name}
                          </option>
                        ))}
                      </Select>
                    </label>

                    <Toggle
                      checked={monitor.notify}
                      onChange={(notify) => update(monitor.id, { notify })}
                      label="Notify on failure"
                    />

                    <Toggle
                      checked={!!monitor.emailNotify}
                      onChange={(emailNotify) =>
                        update(monitor.id, { emailNotify })
                      }
                      label="Email"
                    />

                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={() => clearHistory(monitor.id)}
                        className="rounded border border-edge px-2 py-1 text-xs text-muted hover:border-brand hover:text-ink"
                      >
                        Clear history
                      </button>
                      <button
                        onClick={() => remove(monitor.id)}
                        className="rounded border border-edge px-2 py-1 text-xs text-muted hover:border-err hover:text-err"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {monitor.emailNotify && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted">Email to</span>
                        <TagInput
                          value={monitor.emailTo ?? ""}
                          onChange={(emailTo) =>
                            update(monitor.id, { emailTo })
                          }
                          placeholder={
                            settings.smtpDefaultTo.trim() !== ""
                              ? `default: ${settings.smtpDefaultTo}`
                              : "you@example.com"
                          }
                          className="w-96 max-w-full"
                        />
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        Alert after
                        <Select
                          value={monitor.emailAfter ?? 1}
                          onChange={(e) =>
                            update(monitor.id, {
                              emailAfter: Number(e.target.value),
                            })
                          }
                          className="wrk-field cursor-pointer"
                        >
                          <option value={1}>the first failure</option>
                          <option value={2}>2 failures in a row</option>
                          <option value={3}>3 failures in a row</option>
                          <option value={5}>5 failures in a row</option>
                        </Select>
                      </label>
                      <Toggle
                        checked={monitor.emailRecovery ?? true}
                        onChange={(emailRecovery) =>
                          update(monitor.id, { emailRecovery })
                        }
                        label="Email on recovery"
                      />
                      {!smtpOk && (
                        <button
                          onClick={() => setSection("email")}
                          className="text-[11px] text-err underline-offset-2 hover:underline"
                        >
                          Set up SMTP under Email alerts first
                        </button>
                      )}
                    </div>
                  )}

                  {monitor.targetKind === "url" && (
                    <div className="mt-3 rounded border border-edge p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Select
                          value={monitor.method || "GET"}
                          onChange={(e) =>
                            update(monitor.id, { method: e.target.value })
                          }
                          className={`wrk-field mono w-28 font-bold ${methodColor(
                            monitor.method || "GET",
                          )}`}
                        >
                          {HTTP_METHODS.map((m) => (
                            <option key={m} value={m} className="text-ink">
                              {m}
                            </option>
                          ))}
                        </Select>
                        <Input
                          value={monitor.url}
                          spellCheck={false}
                          placeholder="https://api.example.com/health"
                          onChange={(e) =>
                            update(monitor.id, { url: e.target.value })
                          }
                          className={"wrk-field min-w-0 flex-1 font-mono"}
                        />
                        <label className="flex items-center gap-1.5 text-xs text-muted">
                          Expect
                          <Input
                            type="number"
                            value={monitor.expectedStatus || 200}
                            onChange={(e) =>
                              update(monitor.id, {
                                expectedStatus: Number(e.target.value),
                              })
                            }
                            className={"wrk-field w-20 font-mono"}
                          />
                        </label>
                      </div>

                      <div className="mb-1 text-[11px] font-semibold text-muted">
                        Headers
                      </div>
                      <KeyValueEditor
                        historyId={`monitor:${monitor.id}:headers`}
                        rows={
                          monitor.headers.length
                            ? monitor.headers
                            : [{ name: "", value: "" }]
                        }
                        allowDisable
                        allowDescription
                        onChange={(headers) =>
                          update(monitor.id, { headers })
                        }
                        keyPlaceholder="Header"
                        valuePlaceholder="Value"
                        highlightVariables
                        suggestName={(query) => matchHeaders(query)}
                        suggestValue={matchHeaderValues}
                      />

                      <div className="mt-2 mb-1 text-[11px] font-semibold text-muted">
                        Body
                      </div>
                      <textarea
                        value={monitor.body}
                        spellCheck={false}
                        placeholder="Leave empty for GET checks"
                        onChange={(e) =>
                          update(monitor.id, { body: e.target.value })
                        }
                        className="h-20 w-full resize-y rounded border border-edge bg-panel p-2 font-mono text-xs text-ink outline-none focus:border-brand"
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        The check passes when the endpoint answers with{" "}
                        <span className="font-mono">
                          {monitor.expectedStatus || 200}
                        </span>
                        . Environment variables work here too.
                      </p>
                    </div>
                  )}

                  <div className="mt-3 max-h-56 overflow-auto rounded border border-edge">
                    {history.length === 0 ? (
                      <p className="p-3 text-center text-xs text-muted">
                        No checks recorded yet.
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="text-left text-[11px] text-muted">
                            <th className="p-2">When</th>
                            <th className="p-2">Result</th>
                            <th className="p-2">Requests</th>
                            <th className="p-2">Avg</th>
                            <th className="p-2">Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.slice(0, 50).map((run) => (
                            <tr key={run.id} className="border-t border-edge">
                              <td className="p-2 whitespace-nowrap text-muted">
                                {new Date(run.atMs).toLocaleTimeString()}
                              </td>
                              <td
                                className={`p-2 font-mono ${
                                  run.ok ? "text-ok" : "text-err"
                                }`}
                              >
                                {run.ok ? "PASS" : `FAIL (${run.failures})`}
                              </td>
                              <td className="p-2 font-mono">{run.requests}</td>
                              <td className="p-2 font-mono">
                                {Math.round(run.avgMs)}ms
                              </td>
                              <td className="p-2 text-muted">{run.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
        </>
        )}
      </div>
      </div>
    </div>
  );
}
