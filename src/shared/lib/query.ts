// Query-string helpers for the Params tab. These work on the raw URL string
// rather than the `URL` API because a URL under edit may still contain
// `{{variables}}` and be unparseable.

import type { KeyValue } from "../types";

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function encode(value: string): string {
  // `{{var}}` must survive encoding so the environment can still substitute it.
  return encodeURIComponent(value).replace(/%7B%7B(.+?)%7D%7D/g, "{{$1}}");
}

export function parseQuery(url: string): KeyValue[] {
  const start = url.indexOf("?");
  if (start === -1) return [];
  const hashIndex = url.indexOf("#", start);
  const query = url.slice(start + 1, hashIndex === -1 ? undefined : hashIndex);
  if (query === "") return [];

  return query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1
      ? { name: decode(pair), value: "" }
      : { name: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) };
  });
}

/** Rewrites the query of `url`, preserving the path and any fragment. */
export function applyQuery(url: string, params: KeyValue[]): string {
  const start = url.indexOf("?");
  const hashIndex = url.indexOf("#", start === -1 ? 0 : start);
  const base = start === -1 ? (hashIndex === -1 ? url : url.slice(0, hashIndex)) : url.slice(0, start);
  const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);

  const query = params
    .filter((p) => p.name.trim() !== "")
    .map((p) => `${encode(p.name)}=${encode(p.value)}`)
    .join("&");

  return query === "" ? `${base}${fragment}` : `${base}?${query}${fragment}`;
}
