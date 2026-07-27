import { Input } from "../../shared/components/Field";
import { useEffect, useRef } from "react";
import { CodeEditor } from "../../shared/components/CodeEditor";
import type { Protocol, RequestConfig, StreamSession } from "../../shared/types";

interface Props {
  protocol: Protocol;
  config: RequestConfig;
  session: StreamSession;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
  onSend: () => void;
  onClear: () => void;
}

const STATE_COLORS: Record<StreamSession["state"], string> = {
  idle: "text-muted",
  connecting: "text-warn",
  open: "text-ok",
  closed: "text-muted",
  error: "text-err",
};

function timeOf(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/** Message composer plus live event log for the streaming protocols. */
export function StreamConsole({
  protocol,
  config,
  session,
  onConfigChange,
  onSend,
  onClear,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow the tail unless the user has scrolled up to read history.
  useEffect(() => {
    if (pinnedToBottom.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [session.events.length]);

  const canSend = session.state === "open" && protocol !== "sse";
  const receiveOnly = protocol === "sse" || protocol === "graphqlws";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Composer */}
      {!receiveOnly && (
        <div className="flex flex-none flex-col gap-2 border-b border-edge p-3">
          {protocol === "mqtt" && (
            <Input
              value={config.mqttPublishTopic}
              spellCheck={false}
              placeholder="Publish topic, e.g. sensors/temperature"
              onChange={(e) =>
                onConfigChange({ mqttPublishTopic: e.target.value })
              }
              className="wrk-field mono"
            />
          )}
          <CodeEditor
            value={config.streamMessage}
            onChange={(streamMessage) => onConfigChange({ streamMessage })}
            placeholder={
              protocol === "socketio"
                ? '{ "event": "message", "data": { "hello": "world" } }'
                : '{ "hello": "world" }'
            }
            className="h-24"
          />
          <button
            onClick={onSend}
            disabled={!canSend}
            className="self-start rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:cursor-default disabled:opacity-50"
          >
            {protocol === "mqtt" ? "Publish" : "Send message"}
          </button>
        </div>
      )}

      {/* Event log */}
      <div className="flex flex-none items-center gap-3 px-3 py-1.5 text-xs">
        <span className={STATE_COLORS[session.state]}>
          ● {session.state}
          {session.detail ? ` — ${session.detail}` : ""}
        </span>
        <span className="text-muted">{session.events.length} messages</span>
        <button
          onClick={onClear}
          className="ml-auto rounded px-2 py-0.5 text-muted hover:bg-elevated hover:text-ink"
        >
          Clear
        </button>
      </div>

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto border-t border-edge"
      >
        {session.events.length === 0 ? (
          <p className="p-6 text-center text-muted">
            {session.state === "open"
              ? "Connected — messages will appear here."
              : "Connect to start streaming."}
          </p>
        ) : (
          session.events.map((event, i) => (
            <div
              key={i}
              className="flex items-start gap-2 border-b border-edge px-3 py-1.5 font-mono text-xs"
            >
              <span
                className={`w-4 flex-none font-bold ${
                  event.direction === "in"
                    ? "text-ok"
                    : event.direction === "out"
                      ? "text-brand"
                      : "text-muted"
                }`}
                title={event.direction}
              >
                {event.direction === "in"
                  ? "↓"
                  : event.direction === "out"
                    ? "↑"
                    : "•"}
              </span>
              <span className="w-16 flex-none text-muted">
                {timeOf(event.atMs)}
              </span>
              {event.label && (
                <span className="max-w-40 flex-none truncate text-redirect">
                  {event.label}
                </span>
              )}
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                {event.data}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
