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
import { replaceAll } from "../../shared/lib/textEdit";
import { interpolate, referencedVars } from "../../shared/lib/vars";
import { useEnvironments } from "../../shared/state/environments";
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

/** Every schema has these, whether or not it says so. */
const BUILT_IN_SCALAR_NAMES = ["Boolean", "Float", "ID", "Int", "String"];

/** The kinds a variable may be declared as, and what to call each one. */
const INPUT_KIND_LABELS: Record<string, string> = {
  SCALAR: "scalar",
  ENUM: "enum",
  INPUT_OBJECT: "input",
};

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
  // Lets Beautify rewrite the body through the textarea, which keeps it undoable.
  const rawRef = useRef<HTMLTextAreaElement | null>(null);

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
              onClick={() => {
                const formatted = beautify(body, config.rawLanguage);
                // Through the field where possible, so one Cmd+Z undoes the
                // reformat instead of there being no way back.
                if (!replaceAll(rawRef.current, formatted)) onBodyChange(formatted);
              }}
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
          historyId="formData"
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
          historyId="urlEncoded"
          highlightVariables
        />
      )}

      {config.bodyMode === "raw" && (
        <CodeEditor
          value={body}
          onChange={onBodyChange}
          inputRef={rawRef}
          historyKey="body"
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

/** Where the variables sit relative to the query. */
type GqlLayout = "vertical" | "horizontal";

const GQL_LAYOUTS: { value: GqlLayout; icon: string; title: string }[] = [
  { value: "vertical", icon: "⬓", title: "Variables under the query" },
  { value: "horizontal", icon: "◨", title: "Variables beside the query" },
];

/** How tall the variables are stacked, how wide they are beside — never both. */
function sizeKey(layout: GqlLayout): string {
  return layout === "horizontal" ? "graphqlVarsWidth" : "graphqlVarsHeight";
}

/** In pixels, not a fraction of the pane: the pane has no height to take a
 *  fraction of when it is shorter than the two editors and scrolls instead. */
function storedSize(layout: GqlLayout): number | null {
  const stored = Number(localStorage.getItem(sizeKey(layout)));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/** Neither editor may be dragged smaller than this. */
const MIN_SECTION = 72;

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
  const { vars } = useEnvironments();
  const [schema, setSchema] = useState<GraphqlSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryRef = useRef<HTMLTextAreaElement | null>(null);
  const varsRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFetched = useRef<string>("");

  // Side by side suits a wide window — a query and the variables it declares
  // are read together, and neither has to be scrolled past to reach the other.
  // Stacked suits a narrow one. The choice is remembered for every request,
  // since it follows the shape of the window rather than of any one operation.
  const [layout, setLayout] = useState<GqlLayout>(() =>
    localStorage.getItem("graphqlEditorLayout") === "horizontal"
      ? "horizontal"
      : "vertical",
  );

  function chooseLayout(next: GqlLayout) {
    setLayout(next);
    localStorage.setItem("graphqlEditorLayout", next);
    // Each arrangement keeps its own size, so turning the editors and turning
    // them back brings you to what you set rather than to a default.
    setVarsSize(storedSize(next));
  }
  const side = layout === "horizontal";

  // The divider. `null` is "no size chosen": stacked that means the default
  // band, beside it means an even split.
  const rowRef = useRef<HTMLDivElement>(null);
  const [varsSize, setVarsSize] = useState<number | null>(() =>
    storedSize(layout),
  );
  const [dragging, setDragging] = useState(false);
  const latestSize = useRef<number | null>(varsSize);
  latestSize.current = varsSize;

  useEffect(() => {
    if (!dragging) return;
    // A drag is a pointer gesture, not a text one: without this the mousemove
    // selects every line it sweeps over.
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = "none";
    document.body.style.cursor = side ? "col-resize" : "row-resize";

    function onMove(e: MouseEvent) {
      const box = rowRef.current?.getBoundingClientRect();
      if (!box) return;
      // Measured from the far edge, because that is the edge the variables
      // keep: the query takes whatever is left.
      const room = side ? box.width : box.height;
      const from = side ? box.right - e.clientX : box.bottom - e.clientY;
      const next = Math.min(Math.max(from, MIN_SECTION), room - MIN_SECTION);
      if (!Number.isFinite(next)) return;
      latestSize.current = next;
      setVarsSize(next);
    }
    function onUp() {
      setDragging(false);
      // The ref rather than the state: the move and the release can land in the
      // same frame, and what was dragged to is what should be remembered.
      if (latestSize.current !== null) {
        localStorage.setItem(sizeKey(layout), String(Math.round(latestSize.current)));
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
    };
  }, [dragging, side, layout]);

  /** Back to the default, the way a double-click resets any divider. */
  function resetSize() {
    setVarsSize(null);
    localStorage.removeItem(sizeKey(layout));
  }

  // The query takes what is left over, and the variables take what the divider
  // gave them. They are sized in opposite ways on purpose: a flexible section
  // with nothing left to give shrinks to nothing, which is how the variables
  // used to be squeezed away entirely in a short pane with no way to scroll to
  // what was inside them.
  const querySection = side
    ? "flex min-h-[10rem] min-w-0 flex-1 flex-col"
    : "flex min-h-[8rem] flex-1 flex-col";
  const varsSection = side
    ? `flex min-h-[10rem] min-w-0 flex-col ${varsSize === null ? "flex-1" : "flex-none"}`
    : "flex flex-none flex-col";
  const varsStyle = side
    ? varsSize === null
      ? undefined
      : { width: varsSize }
    : { height: varsSize ?? 160 };

  // Field names from the introspected schema, offered while typing the query.
  // Deliberately flat — real cursor-context resolution needs a GraphQL parser,
  // and a filtered flat list is already most of the value. The one place that
  // is not good enough is a variable's type, where a field name is never the
  // answer and the schema knows exactly what is.
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

    // What a variable may be declared as. An OBJECT cannot be one: a variable
    // is input, and only scalars, enums and input objects travel that way. The
    // built-in scalars are added by hand because a schema lists a type only if
    // something in it uses that type, and `Boolean` is easy to leave unused.
    const typeNames = new Map<string, string>(
      BUILT_IN_SCALAR_NAMES.map((name) => [name, "scalar"]),
    );
    for (const type of schema.types) {
      const label = INPUT_KIND_LABELS[type.kind];
      if (label && type.name !== "" && !type.name.startsWith("__")) {
        typeNames.set(type.name, label);
      }
    }
    const types: Suggestion[] = [...typeNames]
      .map(([name, detail]) => ({ name, detail }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return (value: string, caret: number) => {
      const before = value.slice(0, caret);
      // `query Foo($id: ` and anything typed after it. Brackets and bangs are
      // part of the type being written, so `[Str` is still this position — and
      // an empty match is deliberate: right after the colon is exactly when
      // the list of what may go there is most wanted.
      const declaring =
        /\$[A-Za-z_][A-Za-z0-9_]*\s*:\s*[[!]*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
          before,
        );
      const typed = declaring
        ? (declaring[1] ?? "")
        : (/[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? null);
      if (typed === null) return null;
      const query = typed.toLowerCase();
      const items = (declaring ? types : entries).filter(
        (entry) =>
          entry.name.toLowerCase().startsWith(query) && entry.name !== typed,
      );
      return items.length > 0 ? { items, start: caret - typed.length } : null;
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

    // Wherever a key can go: at the start of the object, after a comma, or
    // part-way through one already being typed — the opening quote optional,
    // since the list is most wanted at the moment there is nothing typed yet.
    // Past the colon is a value, and the names were the wrong answer there.
    const match = /[{,]\s*(")?([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));
    if (!match) return null;
    const [, quote, typed] = match;

    // A key already written is not worth offering a second time.
    const used = new Set(
      [...value.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((entry) => entry[1]),
    );
    const query = typed.toLowerCase();
    const items = declared
      .filter(
        (entry) =>
          !used.has(entry.name) && entry.name.toLowerCase().startsWith(query),
      )
      // Without a quote already open there is nothing to insert into, so the
      // whole key goes in — `{` becomes `{"code"` rather than `{code`.
      .map((entry) =>
        quote ? entry : { name: `"${entry.name}"`, detail: entry.detail },
      );
    return items.length > 0 ? { items, start: caret - typed.length } : null;
  }

  // Introspection travels the same wire as the request, so it needs the same
  // substitution first: `{{baseUrl}}/graphql` is not an address until the
  // environment has been applied, which is why a URL that ran fine came back
  // with no schema the moment it was written with a variable in it.
  const endpoint = useMemo(() => interpolate(url, vars), [url, vars]);
  const wireHeaders = useMemo(
    () =>
      headers.map((header) => ({
        ...header,
        name: interpolate(header.name, vars),
        value: interpolate(header.value, vars),
      })),
    [headers, vars],
  );

  async function fetchSchema(target: string) {
    if (target.trim() === "") return;
    lastFetched.current = target;
    setLoading(true);
    setError(null);
    try {
      const result = await introspect(target, wireHeaders, {
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
    if (endpoint.trim() === "" || endpoint === lastFetched.current) return;
    const missing = referencedVars(endpoint);
    if (missing.length > 0) {
      // Sending it anyway fails with a transport error that names the literal
      // braces and not the variable behind them, which reads as a broken
      // endpoint rather than an environment that is not selected yet.
      lastFetched.current = "";
      setSchema(null);
      setLoading(false);
      setError(
        `No value for ${missing.map((name) => `{{${name}}}`).join(", ")} in the active environment.`,
      );
      return;
    }
    const timer = setTimeout(() => fetchSchema(endpoint), 700);
    return () => clearTimeout(timer);
  }, [endpoint]);

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
      {/* Scrolls once the sections stop fitting, so a short pane hides nothing
          it cannot be scrolled back to. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-2">
        {/* No `min-h-0` on purpose: the two must keep their own height rather
            than being squeezed under it, so a pane too short for them scrolls
            the column instead of drawing them over the attachments. */}
        <div
          ref={rowRef}
          className={`flex flex-1 ${side ? "flex-row" : "flex-col"}`}
        >
          <div className={querySection}>
            <div className="flex flex-none items-center gap-2 pb-1">
              <span className="text-[11px] font-semibold text-muted">Query</span>
              {loading && (
                <span className="text-[10px] text-muted">fetching schema…</span>
              )}
              <button
                type="button"
                onClick={() => {
                  const formatted = beautifyGraphql(config.graphqlQuery);
                  if (!replaceAll(queryRef.current, formatted)) {
                    onConfigChange({ graphqlQuery: formatted });
                  }
                }}
                className="ml-auto text-xs text-brand hover:underline"
              >
                Beautify
              </button>
            </div>
            <CodeEditor
              value={config.graphqlQuery}
              onChange={(graphqlQuery) => onConfigChange({ graphqlQuery })}
              placeholder={"query {\n  viewer { id }\n}"}
              className="min-h-0 flex-1"
              inputRef={queryRef}
              historyKey="graphql"
              language="graphql"
              suggest={suggestQuery}
              foldable
            />
          </div>
          {/* Divider. Nothing to see until the pointer is on it: a line
              between two editors that are already outlined reads as a third
              border. The area to grab is there either way. */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDoubleClick={resetSize}
            title="Drag to resize, double-click to reset"
            className={`group relative flex-none select-none ${
              side ? "mx-1 w-1.5 cursor-col-resize" : "my-1 h-1.5 cursor-row-resize"
            }`}
          >
            <div
              className={`absolute ${
                dragging ? "bg-brand" : "bg-transparent group-hover:bg-brand"
              } ${
                side
                  ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                  : "inset-x-0 top-1/2 h-px -translate-y-1/2"
              }`}
            />
          </div>
          <div className={varsSection} style={varsStyle}>
            <div className="flex flex-none items-center gap-2 pb-1">
              <span className="text-[11px] font-semibold text-muted">
                Variables
              </span>
              {/* The query has had one of these all along. Variables are JSON
                  rather than GraphQL, so it is the JSON formatter — which
                  leaves the text alone when it will not parse, the same as
                  the query's does. */}
              <button
                type="button"
                onClick={() => {
                  const formatted = beautify(config.graphqlVariables, "json");
                  if (!replaceAll(varsRef.current, formatted)) {
                    onConfigChange({ graphqlVariables: formatted });
                  }
                }}
                className="ml-auto text-xs text-brand hover:underline"
              >
                Beautify
              </button>
              {/* One button per arrangement rather than a toggle that flips:
                  which way round they sit is a choice, and it reads as one. */}
              <div className="flex items-center gap-0.5">
                {GQL_LAYOUTS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => chooseLayout(option.value)}
                    aria-pressed={layout === option.value}
                    title={option.title}
                    className={`rounded px-1 text-[11px] ${
                      layout === option.value
                        ? "bg-elevated text-ink"
                        : "text-muted hover:bg-elevated hover:text-ink"
                    }`}
                  >
                    {option.icon}
                  </button>
                ))}
              </div>
            </div>
            <CodeEditor
              value={config.graphqlVariables}
              onChange={(graphqlVariables) =>
                onConfigChange({ graphqlVariables })
              }
              placeholder="{}"
              className="min-h-0 flex-1"
              inputRef={varsRef}
              language="json"
              suggest={suggestVariables}
              foldable
            />
          </div>
        </div>
        <GraphqlFiles config={config} onConfigChange={onConfigChange} />
      </div>

      <GraphqlSchemaPanel
        schema={schema}
        loading={loading}
        error={error}
        onRefresh={() => fetchSchema(endpoint)}
        onInsert={insert}
      />
    </div>
  );
}
