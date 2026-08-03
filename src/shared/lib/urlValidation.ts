// Per-protocol URL validation.
//
// Every protocol speaks a family of URLs — an HTTP client has no traffic
// pointing at a `ws://` endpoint, and a WebSocket has no HTTP to say. This
// checks the URL's scheme against what the selected protocol can actually
// transport, so a mismatch is caught before it is sent rather than when the
// connection fails.
//
// A URL that still carries a `{{variable}}` is left alone: the value could hold
// any scheme, and flagging it would block every request whose host comes from
// an environment variable.

import type { Protocol } from "../types";

/** Schemes a protocol may speak. `null` disables the check. */
const PROTOCOL_SCHEMES: Record<Protocol, string[] | null> = {
  rest: ["http", "https"],
  graphql: ["http", "https"],
  grpc: ["http", "https"],
  // SSE is a long-lived HTTP response, not a socket.
  sse: ["http", "https"],
  // Socket.IO prefers HTTP transport; it can fall back to a web socket.
  socketio: ["http", "https", "ws", "wss"],
  mqtt: ["mqtt", "mqtts", "ws", "wss"],
  websocket: ["ws", "wss"],
  graphqlws: ["ws", "wss"],
  // WebRTC has no URL bar of its own.
  webrtc: null,
};

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** Names a scheme the way the message will say it. */
const SCHEME_LABEL: Record<string, string> = {
  http: "HTTP",
  https: "HTTPS",
  ws: "WebSocket",
  wss: "WebSocket (secure)",
  mqtt: "MQTT",
  mqtts: "MQTT (secure)",
};

function protocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case "rest":
    case "graphql":
    case "sse":
    case "grpc":
      return "HTTP";
    case "socketio":
      return "Socket.IO";
    case "mqtt":
      return "MQTT";
    case "websocket":
      return "WebSocket";
    case "graphqlws":
      return "GraphQL Subscriptions";
    default:
      return protocol;
  }
}

/**
 * Why a URL is invalid for `protocol`, or `null` when it is fine.
 *
 * An empty URL, one still carrying `{{variables}}`, and one whose scheme the
 * protocol does not name carry no error — the first two need no warning and the
 * last cannot be judged before the variable is resolved.
 */
export function validateUrlFor(
  url: string,
  protocol: Protocol,
): string | null {
  const allowed = PROTOCOL_SCHEMES[protocol];
  if (allowed === null) return null;

  const trimmed = url.trim();
  if (trimmed === "") return null;
  if (trimmed.includes("{{")) return null;

  const match = SCHEME.exec(trimmed);
  if (!match) {
    return "Enter a full URL with a scheme, e.g. https://api.example.com.";
  }

  const scheme = match[1].toLowerCase();
  if (!allowed.includes(scheme)) {
    return `A ${SCHEME_LABEL[scheme] ?? scheme}:// URL does not fit a ${protocolLabel(
      protocol,
    )} request. Use ${allowed.map((s) => `${s}://`).join(" or ")}.`;
  }

  if (trimmed.slice(match[0].length).trim() === "") {
    return "Enter the host after the scheme.";
  }

  return null;
}