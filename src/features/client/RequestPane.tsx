import { Input, Select } from "../../shared/components/Field";
import { useEffect, useRef, useState } from "react";
import { AuthEditor } from "./AuthEditor";
import { BodyEditor } from "./BodyEditor";
import { CodeDialog } from "./CodeDialog";
import { CommentsPanel } from "./CommentsPanel";
import { DocsEditor } from "./DocsEditor";
import { ConnectionEditor } from "./ConnectionEditor";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { ResponseViewer } from "./ResponseViewer";
import { ScriptsEditor } from "./ScriptsEditor";
import { StreamConsole } from "./StreamConsole";
import { TestsEditor } from "./TestsEditor";
import { WebRtcPanel } from "./WebRtcPanel";
import { applyQuery, parseQuery } from "../../shared/lib/query";
import {
  matchHeaderValues,
  matchHeaders,
} from "../../shared/lib/headerSuggestions";
import { buildWireRequest } from "../../shared/lib/request";
import { unresolvedVars } from "../../shared/lib/vars";
import { methodColor } from "../../shared/lib/ui";
import { useComments } from "../../shared/state/comments";
import { useEnvironments } from "../../shared/state/environments";
import {
  HTTP_METHODS,
  isStreaming,
  PROTOCOL_LABELS,
  type Header,
  type HttpVersion,
  type Protocol,
  type RequestConfig,
  type RequestTab,
  type RequestTabKey,
} from "../../shared/types";

interface Props {
  tab: RequestTab;
  onChange: (patch: Partial<RequestTab>) => void;
  onSend: () => void;
  onSave: () => void;
  onRename: (name: string) => void;
  onToggleConnection: () => void;
  onStreamSend: () => void;
  onClearStream: () => void;
  dirty: boolean;
  /** Folder trail of the saved request backing this tab, if any. */
  breadcrumb: string[];
}

const PROTOCOLS: Protocol[] = [
  "rest",
  "graphql",
  "websocket",
  "sse",
  "socketio",
  "mqtt",
  "graphqlws",
  "webrtc",
];

const HTTP_VERSIONS: { value: HttpVersion; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "http1", label: "HTTP/1.1" },
  { value: "http2", label: "HTTP/2" },
];

/** Request tabs relevant to each protocol. */
function tabsFor(protocol: Protocol): RequestTabKey[] {
  if (protocol === "webrtc") return [];
  if (isStreaming(protocol)) {
    return ["headers", "connection", "docs", "comments"];
  }
  if (protocol === "graphql") {
    return ["auth", "headers", "body", "scripts", "tests", "docs", "comments"];
  }
  return [
    "params",
    "auth",
    "headers",
    "body",
    "scripts",
    "tests",
    "docs",
    "comments",
  ];
}

const TAB_LABELS: Record<RequestTabKey, string> = {
  params: "Params",
  auth: "Authorization",
  headers: "Headers",
  body: "Body",
  tests: "Tests",
  scripts: "Scripts",
  docs: "Docs",
  comments: "Comments",
  connection: "Connection",
};

function PaneTab({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
        active
          ? "bg-elevated font-medium text-ink"
          : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {badge}
    </button>
  );
}

/** Postman's filled dot for tabs that carry content. */
function Dot() {
  return <span className="text-[8px] leading-none text-ok">●</span>;
}

