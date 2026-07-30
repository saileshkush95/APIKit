import { useEffect, useState } from "react";
import { Input, Select } from "../../shared/components/Field";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { Modal } from "../../shared/components/Modal";
import { activeRows } from "../../shared/lib/rows";
import { matchHeaders, matchHeaderValues } from "../../shared/lib/headerSuggestions";
import { methodColor, statusColor } from "../../shared/lib/ui";
import { HTTP_METHODS, type Header } from "../../shared/types";
import type { HeldRequest, InterceptDecision } from "../../shared/lib/api";

interface Props {
  held: HeldRequest;
  /** How many more are queued behind this one. */
  queued: number;
  onResolve: (decision: InterceptDecision) => void;
}

/** Edit a request paused at a breakpoint, then forward or drop it. */
export function HeldRequestDialog({ held, queued, onResolve }: Props) {
  const isResponse = held.kind === "response";
  const [method, setMethod] = useState(held.method);
  const [status, setStatus] = useState(held.status ?? 200);
  const [url, setUrl] = useState(held.url);
  const [headers, setHeaders] = useState<Header[]>(held.headers);
  const [body, setBody] = useState(held.body);
  const [tab, setTab] = useState<"headers" | "body">(
    held.body ? "body" : "headers",
  );

  // Each held request gets its own values, even while the dialog stays open.
  useEffect(() => {
    setMethod(held.method);
    setStatus(held.status ?? 200);
    setUrl(held.url);
    setHeaders(held.headers);
    setBody(held.body);
    setTab(held.body ? "body" : "headers");
  }, [held]);

  function resolve(action: "forward" | "abort") {
    onResolve({
      action,
      status: isResponse ? status : null,
      method,
      url,
      headers: activeRows(headers),
      body,
    });
  }

  return (
    <Modal
      title={`Paused ${isResponse ? "response" : "request"}${
        queued > 0 ? ` · ${queued} waiting` : ""
      }`}
      width="max-w-4xl"
      // Closing without deciding would leave the connection hanging until it
      // times out, so the backdrop forwards it untouched.
      onClose={() => resolve("forward")}
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          {isResponse ? (
            <Input
              size="compact"
              mono
              type="number"
              value={status}
              onChange={(e) => setStatus(Number(e.target.value) || 200)}
              className={`w-20 flex-none font-bold ${statusColor(status)}`}
              title="Status returned to the client"
            />
          ) : (
            <Select
              size="compact"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className={`w-24 flex-none cursor-pointer font-mono font-bold ${methodColor(
                method,
              )}`}
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m} className="text-ink">
                  {m}
                </option>
              ))}
            </Select>
          )}
          <Input
            size="compact"
            mono
            value={url}
            spellCheck={false}
            readOnly={isResponse}
            onChange={(e) => setUrl(e.target.value)}
            className="min-w-0 flex-1"
            title={isResponse ? "The request this answers" : undefined}
          />
        </div>

        <div className="flex items-center gap-1 border-b border-edge">
          {(
            [
              ["headers", "Headers", activeRows(headers).length],
              ["body", "Body", body ? 1 : 0],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-1 text-xs ${
                tab === key
                  ? "border-brand font-medium text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {label}
              {count > 1 && (
                <span className="ml-1.5 text-[9px] text-muted">{count}</span>
              )}
            </button>
          ))}
        </div>

        <div className={tab === "headers" ? "" : "hidden"}>
          <KeyValueEditor
            rows={headers.length ? headers : [{ name: "", value: "" }]}
            onChange={setHeaders}
            keyPlaceholder="Header"
            valuePlaceholder="Value"
            allowDisable
            suggestName={(query) => matchHeaders(query)}
            suggestValue={matchHeaderValues}
          />
        </div>

        <div className={tab === "body" ? "" : "hidden"}>
          <textarea
            value={body}
            spellCheck={false}
            placeholder="No body"
            onChange={(e) => setBody(e.target.value)}
            className="h-64 w-full resize-y rounded-md border border-edge bg-panel p-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-brand"
          />
        </div>

        <div className="flex items-center gap-2 border-t border-edge pt-2">
          <button
            onClick={() => resolve("forward")}
            className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-bright"
          >
            Forward
          </button>
          {!isResponse && (
            <button
              onClick={() => resolve("abort")}
              className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-err hover:text-err"
            >
              Drop
            </button>
          )}
          <span className="text-[11px] text-muted">
            The client is waiting.{" "}
            {isResponse
              ? "Edits apply to what it receives; Content-Length follows the body and any content encoding is cleared."
              : "Edits apply to what is actually sent; Content-Length and Host follow them."}
          </span>
        </div>
      </div>
    </Modal>
  );
}
