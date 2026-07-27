import { useState } from "react";
import { sendRequest } from "../../shared/lib/api";
import { importOpenApi, type ImportResult } from "../../shared/lib/openapi";
import { detectFormat, importPostman } from "../../shared/lib/postman";
import { defaultAuth } from "../../shared/types";
import { useSettings } from "../../shared/state/settings";
import type { Environment, KeyValue, TreeNode } from "../../shared/types";

interface Props {
  onClose: () => void;
  /** Adds the imported folders and an environment holding its variables. */
  onImport: (nodes: TreeNode[], environment: Omit<Environment, "id">) => void;
}

const fieldCls =
  "w-full rounded border border-edge bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-brand";

/** Normalises both importers onto one shape for the preview. */
function analyseDocument(text: string): ImportResult {
  if (detectFormat(text) === "postman") {
    const result = importPostman(text);
    return {
      title: result.title,
      nodes: result.nodes,
      variables: result.variables,
      // Postman keeps auth per request, so there is no single scheme to show.
      auth: defaultAuth(),
      warnings: result.warnings,
      operationCount: result.requestCount,
    };
  }
  return importOpenApi(text);
}

/** Imports an OpenAPI / Swagger / Postman document from a URL or pasted text. */
export function ImportDialog({ onClose, onImport }: Props) {
  const { settings } = useSettings();
  const [source, setSource] = useState<"url" | "paste">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function analyse() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let document = text;
      if (source === "url") {
        // Fetched through the Rust client so it is not subject to CORS.
        const response = await sendRequest({
          method: "GET",
          url,
          headers: [{ name: "Accept", value: "application/json, text/yaml, */*" }],
          timeoutMs: settings.defaultTimeoutMs,
          verifyTls: settings.verifyTls,
        });
        if (response.status >= 400) {
          throw new Error(`the spec URL returned ${response.status}`);
        }
        document = response.body;
      }
      setResult(analyseDocument(document));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (!result) return;
    const variables: KeyValue[] = result.variables;
    onImport(result.nodes, { name: result.title, variables });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-[34rem] w-[42rem] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-center gap-2 border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold">Import collection</h2>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-lg leading-none text-muted hover:bg-elevated hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 flex items-center gap-1">
            {(
              [
                ["url", "From URL"],
                ["paste", "Paste document"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSource(key)}
                className={`rounded-md px-3 py-1 text-xs ${
                  source === key
                    ? "bg-elevated font-medium text-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {source === "url" ? (
            <input
              value={url}
              spellCheck={false}
              placeholder="https://api.example.com/openapi.json"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && analyse()}
              className={`${fieldCls} font-mono`}
            />
          ) : (
            <textarea
              value={text}
              spellCheck={false}
              placeholder="Paste an OpenAPI 3 / Swagger 2 document (JSON or YAML), or a Postman collection v2.1"
              onChange={(e) => setText(e.target.value)}
              className={`${fieldCls} h-40 resize-y font-mono`}
            />
          )}

          <button
            onClick={analyse}
            disabled={busy || (source === "url" ? url === "" : text === "")}
            className="mt-3 rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
          >
            {busy ? "Reading…" : "Read spec"}
          </button>

          {error && (
            <div className="mt-3 rounded border border-err bg-err/10 px-3 py-2 text-xs text-err">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-4 rounded border border-edge">
              <div className="border-b border-edge px-3 py-2">
                <div className="text-sm font-semibold text-ink">
                  {result.title}
                </div>
                <div className="text-xs text-muted">
                  {result.operationCount} request
                  {result.operationCount === 1 ? "" : "s"} in{" "}
                  {result.nodes.length} folder
                  {result.nodes.length === 1 ? "" : "s"}
                  {result.auth.type === "none"
                    ? ""
                    : ` · ${result.auth.type} auth`}
                </div>
              </div>

              <div className="max-h-40 overflow-auto px-3 py-2">
                {result.nodes.map((node) => (
                  <div key={node.id} className="py-0.5 text-xs">
                    <span className="text-muted">📁 </span>
                    {node.name}
                    {node.kind === "folder" && (
                      <span className="text-muted">
                        {" "}
                        · {node.children.length}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {result.warnings.length > 0 && (
                <div className="border-t border-edge px-3 py-2">
                  {result.warnings.map((warning, i) => (
                    <div key={i} className="py-0.5 text-[11px] text-warn">
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-edge px-3 py-2 text-[11px] text-muted">
                Creates an environment named “{result.title}” holding the
                document's variables.
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-none items-center justify-end gap-2 border-t border-edge px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!result}
            className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