function Count({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="text-[10px] text-muted">{count}</span>;
}

export function RequestPane({
  tab,
  onChange,
  onSend,
  onSave,
  onRename,
  onToggleConnection,
  onStreamSend,
  onClearStream,
  dirty,
  breadcrumb,
}: Props) {
  const { vars } = useEnvironments();
  const { forRequest } = useComments();
  const containerRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const protocol = tab.config.protocol;
  const streaming = isStreaming(protocol);
  const connected =
    tab.stream.state === "open" || tab.stream.state === "connecting";

  const commentCount = tab.sourceId ? forRequest(tab.sourceId).length : 0;
  const params = parseQuery(tab.url);
  const activeHeaders = tab.headers.filter((h) => h.name.trim() !== "").length;
  const hasBody = tab.config.bodyMode !== "none";
  const hasAuth = tab.config.auth.type !== "none";

  // Warn about variables the wire request still references after auth and the
  // body mode have been applied.
  const missing = unresolvedVars(buildWireRequest(tab, {}), vars);

  const visibleTabs = tabsFor(protocol);
  const reqTab = visibleTabs.includes(tab.reqTab)
    ? tab.reqTab
    : (visibleTabs[0] ?? "headers");

  function patchConfig(patch: Partial<RequestConfig>) {
    onChange({ config: { ...tab.config, ...patch } });
  }

  function switchProtocol(next: Protocol) {
    // GraphQL requests are POSTs with a GraphQL body; the rest keep theirs.
    if (next === "graphql") {
      patchConfig({ protocol: next, bodyMode: "graphql" });
      onChange({ method: "POST" });
      return;
    }
    patchConfig({
      protocol: next,
      bodyMode: tab.config.bodyMode === "graphql" ? "none" : tab.config.bodyMode,
    });
  }

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const ratio = (e.clientY - box.top) / box.height;
      setSplit(Math.min(0.85, Math.max(0.15, ratio)));
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // ⌘S / ⌘↵ / ⌘T are handled once at the window level in `ApiClient`.

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Breadcrumb + save */}
      <div className="flex flex-none items-center gap-1.5 px-4 pt-2 text-xs text-muted">
        {breadcrumb.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="truncate">{crumb}</span>
            <span className="text-muted/50">/</span>
          </span>
        ))}
        {renaming ? (
          <input
            autoFocus
            defaultValue={tab.name ?? ""}
            spellCheck={false}
            placeholder="Request name"
            onBlur={(e) => {
              onRename(e.target.value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename(e.currentTarget.value);
                setRenaming(false);
              }
              if (e.key === "Escape") setRenaming(false);
            }}
            className="min-w-40 rounded border border-brand bg-canvas px-1.5 py-0.5 text-xs text-ink outline-none"
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className="truncate rounded border border-transparent px-1 text-ink hover:border-edge"
            title="Click to rename"
          >
            {tab.name ?? "Untitled Request"}
          </button>
        )}
        {dirty && (
          <span className="text-brand" title="Unsaved changes">
            •
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {!streaming && protocol !== "webrtc" && (
            <button
              onClick={() => setShowCode(true)}
              className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
              title="Generate client code"
            >
              {"</>"} Code
            </button>
          )}
          <button
            onClick={onSave}
            className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink"
            title="Save request (⌘S)"
          >
            Save
          </button>
        </div>
      </div>

      {showCode && (
        <CodeDialog
          request={buildWireRequest(tab, vars)}
          onClose={() => setShowCode(false)}
        />
      )}

      {/* URL bar */}
      <div data-tour="urlbar" className="flex flex-none gap-2 px-4 py-2">
        <Select
          value={protocol}
          onChange={(e) => switchProtocol(e.target.value as Protocol)}
          className="wrk-field lg w-32 font-semibold text-brand"
          title="Protocol"
        >
          {PROTOCOLS.map((option) => (
            <option key={option} value={option} className="text-ink">
              {PROTOCOL_LABELS[option]}
            </option>
          ))}
        </Select>

        {!streaming && protocol !== "webrtc" && (
          <Select
            value={tab.method}
            onChange={(e) => onChange({ method: e.target.value })}
            className={`wrk-field mono lg w-28 font-bold ${methodColor(tab.method)}`}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m} className="text-ink">
                {m}
              </option>
            ))}
          </Select>
        )}

        {protocol !== "webrtc" && (
          <Input
            value={tab.url}
            spellCheck={false}
            placeholder={
              protocol === "mqtt"
                ? "mqtt://broker.example.com:1883"
                : streaming
                  ? "wss://example.com/socket"
                  : "https://api.example.com/endpoint"
            }
            onChange={(e) => onChange({ url: e.target.value })}
            onKeyDown={(e) =>
              e.key === "Enter" && (streaming ? onToggleConnection() : onSend())
            }
            className="wrk-field mono lg min-w-0 flex-1"
          />
        )}

        {!streaming && protocol !== "webrtc" && (
          <Select
            value={tab.config.httpVersion}
            onChange={(e) =>
              patchConfig({ httpVersion: e.target.value as HttpVersion })
            }
            className="wrk-field lg w-28 text-muted"
            title="HTTP version"
          >
            {HTTP_VERSIONS.map((version) => (
              <option key={version.value} value={version.value}>
                {version.label}
              </option>
            ))}
          </Select>
        )}

        {streaming ? (
          <button
            onClick={onToggleConnection}
            disabled={!tab.url}
            className={`whitespace-nowrap rounded-md px-5 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-50 ${
              connected ? "bg-err hover:opacity-90" : "bg-brand hover:bg-brand-bright"
            }`}
          >
            {connected ? "Disconnect" : "Connect"}
          </button>
        ) : protocol === "webrtc" ? null : (
          <button
            onClick={onSend}
            disabled={tab.loading || !tab.url}
            className="whitespace-nowrap rounded-md bg-brand px-5 py-2 font-semibold text-white hover:bg-brand-bright disabled:cursor-default disabled:opacity-50"
            title="Send (⌘↵)"
          >
            {tab.loading ? "Sending…" : "Send"}
          </button>
        )}
      </div>

      {missing.length > 0 && (
        <div className="mx-4 mb-2 flex-none rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          Undefined variable{missing.length > 1 ? "s" : ""}:{" "}
          <span className="font-mono">{missing.join(", ")}</span> — sent as
          literal text.
        </div>
      )}

      {/* WebRTC replaces the whole builder with its own tool. */}
      {protocol === "webrtc" ? (
        <WebRtcPanel config={tab.config} onConfigChange={patchConfig} />
      ) : (
        <>
      {/* Request builder */}
      <div
        className="flex min-h-0 flex-col border-t border-edge"
        style={{ flexBasis: `${split * 100}%`, flexGrow: 0, flexShrink: 1 }}
      >
        <div
          data-tour="request-tabs"
          className="flex flex-none items-center gap-0.5 border-b border-edge px-2 py-1"
        >
          {visibleTabs.map((key) => (
            <PaneTab
              key={key}
              active={reqTab === key}
              onClick={() => onChange({ reqTab: key })}
              badge={
                key === "params" ? (
                  params.length > 0 ? (
                    <Dot />
                  ) : null
                ) : key === "auth" ? (
                  hasAuth ? (
                    <Dot />
                  ) : null
                ) : key === "headers" ? (
                  <Count count={activeHeaders} />
                ) : key === "body" ? (
                  hasBody ? (
                    <Dot />
                  ) : null
                ) : key === "tests" ? (
                  <Count count={tab.tests.length} />
                ) : key === "docs" ? (
                  tab.config.docs.trim() !== "" ? (
                    <Dot />
                  ) : null
                ) : key === "comments" ? (
                  <Count count={commentCount} />
                ) : key === "scripts" ? (
                  tab.config.preScript.trim() !== "" ||
                  tab.config.postScript.trim() !== "" ? (
                    <Dot />
                  ) : null
                ) : null
              }
            >
              {TAB_LABELS[key]}
            </PaneTab>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
          {reqTab === "connection" && (
            <ConnectionEditor
              protocol={protocol}
              config={tab.config}
              onChange={patchConfig}
            />
          )}
          {reqTab === "params" && (
            <KeyValueEditor
              rows={params.length ? params : [{ name: "", value: "" }]}
              onChange={(rows) => onChange({ url: applyQuery(tab.url, rows) })}
              keyPlaceholder="Parameter"
              valuePlaceholder="Value"
            />
          )}
          {reqTab === "auth" && (
            <AuthEditor
              auth={tab.config.auth}
              onChange={(patch) =>
                patchConfig({ auth: { ...tab.config.auth, ...patch } })
              }
            />
          )}
          {reqTab === "headers" && (
            <KeyValueEditor
              rows={tab.headers}
              onChange={(headers) => onChange({ headers: headers as Header[] })}
              keyPlaceholder="Header"
              valuePlaceholder="Value"
              suggestName={(query) => matchHeaders(query)}
              suggestValue={matchHeaderValues}
            />
          )}
          {reqTab === "body" && (
            <BodyEditor
              body={tab.body}
              config={tab.config}
              onBodyChange={(body) => onChange({ body })}
              onConfigChange={patchConfig}
              url={tab.url}
              headers={tab.headers}
            />
          )}
          {reqTab === "docs" && (
            <DocsEditor
              config={tab.config}
              onChange={patchConfig}
              requestName={tab.name ?? "Endpoint"}
            />
          )}
          {reqTab === "comments" && (
            <CommentsPanel requestId={tab.sourceId} />
          )}
          {reqTab === "scripts" && (
            <ScriptsEditor
              config={tab.config}
              onChange={patchConfig}
              logs={tab.scriptLogs}
            />
          )}
          {reqTab === "tests" && (
            <TestsEditor
              tests={tab.tests}
              onChange={(tests) => onChange({ tests })}
            />
          )}
        </div>
      </div>

      {/* Divider */}
      <div
        onMouseDown={() => setDragging(true)}
        className="h-1 flex-none cursor-row-resize border-y border-edge bg-panel hover:bg-brand/40"
        title="Drag to resize"
      />

      {/* Response, or the live session for streaming protocols */}
      {streaming ? (
        <StreamConsole
          protocol={protocol}
          config={tab.config}
          session={tab.stream}
          onConfigChange={patchConfig}
          onSend={onStreamSend}
          onClear={onClearStream}
        />
      ) : (
      <section className="flex min-h-0 flex-1 flex-col">
        {tab.error && (
          <div className="m-3 whitespace-pre-wrap rounded-md border border-err bg-err/10 p-3 font-mono text-xs text-err">
            {tab.error}
          </div>
        )}
        {!tab.error && !tab.response && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-muted">
            Send a request to see the response.
          </div>
        )}
        {tab.response && (
          <ResponseViewer
            response={tab.response}
            results={tab.results}
            activeTab={tab.respTab}
            onTabChange={(respTab) => onChange({ respTab })}
          />
        )}
      </section>
      )}
        </>
      )}
    </div>
  );
}
