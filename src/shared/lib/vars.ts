// `{{variable}}` substitution driven by the active environment.

import type { Environment, RequestDraft, Variable } from "../types";

const VAR_PATTERN = /\{\{\s*([\w.\-]+)\s*\}\}/g;

export type VarMap = Record<string, string>;

/** Later definitions win, so callers can layer globals under an environment. */
export function toVarMap(variables: Variable[]): VarMap {
  const map: VarMap = {};
  for (const v of variables) {
    if (v.name.trim() !== "") map[v.name.trim()] = v.value;
  }
  return map;
}

export function environmentVars(env: Environment | null): VarMap {
  return env ? toVarMap(env.variables) : {};
}

/** Replaces every `{{name}}` that resolves; unknown names are left untouched. */
export function interpolate(input: string, vars: VarMap): string {
  return input.replace(VAR_PATTERN, (match, name: string) =>
    name in vars ? vars[name] : match,
  );
}

/** Every distinct `{{name}}` referenced by a string. */
export function referencedVars(input: string): string[] {
  const found = new Set<string>();
  for (const match of input.matchAll(VAR_PATTERN)) found.add(match[1]);
  return [...found];
}

/** The parts of a request that actually travel over the wire. */
export type WireRequest = Omit<RequestDraft, "tests" | "config">;

function draftStrings(draft: WireRequest): string[] {
  return [
    draft.url,
    draft.body,
    ...draft.headers.flatMap((h) => [h.name, h.value]),
  ];
}

/** Names a request references that the active environment does not define. */
export function unresolvedVars(draft: WireRequest, vars: VarMap): string[] {
  const missing = new Set<string>();
  for (const s of draftStrings(draft)) {
    for (const name of referencedVars(s)) {
      if (!(name in vars)) missing.add(name);
    }
  }
  return [...missing];
}

/** Applies the environment to every field a request sends over the wire. */
export function resolveDraft(draft: WireRequest, vars: VarMap): WireRequest {
  return {
    method: draft.method,
    url: interpolate(draft.url, vars),
    headers: draft.headers.map((h) => ({
      name: interpolate(h.name, vars),
      value: interpolate(h.value, vars),
    })),
    body: interpolate(draft.body, vars),
  };
}
