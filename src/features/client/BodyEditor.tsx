import { Select } from "../../shared/components/Field";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CodeEditor } from "../../shared/components/CodeEditor";
import { fieldSnippet, GraphqlSchemaPanel } from "./GraphqlSchemaPanel";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { introspect, schemaToMarkdown, type GraphqlSchema } from "../../shared/lib/graphql";
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
  { value: "binary", label: "binary", disabled: true },
];

const LANGUAGES: { value: RawLanguage; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "text", label: "Text" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "javascript", label: "JavaScript" },
];

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
      {/* Mode selector */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 pb-2">
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
            <button
              onClick={() => onBodyChange(beautify(body, config.rawLanguage))}
              className="ml-auto text-xs text-brand hover:underline"
            >
              Beautify
            </button>
          </>
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
        />
      )}

      {config.bodyMode === "binary" && (
        <p className="py-4 text-center text-xs text-muted">
          Binary bodies are not supported yet.
        </p>
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
          </div>
          <CodeEditor
            value={config.graphqlQuery}
            onChange={(graphqlQuery) => onConfigChange({ graphqlQuery })}
            placeholder={"query {\n  viewer { id }\n}"}
            className="min-h-[8rem] flex-1"
            inputRef={queryRef}
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
