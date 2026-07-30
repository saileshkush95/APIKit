import { Select } from "../../shared/components/Field";
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CodeEditor, type Suggestion } from "../../shared/components/CodeEditor";
import { fieldSnippet, GraphqlSchemaPanel } from "./GraphqlSchemaPanel";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { jsonToRows, rowsToJson } from "../../shared/lib/bodyConvert";
import type { HighlightLanguage } from "../../shared/lib/highlight";
import {
  beautifyGraphql,
  introspect,
  schemaToMarkdown,
  type GraphqlSchema,
} from "../../shared/lib/graphql";
import { notify, notifyError } from "../../shared/lib/notify";
import { beautify } from "../../shared/lib/request";
import { useSettings } from "../../shared/state/settings";
import type { BodyMode, Header, RawLanguage, RequestConfig } from "../../shared/types";

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

interface Props {
  body: string;
  config: RequestConfig;
  onBodyChange: (body: string) => void;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
  /** GraphQL introspection needs the live endpoint and its headers. */
  url?: string;
  headers?: Header[];
}

/** GraphQL is its own protocol, so it is not offered as a REST body mode. */
const MODES: { value: BodyMode; label: string; disabled?: boolean }[] = [
  { value: "none", label: "none" },
  { value: "formData", label: "form-data" },
  { value: "urlEncoded", label: "x-www-form-urlencoded" },
  { value: "raw", label: "raw" },
  { value: "binary", label: "binary" },
];

const LANGUAGES: { value: RawLanguage; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "text", label: "Text" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "javascript", label: "JavaScript" },
];

const EDITOR_LANGUAGE: Record<RawLanguage, HighlightLanguage> = {
  json: "json",
  text: "none",
  xml: "markup",
  html: "markup",
  javascript: "javascript",
};

/**
 * A single file sent as the entire request body.
 *
 * Only the path is held. The bytes are read by the backend at send time, so
 * the file is never copied into the webview and stays byte-exact — and editing
 * the file on disk changes what the next send uploads, which is what you want
 * while iterating on a fixture.
 */
