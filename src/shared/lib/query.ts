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
 * A query string can only say which named params are set and to what, so the
 * URL owns *values* — it is what the user edits in the URL bar, and it wins
 * there. The row list itself comes from `config.params`, which is the only
 * place that can hold what a URL cannot: descriptions, rows switched off, and
 * rows whose name has not been typed yet.
 *
 * The stored order is kept. Rebuilding the list from the URL instead meant any
 * row the URL could not express vanished — type a value before its name and the
 * row disappeared under the cursor — and it shuffled switched-off rows to the
 * end, moving the user's rows around behind their back.
 */
export function mergeParams(url: string, stored: KeyValue[]): KeyValue[] {
  // Consumed as rows claim them, so what is left is what the URL bar added.
  const unclaimed = parseQuery(url);
  const rows: KeyValue[] = [];

  for (const row of stored) {
    // Nothing a query string can hold, so the URL has no say: keep it as it is,
    // where it is.
    if (row.enabled === false || row.name.trim() === "") {
      rows.push(row);
      continue;
    }
    const index = unclaimed.findIndex((param) => param.name === row.name);
    // Gone from the URL means deleted there, which is a real edit.
    if (index === -1) continue;
    const [claimed] = unclaimed.splice(index, 1);
    rows.push({ ...row, value: claimed.value });
  }

  // Typed straight into the URL bar, with no stored row to attach to.
  return [...rows, ...unclaimed];
}
