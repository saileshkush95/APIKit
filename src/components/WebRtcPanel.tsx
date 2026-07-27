import { useEffect, useRef, useState } from "react";
import type { RequestConfig } from "../types";

interface Props {
  config: RequestConfig;
  onConfigChange: (patch: Partial<RequestConfig>) => void;
}

interface Candidate {
  type: string;
  protocol: string;
  address: string;
  raw: string;
}

/** Parses the `type` / `protocol` fields out of a candidate SDP line. */
function describeCandidate(candidate: RTCIceCandidate): Candidate {
  const parts = candidate.candidate.split(" ");
  const typeIndex = parts.indexOf("typ");
  return {
    type: typeIndex === -1 ? "unknown" : (parts[typeIndex + 1] ?? "unknown"),
    protocol: candidate.protocol ?? parts[2] ?? "",
    address: `${candidate.address ?? parts[4] ?? ""}:${candidate.port ?? parts[5] ?? ""}`,
    raw: candidate.candidate,
  };
}

function parseIceServers(value: string): RTCIceServer[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
}

/**
 * WebRTC has no request/response shape to test, so this checks what actually
 * matters before a call can connect: whether ICE gathering against the
 * configured STUN/TURN servers yields usable candidates.
 */
export function WebRtcPanel({ config, onConfigChange }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [state, setState] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<string>("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    return () => pcRef.current?.close();
  }, []);

  async function gather() {
    pcRef.current?.close();
    setCandidates([]);
    setError(null);
    setOffer("");
    setElapsed(null);
    setState("gathering");

    const started = performance.now();
    try {
      const pc = new RTCPeerConnection({
        iceServers: parseIceServers(config.iceServers),
      });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          setCandidates((prev) => [...prev, describeCandidate(event.candidate!)]);
        } else {
          // A null candidate marks the end of gathering.
          setState("complete");
          setElapsed(Math.round(performance.now() - started));
        }
      };
      pc.onicegatheringstatechange = () => setState(pc.iceGatheringState);

      // A data channel gives ICE something to gather for.
      pc.createDataChannel("webrequestkit");
      const description = await pc.createOffer();
      await pc.setLocalDescription(description);
      setOffer(description.sdp ?? "");
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }

  const hasReflexive = candidates.some(
    (c) => c.type === "srflx" || c.type === "relay",
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={config.iceServers}
          spellCheck={false}
          placeholder="stun:stun.l.google.com:19302, turn:user:pass@host:3478"
          onChange={(e) => onConfigChange({ iceServers: e.target.value })}
          className="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-brand"
        />
        <button
          onClick={gather}
          className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright"
        >
          Test connectivity
        </button>
      </div>

      <p className="text-[11px] text-muted">
        Creates a peer connection against the configured ICE servers and reports
        the candidates gathered. A <span className="font-mono">srflx</span> or{" "}
        <span className="font-mono">relay</span> candidate means NAT traversal
        works from this network.
      </p>

      <div className="flex items-center gap-4 text-xs">
        <span className={state === "error" ? "text-err" : "text-muted"}>
          State: {state}
        </span>
        <span className="text-muted">{candidates.length} candidates</span>
        {elapsed !== null && (
          <span className="text-muted">gathered in {elapsed} ms</span>
        )}
        {state === "complete" && (
          <span className={hasReflexive ? "text-ok" : "text-warn"}>
            {hasReflexive
              ? "NAT traversal available"
              : "host candidates only — STUN unreachable"}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded border border-err bg-err/10 p-2 font-mono text-xs text-err">
          {error}
        </div>
      )}

      {candidates.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-[11px] text-muted">
              <th className="p-1">Type</th>
              <th className="p-1">Protocol</th>
              <th className="p-1">Address</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate, i) => (
              <tr key={i} className="border-b border-edge">
                <td
                  className={`p-1 font-mono ${
                    candidate.type === "host" ? "text-muted" : "text-ok"
                  }`}
                >
                  {candidate.type}
                </td>
                <td className="p-1 font-mono text-muted">
                  {candidate.protocol}
                </td>
                <td className="p-1 font-mono">{candidate.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {offer && (
        <details className="text-xs">
          <summary className="cursor-default text-muted hover:text-ink">
            Local SDP offer
          </summary>
          <pre className="mt-1 overflow-auto rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed">
            {offer}
          </pre>
        </details>
      )}
    </div>
  );
}
