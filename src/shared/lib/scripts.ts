// Pre-request and post-response scripts.
//
// Scripts are the user's own code running against their own machine, so they
// execute in the renderer via `new Function` rather than a sandbox — but they
// are given an explicit `wrk` API instead of raw access to app internals, and
// every error is captured so a bad script fails only its own request.

import { isActive } from "./rows";
import type { AssertionResult, HttpResponseData, KeyValue } from "../types";
import type { WireRequest } from "./vars";

export interface ScriptLog {
  level: "log" | "error";
  message: string;
}

export interface ScriptOutcome {
  /** Variables the script set, to be written back to the environment. */
  variables: Record<string, string>;
  logs: ScriptLog[];
  tests: AssertionResult[];
  error: string | null;
}

function emptyOutcome(): ScriptOutcome {
  return { variables: {}, logs: [], tests: [], error: null };
}

function headersToObject(headers: KeyValue[]): Record<string, string> {
  const object: Record<string, string> = {};
  for (const header of headers) {
    if (isActive(header)) object[header.name] = header.value;
  }
  return object;
}

function objectToHeaders(object: Record<string, string>): KeyValue[] {
  return Object.entries(object).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Shared `wrk.env` / console plumbing for both script phases. */
function makeBase(vars: Record<string, string>, outcome: ScriptOutcome) {
  const env = {
    get: (name: string) => outcome.variables[name] ?? vars[name],
    set: (name: string, value: unknown) => {
      outcome.variables[String(name)] = String(value);
    },
    has: (name: string) => name in outcome.variables || name in vars,
    all: () => ({ ...vars, ...outcome.variables }),
  };
  const console = {
    log: (...args: unknown[]) =>
      outcome.logs.push({ level: "log", message: args.map(formatArg).join(" ") }),
    error: (...args: unknown[]) =>
      outcome.logs.push({
        level: "error",
        message: args.map(formatArg).join(" "),
      }),
  };
  return { env, console };
}

function run(source: string, api: object, console: object): string | null {
  if (source.trim() === "") return null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("wrk", "console", `"use strict";\n${source}`);
    fn(api, console);
    return null;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

/**
 * Runs a pre-request script. The script may mutate `wrk.request` in place; the
 * mutated request is returned for sending.
 */
export function runPreScript(
  source: string,
  request: WireRequest,
  vars: Record<string, string>,
): { request: WireRequest; outcome: ScriptOutcome } {
  const outcome = emptyOutcome();
  if (source.trim() === "") return { request, outcome };

  const mutable = {
    method: request.method,
    url: request.url,
    headers: headersToObject(request.headers),
    body: request.body,
  };

  const base = makeBase(vars, outcome);
  outcome.error = run(
    source,
    { request: mutable, env: base.env, variables: base.env },
    base.console,
  );

  return {
    request: {
      method: String(mutable.method || request.method),
      url: String(mutable.url ?? request.url),
      headers: objectToHeaders(mutable.headers ?? {}),
      body: mutable.body == null ? "" : String(mutable.body),
    },
    outcome,
  };
}

/**
 * Runs a post-response script. `wrk.test(name, fn)` records a result; a throw
 * inside the callback (or a falsy return) fails that test.
 */
export function runPostScript(
  source: string,
  response: HttpResponseData,
  vars: Record<string, string>,
): ScriptOutcome {
  const outcome = emptyOutcome();
  if (source.trim() === "") return outcome;

  const base = makeBase(vars, outcome);

  const responseApi = {
    status: response.status,
    statusText: response.statusText,
    timeMs: response.timeMs,
    sizeBytes: response.sizeBytes,
    headers: headersToObject(response.headers),
    body: response.body,
    json: () => JSON.parse(response.body),
  };

  const test = (name: string, fn: () => unknown) => {
    // A script test surfaces in the same list as declarative assertions, so it
    // needs the same shape.
    const record = (passed: boolean, message: string) =>
      outcome.tests.push({
        assertion: {
          id: `script:${outcome.tests.length}`,
          source: "bodyText",
          target: "",
          op: "equals",
          expected: "",
        },
        passed,
        actual: "",
        message,
      });

    try {
      const result = fn();
      if (result === false) record(false, `${name} — returned false`);
      else record(true, name);
    } catch (e) {
      record(false, `${name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  outcome.error = run(
    source,
    {
      response: responseApi,
      env: base.env,
      variables: base.env,
      test,
      expect: (value: unknown) => ({
        toBe: (other: unknown) => {
          if (value !== other) {
            throw new Error(`expected ${formatArg(other)}, got ${formatArg(value)}`);
          }
        },
        toContain: (needle: string) => {
          if (!String(value).includes(needle)) {
            throw new Error(`expected ${formatArg(value)} to contain ${needle}`);
          }
        },
      }),
    },
    base.console,
  );

  return outcome;
}
