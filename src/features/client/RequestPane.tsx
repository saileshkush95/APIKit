import { Select } from "../../shared/components/Field";
import { useEffect, useRef, useState } from "react";
import { AuthEditor } from "./AuthEditor";
import { BodyEditor } from "./BodyEditor";
import { CodeDialog } from "./CodeDialog";
import { CommentsPanel } from "./CommentsPanel";
import { DocsEditor } from "./DocsEditor";
import { ConnectionEditor } from "./ConnectionEditor";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { RequestSettingsPanel } from "./RequestSettingsPanel";
import { ResponseViewer } from "./ResponseViewer";
import { VariableInput } from "../../shared/components/VariableInput";
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
  onCancel: () => void;
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
  "grpc",
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
  { value: "http3", label: "HTTP/3" },
];

/** Request tabs relevant to each protocol. */
function tabsFor(protocol: Protocol): RequestTabKey[] {
  if (protocol === "webrtc") return [];
  if (isStreaming(protocol)) {
    return ["headers", "connection", "docs", "comments"];
  }
  if (protocol === "grpc") {
    return ["headers", "body", "scripts", "tests", "docs", "comments"];
  }
  if (protocol === "graphql") {
    return [
      "auth",
      "headers",
      "body",
      "scripts",
      "tests",
      "settings",
      "docs",
      "comments",
    ];
  }
  return [
    "params",
    "auth",
    "headers",
    "body",
    "scripts",
    "tests",
    "settings",
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
  settings: "Settings",
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

/** Shown in the response pane while a request is in flight. */
function LoadingResponse({ onCancel }: { onCancel: () => void }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-edge border-t-brand" />
      <div className="text-xs text-muted">
        Waiting for response… <span className="font-mono">{(elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-edge px-3 py-1 text-xs text-muted hover:border-err hover:text-err"
      >
        Cancel request
      </button>
    </div>
  );
}

export function RequestPane({
  tab,
  onChange,
  onSend,
  onCancel,
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
  /** The two resizable panes; the drag ratio is relative to this box. */
  const splitRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(0.5);
  // Stacked or side by side. A wide window suits columns — a long response and
  // a long request body are both easier to read without scrolling.
  const [layout, setLayout] = useState<"vertical" | "horizontal">(() =>
    localStorage.getItem("clientLayout") === "horizontal"
      ? "horizontal"
      : "vertical",
  );
  const columns = layout === "horizontal";
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

  /** Sits at the end of the response's status line, in both states. */
  const layoutButton = (
    <button
      onClick={() => {
        const next = columns ? "vertical" : "horizontal";
        setLayout(next);
        localStorage.setItem("clientLayout", next);
      }}
      className="rounded px-1 text-[11px] text-muted hover:bg-elevated hover:text-ink"
      title={
        columns
          ? "Stack the response under the request"
          : "Put the response beside the request"
      }
    >
      {columns ? "⬓" : "◧"}
    </button>
  );

  /**
   * The response tabs, inert. Shown before the first request and while one is
   * in flight, so the pane holds its shape rather than the row appearing and
   * disappearing around every send.
   */
  const placeholderTabs = (
    <div className="flex flex-none items-center gap-3 border-b border-edge px-2 py-1">
      <div className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {["Body", "Cookies", "Request", "Headers", "Test Results"].map(
          (label, index) => (
            <span
              key={label}
              className={`flex items-center rounded px-2.5 py-1 text-xs ${
                index === 0 ? "bg-elevated font-medium text-ink" : "text-muted"
              }`}
            >
              {label}
            </span>
          ),
        )}
      </div>
      <div className="ml-auto flex flex-none items-center pr-1">
        {layoutButton}
      </div>
    </div>
  );

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

    // A drag is a pointer gesture, not a text gesture: without this the
    // mousemove selects everything it sweeps over, and the cursor flickers
    // back to a caret whenever it leaves the divider.
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = "none";
    document.body.style.cursor = columns ? "col-resize" : "row-resize";

    function onMove(e: MouseEvent) {
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      const ratio = columns
        ? box.width === 0
          ? null
          : (e.clientX - box.left) / box.width
        : box.height === 0
          ? null
          : (e.clientY - box.top) / box.height;
      if (ratio === null) return;
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
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
    };
  }, [dragging, columns]);

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

        {!streaming && protocol !== "webrtc" && protocol !== "grpc" && (
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
          <VariableInput
            value={tab.url}
            placeholder={
              protocol === "mqtt"
                ? "mqtt://broker.example.com:1883"
                : streaming
                  ? "wss://example.com/socket"
                  : "https://api.example.com/endpoint"
            }
            onChange={(url) => onChange({ url })}
            onKeyDown={(e) =>
              e.key === "Enter" && (streaming ? onToggleConnection() : onSend())
            }
            mono
            size="lg"
            className="min-w-0 flex-1"
          />
        )}

        {protocol === "grpc" && (
          <VariableInput
            value={tab.config.grpcMethod}
            onChange={(grpcMethod) => patchConfig({ grpcMethod })}
            placeholder="package.Service/Method"
            mono
            size="lg"
            className="w-72 flex-none"
            title="The method to call. The server's own descriptors are fetched by reflection, so no .proto file is needed."
          />
        )}

        {!streaming && protocol !== "webrtc" && protocol !== "grpc" && (
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
            onClick={tab.loading ? onCancel : onSend}
            disabled={!tab.loading && !tab.url}
            className={`whitespace-nowrap rounded-md px-5 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-50 ${
              tab.loading ? "bg-err hover:bg-err/80" : "bg-brand hover:bg-brand-bright"
            }`}
            title={tab.loading ? "Cancel the request" : "Send (⌘↵)"}
          >
            {tab.loading ? "Cancel" : "Send"}
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
        <div
          ref={splitRef}
          className={`flex min-h-0 min-w-0 flex-1 ${columns ? "flex-row" : "flex-col"}`}
        >
      {/* Request builder */}
      <div
        // No border on the divider's side: the divider draws its own line, and
        // the two together read as a double rule.
        className={`flex min-h-0 min-w-0 flex-col ${columns ? "" : "border-t border-edge"}`}
        style={{ flexBasis: `${split * 100}%`, flexGrow: 0, flexShrink: 1 }}
      >
        <div
          data-tour="request-tabs"
          className="flex flex-none items-center gap-0.5 overflow-x-auto border-b border-edge px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
              /* Params live in the URL, and an empty one cannot be written
                 there — so the blank row the editor adds is stripped on the way
                 out and never comes back. It is appended here instead, or there
                 would be nowhere to type the next parameter. */
              rows={[...params, { name: "", value: "" }]}
              onChange={(rows) => onChange({ url: applyQuery(tab.url, rows) })}
              keyPlaceholder="Parameter"
              valuePlaceholder="Value"
              highlightVariables
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
              highlightVariables
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
          {reqTab === "settings" && (
            <RequestSettingsPanel config={tab.config} onChange={patchConfig} />
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
      {/* One rule, with a taller invisible area to grab. `border-y` here drew a
          line on each edge of the bar, which read as two. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        className={`group relative flex-none select-none ${
          columns ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"
        }`}
        title="Drag to resize"
      >
        <div
          className={`absolute bg-edge group-hover:bg-brand ${
            columns
              ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
              : "inset-x-0 top-1/2 h-px -translate-y-1/2"
          }`}
        />
      </div>

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
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab.loading && (
          <>
            {placeholderTabs}
            <LoadingResponse onCancel={onCancel} />
          </>
        )}
        {!tab.loading && tab.error && (
          <div className="m-3 whitespace-pre-wrap rounded-md border border-err bg-err/10 p-3 font-mono text-xs text-err">
            {tab.error}
          </div>
        )}
        {!tab.loading && !tab.error && !tab.response && (
          <>
            {placeholderTabs}
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted">
              Send a request to see the response.
            </div>
          </>
        )}
        {!tab.loading && tab.response && (
          <ResponseViewer
            response={tab.response}
            results={tab.results}
            sent={tab.sent}
            activeTab={tab.respTab}
            onTabChange={(respTab) => onChange({ respTab })}
            trailing={layoutButton}
          />
        )}
      </section>
      )}
        </div>
      )}
    </div>
  );
}
