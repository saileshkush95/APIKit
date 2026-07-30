import { useEffect, useRef, useState } from "react";
import {
  CodeEditor,
  type Suggestion,
} from "../../shared/components/CodeEditor";
import { Input } from "../../shared/components/Field";
import {
  groupSnippets,
  POST_SNIPPETS,
  PRE_SNIPPETS,
} from "../../shared/lib/scriptSnippets";
import type { RequestConfig, ScriptLogEntry } from "../../shared/types";

// The `wrk` scripting API, offered as completions. Mirrors what
// `runPreScript` / `runPostScript` actually expose — keep in step.
const COMMON_API: Suggestion[] = [
  { name: "wrk.env.get", detail: "(name) → value" },
  { name: "wrk.env.set", detail: "(name, value)" },
  { name: "wrk.env.has", detail: "(name) → boolean" },
  { name: "wrk.env.all", detail: "() → all variables" },
  { name: "console.log", detail: "(…) → script log" },
  { name: "console.error", detail: "(…) → script log" },
];

const PRE_API: Suggestion[] = [
  { name: "wrk.request.method", detail: "string" },
  { name: "wrk.request.url", detail: "string" },
  { name: "wrk.request.headers", detail: "name → value object" },
  { name: "wrk.request.body", detail: "string" },
  ...COMMON_API,
];

const POST_API: Suggestion[] = [
  { name: "wrk.response.status", detail: "number" },
  { name: "wrk.response.statusText", detail: "string" },
  { name: "wrk.response.timeMs", detail: "number" },
  { name: "wrk.response.sizeBytes", detail: "number" },
  { name: "wrk.response.headers", detail: "name → value object" },
  { name: "wrk.response.body", detail: "string" },
  { name: "wrk.response.json", detail: "() → parsed body" },
  { name: "wrk.test", detail: "(name, fn)" },
  { name: "wrk.expect", detail: "(value).toBe / .toContain" },
  ...COMMON_API,
];

function suggestApi(entries: Suggestion[]) {
  return (value: string, caret: number) => {
    // A dotted identifier being typed: `wrk.res`, `console.`, `wrk`.
    const match = /[A-Za-z_$][\w$]*(?:\.[\w$]*)*$/.exec(value.slice(0, caret));
    if (!match) return null;
    const query = match[0].toLowerCase();
    const items = entries.filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(query) &&
        entry.name.toLowerCase() !== query,
    );
    return items.length > 0 ? { items, start: caret - match[0].length } : null;
  };
}

const suggestPre = suggestApi(PRE_API);
const suggestPost = suggestApi(POST_API);

interface Props {
  config: RequestConfig;
  onChange: (patch: Partial<RequestConfig>) => void;
  logs: ScriptLogEntry[];
}

/** Pre-request and post-response scripting, with the run log. */
export function ScriptsEditor({ config, onChange, logs }: Props) {
  const [phase, setPhase] = useState<"pre" | "post">("pre");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const source = phase === "pre" ? config.preScript : config.postScript;
  const setSource = (value: string) =>
    onChange(phase === "pre" ? { preScript: value } : { postScript: value });

  const catalogue = phase === "pre" ? PRE_SNIPPETS : POST_SNIPPETS;
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? catalogue.filter(
        (snippet) =>
          snippet.label.toLowerCase().includes(needle) ||
          snippet.group.toLowerCase().includes(needle) ||
          snippet.code.toLowerCase().includes(needle),
      )
    : catalogue;
  const groups = groupSnippets(matches);

  useEffect(() => {
    if (!menuOpen) return;
    // Containment test rather than a capture-phase handler: closing on the way
    // down would unmount the list before the click reached the snippet under
    // the cursor.
    function onPointerDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  /** Appended, not inserted at the caret: a snippet is a whole statement. */
  function insert(code: string) {
    setSource(source.trim() === "" ? code : `${source.replace(/\s*$/, "")}\n${code}`);
    setMenuOpen(false);
    setQuery("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex flex-none items-center gap-0.5">
        {(
          [
            ["pre", "Pre-request"],
            ["post", "Post-response"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPhase(key)}
            className={`rounded px-2 py-0.5 text-[11px] ${
              phase === key
                ? "bg-elevated font-medium text-ink"
                : "text-muted hover:text-ink"
            }`}
          >
            {label}
            {(key === "pre" ? config.preScript : config.postScript).trim() !==
              "" && <span className="ml-1.5 text-[8px] text-ok">●</span>}
          </button>
        ))}

        {/* One button rather than a row of named snippets: the catalogue is far
            too long to sit in a toolbar, and it grows. */}
        <div ref={menuRef} className="relative ml-auto">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className={`rounded px-1.5 text-[13px] leading-none text-muted hover:bg-elevated hover:text-ink ${
              menuOpen ? "bg-elevated text-ink" : ""
            }`}
            title="Insert a snippet"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            •••
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-md border border-edge bg-panel shadow-lg"
            >
              <div className="border-b border-edge p-1.5">
                <Input
                  value={query}
                  autoFocus
                  spellCheck={false}
                  placeholder="Search snippets…"
                  size="compact"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {groups.length === 0 && (
                  <div className="px-2.5 py-2 text-[11px] text-muted">
                    No snippet matches “{query}”.
                  </div>
                )}
                {groups.map((group) => (
                  <div key={group.group}>
                    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium text-muted">
                      {group.group}
                    </div>
                    {group.items.map((snippet) => (
                      <button
                        key={snippet.label}
                        type="button"
                        onClick={() => insert(snippet.code)}
                        className="block w-full px-2.5 py-1 text-left text-[11px] text-ink hover:bg-elevated"
                        title={snippet.code}
                      >
                        {snippet.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <CodeEditor
        value={source}
        onChange={setSource}
        placeholder={
          phase === "pre"
            ? "// Runs before the request is sent.\n// wrk.request.method / .url / .headers / .body\n// wrk.env.get(name) / wrk.env.set(name, value)"
            : "// Runs when the response arrives.\n// wrk.response.status / .headers / .body / .json()\n// wrk.test(name, fn), wrk.expect(value).toBe(other)\n// wrk.env.set(name, value)"
        }
        className="min-h-[8rem] flex-1"
        language="javascript"
        suggest={phase === "pre" ? suggestPre : suggestPost}
      />

      {logs.length > 0 && (
        <div className="max-h-32 flex-none overflow-auto rounded border border-edge bg-panel">
          <div className="border-b border-edge px-2 py-1 text-[11px] font-semibold text-muted">
            Script log
          </div>
          {logs.map((entry, i) => (
            <div
              key={i}
              className={`px-2 py-0.5 font-mono text-[11px] ${
                entry.level === "error" ? "text-err" : "text-muted"
              }`}
            >
              <span className="mr-2 text-brand">
                {entry.phase === "pre" ? "pre" : "post"}
              </span>
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
