import { CodeEditor } from "./CodeEditor";
import type { Protocol, RequestConfig } from "../types";

interface Props {
  protocol: Protocol;
  config: RequestConfig;
  onChange: (patch: Partial<RequestConfig>) => void;
}

const inputCls =
  "w-full rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-brand";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-28 flex-none text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Per-protocol connection settings: MQTT credentials, GraphQL subscriptions. */
export function ConnectionEditor({ protocol, config, onChange }: Props) {
  if (protocol === "mqtt") {
    return (
      <div className="flex max-w-2xl flex-col gap-2.5">
        <Field label="Subscribe to">
          <input
            value={config.mqttTopics}
            spellCheck={false}
            placeholder="sensors/#, alerts/+/critical"
            onChange={(e) => onChange({ mqttTopics: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Client ID">
          <input
            value={config.mqttClientId}
            spellCheck={false}
            placeholder="auto-generated"
            onChange={(e) => onChange({ mqttClientId: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Username">
          <input
            value={config.mqttUsername}
            spellCheck={false}
            onChange={(e) => onChange({ mqttUsername: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Password">
          <input
            value={config.mqttPassword}
            type="password"
            spellCheck={false}
            onChange={(e) => onChange({ mqttPassword: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="QoS">
          <select
            value={config.mqttQos}
            onChange={(e) => onChange({ mqttQos: Number(e.target.value) })}
            className={`${inputCls} cursor-pointer`}
          >
            <option value={0}>0 — at most once</option>
            <option value={1}>1 — at least once</option>
            <option value={2}>2 — exactly once</option>
          </select>
        </Field>
        <p className="text-[11px] text-muted">
          Topics are comma-separated. Use{" "}
          <code className="font-mono">mqtt://host:1883</code> as the URL.
        </p>
      </div>
    );
  }

  if (protocol === "graphqlws") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="pb-1 text-[11px] font-semibold text-muted">
            Subscription
          </div>
          <CodeEditor
            value={config.graphqlQuery}
            onChange={(graphqlQuery) => onChange({ graphqlQuery })}
            placeholder={"subscription {\n  messageAdded { id text }\n}"}
            className="min-h-[8rem] flex-1"
          />
        </div>
        <div className="flex flex-none flex-col">
          <div className="pb-1 text-[11px] font-semibold text-muted">
            Variables
          </div>
          <CodeEditor
            value={config.graphqlVariables}
            onChange={(graphqlVariables) => onChange({ graphqlVariables })}
            placeholder="{}"
            className="h-20"
          />
        </div>
        <p className="text-[11px] text-muted">
          Uses the <code className="font-mono">graphql-transport-ws</code>{" "}
          protocol. The subscription is sent once the server acknowledges the
          connection.
        </p>
      </div>
    );
  }

  if (protocol === "socketio") {
    return (
      <p className="max-w-2xl text-xs leading-relaxed text-muted">
        Point the URL at the server root (for example{" "}
        <code className="font-mono">http://localhost:3000</code>) — the
        Engine.IO handshake path is added automatically. Messages can be sent as{" "}
        <code className="font-mono">{'{"event":"name","data":{…}}'}</code> or as
        a raw <code className="font-mono">42[…]</code> frame.
      </p>
    );
  }

  return (
    <p className="max-w-2xl text-xs leading-relaxed text-muted">
      {protocol === "sse"
        ? "Server-Sent Events are receive-only. Headers set on this request are sent with the initial GET."
        : "Headers set on this request are sent with the WebSocket handshake."}
    </p>
  );
}
