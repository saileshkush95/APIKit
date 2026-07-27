import { useMemo, useState } from "react";
import { Input } from "../../shared/components/Field";
import { methodColor, statusColor } from "../../shared/lib/ui";
import { useConfirm } from "../../shared/state/confirm";
import { useHistory } from "../../shared/state/history";
import type { HistoryEntry } from "../../shared/types";

interface Props {
  /** Opens the entry in a tab, exactly as it was sent. */
  onOpen: (entry: HistoryEntry) => void;
  /** Adds it to the collection so it stops being disposable. */
  onSave: (entry: HistoryEntry) => void;
}

function when(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return new Date(ms).toLocaleDateString();
}

/** Groups by day, so a long list still reads as a timeline. */
function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function HistoryPanel({ onOpen, onSave }: Props) {
  const { entries, remove, clear } = useHistory();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? entries.filter((entry) =>
          `${entry.method} ${entry.url} ${entry.name}`
            .toLowerCase()
            .includes(needle),
        )
      : entries;

    const byDay = new Map<string, HistoryEntry[]>();
    for (const entry of matching) {
      const label = dayLabel(entry.atMs);
      const list = byDay.get(label) ?? [];
      list.push(entry);
      byDay.set(label, list);
    }
    return [...byDay.entries()];
  }, [entries, query]);

  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col border-r border-edge bg-panel">
      <div className="flex flex-none items-center gap-1 border-b border-edge px-2 py-1.5">
        <span className="px-1 text-xs font-semibold text-muted">History</span>
        <button
          onClick={async () => {
            const ok = await confirm({
              title: "Clear history?",
              body: `This removes all ${entries.length} recorded request${
                entries.length === 1 ? "" : "s"
              } on this machine.`,
              confirmLabel: "Clear",
              danger: true,
            });
            if (ok) clear();
          }}
          disabled={entries.length === 0}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated hover:text-ink disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <div className="flex-none px-2 py-1.5">
        <Input
          value={query}
          size="compact"
          placeholder="Filter history…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {entries.length === 0 ? (
          <p className="px-3 py-4 text-xs leading-relaxed text-muted">
            Nothing sent yet. Every request you send is recorded here — on this
            machine only, never synced.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">No matches.</p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label}>
              <div className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                {label}
              </div>
              {items.map((entry) => (
                <div
                  key={entry.id}
                  onClick={() => onOpen(entry)}
                  onDoubleClick={() => onSave(entry)}
                  className="group flex cursor-default items-center gap-1.5 px-2 py-1 text-xs text-muted hover:bg-elevated/60"
                  title={`${entry.method} ${entry.url}\n${
                    entry.error ?? `${entry.status} · ${entry.timeMs}ms`
                  }`}
                >
                  <span
                    className={`w-10 flex-none font-mono text-[10px] font-bold ${methodColor(
                      entry.method,
                    )}`}
                  >
                    {entry.method.toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {entry.url || entry.name}
                  </span>
                  <span
                    className={`flex-none font-mono text-[10px] ${
                      entry.error ? "text-err" : statusColor(entry.status)
                    }`}
                  >
                    {entry.error ? "err" : entry.status}
                  </span>
                  <span className="w-6 flex-none text-right text-[10px] text-muted group-hover:hidden">
                    {when(entry.atMs)}
                  </span>
                  <span className="hidden flex-none items-center group-hover:flex">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSave(entry);
                      }}
                      className="px-1 text-[11px] text-muted hover:text-ink"
                      title="Save to collection"
                    >
                      ↓
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(entry.id);
                      }}
                      className="px-1 text-[11px] text-muted hover:text-err"
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
