import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "../../shared/components/Field";
import { formatBytes, methodColor, statusColor } from "../../shared/lib/ui";
import {
  useConsole,
  type ConsoleEntry,
  type ConsoleLevel,
} from "../../shared/state/console";

const LEVELS: { value: ConsoleLevel | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "request", label: "Requests" },
  { value: "response", label: "Responses" },
  { value: "log", label: "Logs" },
  { value: "error", label: "Errors" },
];

const TONE: Record<ConsoleLevel, string> = {
  request: "text-brand",
  response: "text-muted",
  log: "text-muted",
  error: "text-err",
};

const MARK: Record<ConsoleLevel, string> = {
  request: "→",
  response: "←",
  log: "·",
  error: "!",
};

function time(atMs: number): string {
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
}

function Row({ entry }: { entry: ConsoleEntry }) {
  const [open, setOpen] = useState(false);
  const detail = entry.detail;
  const expandable =
    detail !== undefined &&
    ((detail.headers?.length ?? 0) > 0 || (detail.body?.length ?? 0) > 0);

  return (
    <div className="border-b border-edge/60">
      <div
        onClick={() => expandable && setOpen((prev) => !prev)}
        className={`flex items-baseline gap-2 px-3 py-1 font-mono text-[11px] ${
          expandable ? "cursor-pointer hover:bg-elevated/40" : ""
        }`}
      >
        <span className="flex-none text-muted">{time(entry.atMs)}</span>
        <span className={`w-3 flex-none ${TONE[entry.level]}`}>
          {MARK[entry.level]}
        </span>
        <span className="w-16 flex-none truncate text-muted">
          {entry.source}
        </span>
        {detail?.method && (
          <span className={`flex-none font-bold ${methodColor(detail.method)}`}>
            {detail.method}
          </span>
        )}
        <span
          className={`min-w-0 flex-1 truncate ${
            entry.level === "error" ? "text-err" : "text-ink"
          }`}
        >
          {entry.message}
        </span>
        {detail?.status != null && (
          <span className={`flex-none font-bold ${statusColor(detail.status)}`}>
            {detail.status}
          </span>
        )}
        {detail?.timeMs !== undefined && (
          <span className="flex-none text-muted">{detail.timeMs} ms</span>
        )}
        {detail?.sizeBytes !== undefined && (
          <span className="flex-none text-muted">
            {formatBytes(detail.sizeBytes)}
          </span>
        )}
      </div>

      {open && detail && (
        <div className="bg-panel px-3 py-2 font-mono text-[11px]">
          {detail.url && (
            <div className="mb-1 break-all text-muted">{detail.url}</div>
          )}
          {detail.headers?.map((header) => (
            <div key={header.name} className="flex gap-2">
              <span className="text-brand">{header.name}</span>
              <span className="min-w-0 break-all text-muted">
                {header.value}
              </span>
            </div>
          ))}
          {detail.body && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-ink">
              {detail.body.slice(0, 5000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Header toggle, with a count of what has been logged since it was cleared. */
export function ConsoleButton() {
  const { entries, open, setOpen } = useConsole();
  const errors = entries.filter((entry) => entry.level === "error").length;

  return (
    <button
      onClick={() => setOpen(!open)}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs ${
        open
          ? "border-brand text-ink"
          : "border-edge text-muted hover:bg-elevated hover:text-ink"
      }`}
      title="Console — every request, response and script line"
    >
      Console
      {errors > 0 ? (
        <span className="rounded-full bg-err/20 px-1.5 text-[10px] text-err">
          {errors}
        </span>
      ) : entries.length > 0 ? (
        <span className="text-[10px] text-muted">{entries.length}</span>
      ) : null}
    </button>
  );
}

/** Postman's console: every request, response and script line, in order. */
export function ConsolePanel() {
  const { entries, open, clear, setOpen } = useConsole();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<ConsoleLevel | "">("");
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (level && entry.level !== level) return false;
      if (needle === "") return true;
      return (
        entry.message.toLowerCase().includes(needle) ||
        entry.source.toLowerCase().includes(needle) ||
        (entry.detail?.url?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [entries, query, level]);

  // Follows the tail while it is at the bottom, which is what a log should do.
  useEffect(() => {
    if (open && follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [visible.length, open, follow]);

  if (!open) return null;

  return (
    <div className="flex h-64 flex-none flex-col border-t border-edge bg-canvas">
      <div className="flex flex-none items-center gap-2 border-b border-edge px-2 py-1">
        <span className="text-xs font-semibold text-ink">Console</span>
        <div className="flex items-center gap-0.5">
          {LEVELS.map((option) => (
            <button
              key={option.label}
              onClick={() => setLevel(option.value)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                level === option.value
                  ? "bg-elevated text-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Input
          size="compact"
          value={query}
          placeholder="Filter…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-2 w-56"
        />
        <span className="text-[11px] text-muted">
          {visible.length}
          {visible.length !== entries.length && ` of ${entries.length}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setFollow((prev) => !prev)}
            className={`rounded px-2 py-0.5 text-[11px] ${
              follow ? "text-ink" : "text-muted hover:text-ink"
            }`}
            title="Scroll to the newest entry as it arrives"
          >
            Follow
          </button>
          <button
            onClick={clear}
            className="rounded px-2 py-0.5 text-[11px] text-muted hover:text-ink"
          >
            Clear
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 text-sm leading-none text-muted hover:text-ink"
            title="Hide the console"
          >
            ×
          </button>
        </div>
      </div>

      <div
        onScroll={(e) => {
          const box = e.currentTarget;
          // Scrolling up stops the follow; returning to the bottom resumes it.
          setFollow(
            box.scrollHeight - box.scrollTop - box.clientHeight < 24,
          );
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        {visible.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted">
            {entries.length === 0
              ? "Requests, responses and anything a script prints appear here."
              : "Nothing matches."}
          </p>
        ) : (
          visible.map((entry) => <Row key={entry.id} entry={entry} />)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
