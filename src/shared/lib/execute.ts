// One place that turns a saved request into a result: build → pre-script →
// send → post-script → assertions. Shared by the collection runner and the
// monitors so they can never drift apart.

import { sendRequest } from "./api";
import { runAssertions } from "./assertions";
import { buildWireRequest, enforceSecureUrl, resolveAuth } from "./request";
import { runPostScript, runPreScript } from "./scripts";
import type { VarMap } from "./vars";
import {
  normalizeConfig,
  type AppSettings,
  type AssertionResult,
  type SavedRequest,
  type TreeNode,
} from "../types";

export interface ExecuteContext {
  vars: VarMap;
  settings: AppSettings;
  /** Receives variables written by scripts (`wrk.env.set`). */
  onVariables?: (updates: Record<string, string>) => void;
  /** Lets "inherit from parent" auth resolve; omitted, it becomes "none". */
  tree?: TreeNode[];
}

export interface ExecuteResult {
  status: number | null;
  statusText: string;
  timeMs: number;
  error: string | null;
  results: AssertionResult[];
}

export async function executeRequest(
  request: SavedRequest,
  { vars, settings, onVariables, tree }: ExecuteContext,
): Promise<ExecuteResult> {
  const config = normalizeConfig(request.config);
  config.auth = resolveAuth(tree ?? [], request.id, config.auth);
  const built = buildWireRequest({ ...request, config }, vars);

  const pre = runPreScript(config.preScript, built, vars);
  onVariables?.(pre.outcome.variables);

  const wire = pre.request;
  const started = performance.now();

  try {
    const response = await sendRequest({
      method: wire.method,
      url: enforceSecureUrl(wire.url, settings.enforceSecure),
      headers: wire.headers.filter((h) => h.name.trim() !== ""),
      body: wire.body || null,
      timeoutMs: config.timeoutMs ?? settings.defaultTimeoutMs,
      httpVersion: config.httpVersion,
      verifyTls: config.verifyTls ?? settings.verifyTls,
      followRedirects: config.followRedirects ?? settings.followRedirects,
      maxRedirects: config.maxRedirects,
      noReferer: config.noReferer,
      noCookieJar: config.noCookieJar,
      multipart: built.multipart ?? null,
    });

    const post = runPostScript(config.postScript, response, {
      ...vars,
      ...pre.outcome.variables,
    });
    onVariables?.(post.variables);

    return {
      status: response.status,
      statusText: response.statusText,
      timeMs: response.timeMs,
      error: null,
      results: [...runAssertions(request.tests ?? [], response), ...post.tests],
    };
  } catch (e) {
    return {
      status: null,
      statusText: "",
      timeMs: Math.round(performance.now() - started),
      error: String(e),
      results: [],
    };
  }
}

/** A request counts as healthy when it responded < 400 and every test passed. */
export function isHealthy(result: ExecuteResult): boolean {
  if (result.error || result.status === null) return false;
  if (result.status >= 400) return false;
  return result.results.every((assertion) => assertion.passed);
}
