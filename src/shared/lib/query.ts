// Query-string helpers for the Params tab. These work on the raw URL string
// rather than the `URL` API because a URL under edit may still contain
// `{{variables}}` and be unparseable.

import { activeRows } from "./rows";
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

  const query = activeRows(params)
    .map((p) => `${encode(p.name)}=${encode(p.value)}`)
    .join("&");

  return query === "" ? `${base}${fragment}` : `${base}?${query}${fragment}`;
}

/**
 * The rows to show in the Params tab, from the two places their state lives.
 *
 * A query string can only say which params are set and to what, so the URL owns
 * that much — it is what the user edits in the URL bar, and it wins. Everything
 * else has no slot in a URL and is kept in `config.params` alongside it: the
 * description, and rows switched off, which by definition are not in the URL.
 *
 * Descriptions are carried over by name. Rows that are off collect at the end,
 * because a query string cannot record where they used to sit — once a row
 * leaves the URL its position is genuinely gone, and inventing one would move
 * the user's rows around behind their back.
 */
export function mergeParams(url: string, stored: KeyValue[]): KeyValue[] {
  const described = new Map<string, string>();
  for (const row of stored) {
    if (row.enabled !== false && row.description) {
      described.set(row.name, row.description);
    }
  }

  const active = parseQuery(url).map((row) => {
    const description = described.get(row.name);
    return description ? { ...row, description } : row;
  });

  return [...active, ...stored.filter((row) => row.enabled === false)];
}
