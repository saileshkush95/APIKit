import { useState } from "react";
import { Modal } from "../../shared/components/Modal";
import { Select } from "../../shared/components/Select";
import {
  HTTP_METHODS,
  PROTOCOL_LABELS,
  type Protocol,
} from "../../shared/types";

interface Props {
  /** Where the new request will live — shown as a hint. */
  parentLabel?: string;
  onClose: () => void;
  onCreate: (protocol: Protocol, method: string) => void;
}

/** Protocols a new request can be. */
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

/** REST and GraphQL carry an HTTP method; the rest have no method of their own. */
const METHOD_PROTOCOLS: Protocol[] = ["rest", "graphql"];

/**
 * Modal for creating a request from scratch. Picks the protocol — and, for the
 * HTTP ones, the method — so a new request is never silently a GET REST call.
 */
export function NewRequestDialog({ parentLabel, onClose, onCreate }: Props) {
  const [protocol, setProtocol] = useState<Protocol>("rest");
  const [method, setMethod] = useState("GET");

  const hasMethod = METHOD_PROTOCOLS.includes(protocol);
  const effectiveMethod =
    protocol === "graphql" ? "POST" : hasMethod ? method : "GET";

  function confirm() {
    onCreate(protocol, effectiveMethod);
    onClose();
  }

  return (
    <Modal
      title="New Request"
      onClose={onClose}
      width="max-w-md"
    >
      <div className="flex flex-col gap-4 p-4">
        <div>
          <div className="mb-1.5 text-[11px] tracking-wide text-muted uppercase">
            Request type
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {PROTOCOLS.map((option) => (
              <button
                key={option}
                onClick={() => setProtocol(option)}
                className={`rounded-md border px-2 py-1.5 text-xs ${
                  protocol === option
                    ? "border-brand bg-brand/10 font-medium text-ink"
                    : "border-edge text-muted hover:border-brand/50 hover:text-ink"
                }`}
              >
                {PROTOCOL_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        {hasMethod && (
          <div>
            <div className="mb-1.5 text-[11px] tracking-wide text-muted uppercase">
              Method
            </div>
            <Select
              value={effectiveMethod}
              onChange={(e) => setMethod(e.target.value)}
              disabled={protocol === "graphql"}
              className="wrk-field w-40 font-mono font-bold"
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            {protocol === "graphql" && (
              <p className="mt-1 text-[11px] text-muted">
                GraphQL requests are always POST.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-edge pt-3">
          <p className="text-[11px] text-muted">
            {parentLabel ? `Into ${parentLabel}` : "At the workspace root"}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:border-edge hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
