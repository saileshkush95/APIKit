// What a request picks up from the collection and from the folders above it.
//
// One chain answers every question: collection first, then each folder from the
// outside in. Nearer wins, and the request itself wins over all of them — the
// only ordering under which a folder can usefully correct a collection-wide
// default. A request can refuse an inherited header by name, which is the one
// escape hatch; everything else it simply sets for itself.

import { activeRows } from "./rows";
import { folderPathTo } from "./tree";
import type {
  Auth,
  KeyValue,
  NodeDefaults,
  NodeSettings,
  RequestConfig,
  TreeNode,
} from "../types";

/** One level of the chain, with a name for the UI to show. */
export interface DefaultsLevel {
  source: string;
  defaults: NodeDefaults;
}

/**
 * The chain for a request, outermost first.
 *
 * An unsaved request is not in the tree and has no folders, but it is still in
 * the collection — so it inherits that level and nothing else.
 */
export function defaultsChain(
  tree: TreeNode[],
  nodeId: string | null,
  collection: NodeDefaults,
): DefaultsLevel[] {
  const chain: DefaultsLevel[] = [{ source: "Collection", defaults: collection }];
  if (nodeId) {
    for (const folder of folderPathTo(tree, nodeId) ?? []) {
      chain.push({ source: folder.name, defaults: folder });
    }
  }
  return chain;
}

// ------------------------------------------------------------------- headers

/** An inherited header, and enough about where it came from to explain itself. */
export interface InheritedHeader extends KeyValue {
  /** The folder it is set on, or "Collection". */
  source: string;
  /** Whether it actually goes out with this request. */
  applied: boolean;
  /** Why not: the request excluded it, defines it itself, or turned it all off. */
  reason?: "excluded" | "overridden" | "off";
}

type HeaderDraft = {
  headers: KeyValue[];
  config: Pick<RequestConfig, "inheritHeaders" | "excludedHeaders">;
};

/**
 * Every header the chain offers, whether or not it applies.
 *
 * Rows that do not apply are kept rather than dropped: the Headers tab lists
 * them so it is clear what was inherited *and* what happened to it. Building
 * the request uses `mergeInheritedHeaders`, which keeps only what applies.
 */
export function inheritedHeaders(
  chain: DefaultsLevel[],
  draft: HeaderDraft,
): InheritedHeader[] {
  // A name set more than once resolves to the nearest source. Replacing in
  // place keeps the list in the order the names were first introduced, which is
  // the order the user sees.
  const byName = new Map<string, InheritedHeader>();
  for (const { source, defaults } of chain) {
    for (const row of activeRows(defaults.headers ?? [])) {
      byName.set(row.name.toLowerCase(), { ...row, source, applied: true });
    }
  }

  const excluded = new Set(
    (draft.config.excludedHeaders ?? []).map((name) => name.toLowerCase()),
  );
  const own = new Set(
    activeRows(draft.headers).map((row) => row.name.toLowerCase()),
  );

  return [...byName].map(([key, header]) => {
    if (!draft.config.inheritHeaders) return { ...header, applied: false, reason: "off" };
    if (excluded.has(key)) return { ...header, applied: false, reason: "excluded" };
    if (own.has(key)) return { ...header, applied: false, reason: "overridden" };
    return header;
  });
}

/**
 * The request's own headers with everything it inherits in front.
 *
 * In front, because `buildWireRequest` lets the first occurrence of a name
 * stand and the request's own row has already displaced any inherited one by
 * this point — leaving them ahead keeps a folder's `Content-Type` beating the
 * one the body mode would otherwise generate.
 */
export function mergeInheritedHeaders(
  chain: DefaultsLevel[],
  draft: HeaderDraft,
): KeyValue[] {
  const applied = inheritedHeaders(chain, draft).filter((header) => header.applied);
  if (applied.length === 0) return draft.headers;
  return [...applied.map(({ name, value }) => ({ name, value })), ...draft.headers];
}

// ---------------------------------------------------------------------- auth

/**
 * Resolves an "inherit" auth against the nearest level that defines one.
 *
 * Levels set to "inherit" keep the walk going and "none" counts as unset, so a
 * folder can sit between a request and the collection without interrupting it.
 * With nothing defining auth anywhere, nothing is applied.
 */
export function inheritedAuth(chain: DefaultsLevel[], auth: Auth): Auth {
  if (auth.type !== "inherit") return auth;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parent = chain[i].defaults.auth;
    if (parent && parent.type !== "inherit" && parent.type !== "none") return parent;
  }
  return { ...auth, type: "none" };
}

// ------------------------------------------------------------------- scripts

/**
 * Scripts wrapped around the request's own.
 *
 * Pre runs outside in, so the collection sets up before a folder refines it;
 * post runs inside out, the mirror image, so a level always tidies up after
 * everything it set up for.
 */
export function inheritedScripts(chain: DefaultsLevel[]): {
  pre: string[];
  post: string[];
} {
  const pre: string[] = [];
  const post: string[] = [];
  for (const { defaults } of chain) {
    if (defaults.preScript?.trim()) pre.push(defaults.preScript);
    if (defaults.postScript?.trim()) post.unshift(defaults.postScript);
  }
  return { pre, post };
}

// ------------------------------------------------------------------ settings

/** The nearest value set for each option, or null when nobody set one. */
export function inheritedSettings(chain: DefaultsLevel[]): NodeSettings {
  const merged: NodeSettings = {
    verifyTls: null,
    followRedirects: null,
    timeoutMs: null,
    maxRedirects: null,
  };
  for (const { defaults } of chain) {
    const level = defaults.settings;
    if (!level) continue;
    if (level.verifyTls != null) merged.verifyTls = level.verifyTls;
    if (level.followRedirects != null) merged.followRedirects = level.followRedirects;
    if (level.timeoutMs != null) merged.timeoutMs = level.timeoutMs;
    if (level.maxRedirects != null) merged.maxRedirects = level.maxRedirects;
  }
  return merged;
}

/**
 * A config with anything it left unset filled in from the chain.
 *
 * The fields stay nullable afterwards, so every existing `?? settings.x`
 * fallback to the application settings still ends the search the same way.
 */
export function withInheritedSettings(
  config: RequestConfig,
  chain: DefaultsLevel[],
): RequestConfig {
  const inherited = inheritedSettings(chain);
  return {
    ...config,
    verifyTls: config.verifyTls ?? inherited.verifyTls,
    followRedirects: config.followRedirects ?? inherited.followRedirects,
    timeoutMs: config.timeoutMs ?? inherited.timeoutMs,
    maxRedirects: config.maxRedirects ?? inherited.maxRedirects,
  };
}

/**
 * Everything at once, for the two places that assemble a request: the app's
 * send and the shared `executeRequest` behind the runner, the monitors and the
 * CLI. Keeping it in one call is what stops those two drifting apart.
 */
export function resolveInherited(
  tree: TreeNode[],
  nodeId: string | null,
  collection: NodeDefaults,
  draft: { headers: KeyValue[]; config: RequestConfig },
): {
  chain: DefaultsLevel[];
  headers: KeyValue[];
  config: RequestConfig;
  preScripts: string[];
  postScripts: string[];
} {
  const chain = defaultsChain(tree, nodeId, collection);
  const config = withInheritedSettings(
    { ...draft.config, auth: inheritedAuth(chain, draft.config.auth) },
    chain,
  );
  const scripts = inheritedScripts(chain);
  return {
    chain,
    headers: mergeInheritedHeaders(chain, { headers: draft.headers, config }),
    config,
    preScripts: scripts.pre,
    postScripts: scripts.post,
  };
}
