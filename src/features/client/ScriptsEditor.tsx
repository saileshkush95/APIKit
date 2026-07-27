import { useState } from "react";
import {
  CodeEditor,
  type Suggestion,
} from "../../shared/components/CodeEditor";
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

const SNIPPETS: { label: string; code: string; phase: "pre" | "post" }[] = [
  {
    label: "Set a header",
    phase: "pre",
    code: 'wrk.request.headers["X-Request-Id"] = crypto.randomUUID();',
  },
  {
    label: "Read a variable",
    phase: "pre",
    code: 'wrk.request.url += "?token=" + wrk.env.get("token");',
  },
  {
    label: "Save a token",
    phase: "post",
    code: 'wrk.env.set("token", wrk.response.json().access_token);',
  },
  {
    label: "Assert status",
    phase: "post",
    code: 'wrk.test("status is 200", () => wrk.expect(wrk.response.status).toBe(200));',
  },
];

/** Pre-request and post-response scripting, with the run log. */
export function ScriptsEditor({ config, onChange, logs }: Props) {
  const [phase, setPhase] = useState<"pre" | "post">("pre");

  const source = phase === "pre" ? config.preScript : config.postScript;
  const setSource = (value: string) =>
    onChange(phase === "pre" ? { preScript: value } : { postScript: value });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-none items-center gap-1">
        {(
          [
            ["pre", "Pre-request"],
            ["post", "Post-response"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPhase(key)}
            className={`rounded-md px-3 py-1 text-xs ${
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

        <div className="ml-auto flex items-center gap-1">
          {SNIPPETS.filter((snippet) => snippet.phase === phase).map(
            (snippet) => (
              <button
                key={snippet.label}
                onClick={() =>
                  setSource(source ? `${source}\n${snippet.code}` : snippet.code)
                }
                className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                title={snippet.code}
              >
                {snippet.label}
              </button>
            ),
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
