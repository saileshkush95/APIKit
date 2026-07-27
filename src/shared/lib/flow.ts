// Turning a captured proxy flow back into an editable request.

import {
  defaultConfig,
  type Flow,
  type KeyValue,
  type RawLanguage,
  type RequestDraft,
} from "../types";

/**
 * Headers the client sets for itself.
 *
 * Replaying a captured `content-length` or `host` is worse than useless — the
 * body will have been edited by then, and a stale length is a hung request.
 * `accept-encoding` and the connection headers belong to the hop, not the call.
 */
const OWNED_BY_CLIENT = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

function headerValue(flow: Flow, name: string): string {
  const found = flow.requestHeaders.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

function languageFor(contentType: string): RawLanguage {
  const type = contentType.toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("xml")) return "xml";
  if (type.includes("html")) return "html";
  if (type.includes("javascript")) return "javascript";
  return "text";
}

/** Splits a urlencoded body back into rows, so it stays editable as a form. */
function parseUrlEncoded(body: string): KeyValue[] {
  const rows: KeyValue[] = [];
  for (const pair of body.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const [name, value] =
      eq === -1 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
    try {
      rows.push({
        name: decodeURIComponent(name.replace(/\+/g, " ")),
        value: decodeURIComponent(value.replace(/\+/g, " ")),
      });
    } catch {
      // A body that is not really urlencoded; keep the pair verbatim.
      rows.push({ name, value });
    }
  }
  return rows;
}

export function flowToDraft(flow: Flow): RequestDraft {
  const contentType = headerValue(flow, "content-type");
  const config = defaultConfig();

  config.rawLanguage = languageFor(contentType);
  if (flow.requestBody === "") {
    config.bodyMode = "none";
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    config.bodyMode = "urlEncoded";
    config.urlEncoded = parseUrlEncoded(flow.requestBody);
  } else {
    // Multipart bodies land here as raw text. That is honest: the captured
    // bytes are shown as they were sent, rather than guessed back into files
    // that no longer exist on disk.
    config.bodyMode = "raw";
  }

  return {
    method: flow.method,
    url: flow.url,
    headers: flow.requestHeaders
      .filter((h) => !OWNED_BY_CLIENT.has(h.name.toLowerCase()))
      .map((h) => ({ ...h })),
    body: config.bodyMode === "raw" ? flow.requestBody : "",
    tests: [],
    config,
  };
}

/** A short name for a flow, for tabs and collection entries. */
export function flowLabel(flow: Flow): string {
  try {
    const path = new URL(flow.url).pathname;
    return `${flow.method} ${path === "/" ? flow.host : path}`;
  } catch {
    return `${flow.method} ${flow.host || flow.url}`;
  }
}