function BinaryBody({
  config,
  onConfigChange,
}: {
  config: RequestConfig;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
}) {
  const path = config.binaryFilePath;

  async function pick() {
    const selected = await open({
      multiple: false,
      title: "Choose a file to send as the body",
    });
    if (typeof selected === "string") onConfigChange({ binaryFilePath: selected });
  }

  return (
    <div className="flex flex-none flex-col items-start gap-2 py-2">
      <div className="flex items-center gap-2">
        <button
          onClick={pick}
          className="rounded border border-edge px-2 py-1 text-[11px] text-ink hover:bg-elevated"
        >
          {path ? "Choose another file" : "Choose a file"}
        </button>
        {path && (
          <>
            <span className="font-mono text-[11px] text-ink" title={path}>
              {fileNameOf(path)}
            </span>
            <button
              onClick={() => onConfigChange({ binaryFilePath: "" })}
              className="text-[11px] text-muted hover:text-err"
              title="Remove"
            >
              ×
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        {path ? (
          <span className="font-mono break-all">{path}</span>
        ) : (
          "The file is sent as the raw body, unmodified. Its content type is guessed from the extension unless you set a Content-Type header yourself."
        )}
      </p>
    </div>
  );
}

/** Attachments for the GraphQL multipart request spec. */
function GraphqlFiles({
  config,
  onConfigChange,
}: {
  config: RequestConfig;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
}) {
  const files = config.graphqlFiles ?? [];

  function update(index: number, patch: Partial<(typeof files)[number]>) {
    onConfigChange({
      graphqlFiles: files.map((file, i) =>
        i === index ? { ...file, ...patch } : file,
      ),
    });
  }

  async function pick(index: number) {
    const selected = await open({ multiple: false, title: "Attach a file" });
    if (typeof selected === "string") update(index, { filePath: selected });
  }

  return (
    <div className="flex flex-none flex-col gap-1.5">
      <div className="text-[11px] font-semibold text-muted">Attachments</div>
      {files.length === 0 && (
        <p className="text-[11px] text-muted">
          Attach files to upload them with this operation (GraphQL multipart
          request spec). Each maps onto a variable in the query.
        </p>
      )}
      {files.map((file, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={file.variable}
            spellCheck={false}
            placeholder="variable, e.g. file"
            onChange={(e) => update(i, { variable: e.target.value })}
            className="w-44 flex-none rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-ink outline-none focus:border-brand"
          />
          <button
            onClick={() => pick(i)}
            className="flex-none rounded border border-edge px-2 py-1 text-xs text-muted hover:border-brand hover:text-ink"
          >
            Choose file…
          </button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
            title={file.filePath}
          >
            {file.filePath ? fileNameOf(file.filePath) : "No file selected"}
          </span>
          <button
            onClick={() =>
              onConfigChange({
                graphqlFiles: files.filter((_, index) => index !== i),
              })
            }
            className="flex-none px-1.5 text-lg leading-none text-muted hover:text-err"
            title="Remove attachment"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          onConfigChange({
            graphqlFiles: [...files, { variable: "file", filePath: "" }],
          })
        }
        className="self-start rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
      >
        + Attach file
      </button>
    </div>
  );
}

export function BodyEditor({
  body,
  config,
  onBodyChange,
  onConfigChange,
  url = "",
  headers = [],
}: Props) {
  // The GraphQL protocol drives the body directly — no mode selector.
  if (config.protocol === "graphql") {
    return (
      <GraphqlBody
        config={config}
        onConfigChange={onConfigChange}
        url={url}
        headers={headers}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Mode selector and mode-specific controls on one line. min-h matches
          the compact dropdown only raw mode shows, so the height is the same
          whatever mode is selected. */}
      <div className="flex min-h-7 flex-none flex-wrap items-center gap-x-4 gap-y-1 pb-1.5">
        {MODES.map((mode) => (
          <label
            key={mode.value}
            className={`flex items-center gap-1.5 text-xs ${
              mode.disabled
                ? "cursor-not-allowed text-muted/50"
                : "cursor-pointer text-ink"
            }`}
            title={mode.disabled ? "Binary bodies are not supported yet" : ""}
          >
            <input
              type="radio"
              name="body-mode"
              checked={config.bodyMode === mode.value}
              disabled={mode.disabled}
              onChange={() => onConfigChange({ bodyMode: mode.value })}
              className="accent-[var(--color-brand)]"
            />
            {mode.label}
          </label>
        ))}

        {config.bodyMode === "raw" && (
          <>
            <Select
              value={config.rawLanguage}
              onChange={(e) =>
                onConfigChange({ rawLanguage: e.target.value as RawLanguage })
              }
              className="wrk-field compact w-32 text-brand"
            >
              {LANGUAGES.map((language) => (
                <option
                  key={language.value}
                  value={language.value}
                  className="text-ink"
                >
                  {language.label}
                </option>
              ))}
            </Select>
            {config.rawLanguage === "json" && (
              <button
                onClick={() => {
                  try {
                    onConfigChange({
                      bodyMode: "formData",
                      formData: jsonToRows(body),
                    });
                  } catch (e) {
                    notifyError("Could not convert to form-data", e);
                  }
                }}
                className="ml-auto text-xs text-brand hover:underline"
                title="Turn the JSON object's fields into form-data rows"
              >
                To form-data
              </button>
            )}
            <button
              onClick={() => onBodyChange(beautify(body, config.rawLanguage))}
              className={`text-xs text-brand hover:underline ${
                config.rawLanguage === "json" ? "" : "ml-auto"
              }`}
            >
              Beautify
            </button>
          </>
        )}

        {(config.bodyMode === "formData" || config.bodyMode === "urlEncoded") && (
          <button
            onClick={() => {
              const rows =
                config.bodyMode === "formData"
                  ? config.formData
                  : config.urlEncoded;
              const { json, skippedFiles } = rowsToJson(rows);
              onBodyChange(json);
              onConfigChange({ bodyMode: "raw", rawLanguage: "json" });
              if (skippedFiles > 0) {
                notify(
                  "info",
                  `${skippedFiles} file ${skippedFiles === 1 ? "row" : "rows"} left out — a file cannot be a JSON value`,
                );
              }
            }}
            className="ml-auto text-xs text-brand hover:underline"
            title="Turn these rows into a raw JSON body"
          >
            To JSON
          </button>
        )}
      </div>

      {/* Mode-specific editor */}
      {config.bodyMode === "none" && (
        <p className="py-4 text-center text-xs text-muted">
          This request does not have a body.
        </p>
      )}

      {config.bodyMode === "formData" && (
        <KeyValueEditor
          allowDisable
          allowDescription
          rows={config.formData}
          onChange={(formData) => onConfigChange({ formData })}
          keyPlaceholder="Key"
          valuePlaceholder="Value"
          allowFiles
          highlightVariables
        />
      )}

      {config.bodyMode === "urlEncoded" && (
        <KeyValueEditor
          allowDisable
          allowDescription
          rows={config.urlEncoded}
          onChange={(urlEncoded) => onConfigChange({ urlEncoded })}
          keyPlaceholder="Key"
          valuePlaceholder="Value"
          highlightVariables
        />
      )}

      {config.bodyMode === "raw" && (
        <CodeEditor
          value={body}
          onChange={onBodyChange}
          placeholder='{ "key": "value" }'
          className="min-h-[10rem] flex-1"
          language={EDITOR_LANGUAGE[config.rawLanguage]}
        />
      )}

      {config.bodyMode === "binary" && (
        <BinaryBody config={config} onConfigChange={onConfigChange} />
      )}

    </div>
  );
}

/**
 * GraphQL editor with schema-aware help: the endpoint is introspected whenever
 * the URL settles, so the panel documents the live server rather than guessing.
 */
function GraphqlBody({
  config,
  onConfigChange,
  url,
  headers,
}: {
  config: RequestConfig;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
  url: string;
  headers: Header[];
}) {
  const { settings } = useSettings();
  const [schema, setSchema] = useState<GraphqlSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFetched = useRef<string>("");

  // Field names from the introspected schema, offered while typing the query.
  // Deliberately flat — real cursor-context resolution needs a GraphQL parser,
  // and a filtered flat list is already most of the value.
  const suggestQuery = useMemo(() => {
    if (!schema) return undefined;
    const entries: Suggestion[] = [];
    const seen = new Set<string>();
    for (const type of schema.types) {
      if (type.name.startsWith("__")) continue;
      for (const field of type.fields) {
        if (seen.has(field.name)) continue;
        seen.add(field.name);
        entries.push({ name: field.name, detail: field.type });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const keyword of ["query", "mutation", "subscription", "fragment"]) {
      if (!seen.has(keyword)) entries.push({ name: keyword });
    }
    return (value: string, caret: number) => {
      const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(value.slice(0, caret));
      if (!match) return null;
      const query = match[0].toLowerCase();
      const items = entries.filter(
        (entry) =>
          entry.name.toLowerCase().startsWith(query) &&
          entry.name !== match[0],
      );
      return items.length > 0
        ? { items, start: caret - match[0].length }
        : null;
    };
  }, [schema]);

  // Inside the variables JSON, a key completes to a variable the query
  // declares — `query ($id: ID!)` offers `"id"`.
  function suggestVariables(value: string, caret: number) {
    const declared = [
      ...config.graphqlQuery.matchAll(
        /\$([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,)\s]+)/g,
      ),
    ].map((match) => ({ name: match[1], detail: match[2] }));
    if (declared.length === 0) return null;
    const match = /"([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));
    if (!match) return null;
    const query = match[1].toLowerCase();
    const items = declared.filter((entry) =>
      entry.name.toLowerCase().startsWith(query),
    );
    return items.length > 0 ? { items, start: caret - match[1].length } : null;
  }

  async function fetchSchema(target: string) {
    if (target.trim() === "") return;
    lastFetched.current = target;
    setLoading(true);
    setError(null);
    try {
      const result = await introspect(target, headers, {
        timeoutMs: settings.defaultTimeoutMs,
        verifyTls: settings.verifyTls,
      });
      setSchema(result);
      // Seed empty docs with the server's own schema summary.
      if (config.docs.trim() === "") {
        onConfigChange({ docs: schemaToMarkdown(result) });
      }
    } catch (e) {
      setSchema(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Debounced so introspection does not fire on every keystroke in the URL.
  useEffect(() => {
    if (url.trim() === "" || url === lastFetched.current) return;
    const timer = setTimeout(() => fetchSchema(url), 700);
    return () => clearTimeout(timer);
  }, [url]);

  function insert(field: Parameters<typeof fieldSnippet>[0]) {
    const snippet = fieldSnippet(field);
    const source = config.graphqlQuery;
    const textarea = queryRef.current;
    const caret = textarea?.selectionStart ?? source.length;
    const next =
      source.trim() === ""
        ? `query {\n  ${snippet}\n}`
        : source.slice(0, caret) + snippet + source.slice(caret);
    onConfigChange({ graphqlQuery: next });
    requestAnimationFrame(() => textarea?.focus());
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 pr-2">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 pb-1">
            <span className="text-[11px] font-semibold text-muted">Query</span>
            {loading && (
              <span className="text-[10px] text-muted">fetching schema…</span>
            )}
            <button
              type="button"
              onClick={() =>
                onConfigChange({
                  graphqlQuery: beautifyGraphql(config.graphqlQuery),
                })
              }
              className="ml-auto text-xs text-brand hover:underline"
            >
              Beautify
            </button>
          </div>
          <CodeEditor
            value={config.graphqlQuery}
            onChange={(graphqlQuery) => onConfigChange({ graphqlQuery })}
            placeholder={"query {\n  viewer { id }\n}"}
            className="min-h-[8rem] flex-1"
            inputRef={queryRef}
            language="graphql"
            suggest={suggestQuery}
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="pb-1 text-[11px] font-semibold text-muted">
            Variables
          </div>
          <CodeEditor
            value={config.graphqlVariables}
            onChange={(graphqlVariables) => onConfigChange({ graphqlVariables })}
            placeholder="{}"
            className="h-20"
            language="json"
            suggest={suggestVariables}
          />
        </div>
        <GraphqlFiles config={config} onConfigChange={onConfigChange} />
      </div>

      <GraphqlSchemaPanel
        schema={schema}
        loading={loading}
        error={error}
        onRefresh={() => fetchSchema(url)}
        onInsert={insert}
      />
    </div>
  );
}
