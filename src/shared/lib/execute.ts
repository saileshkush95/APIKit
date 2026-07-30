// One place that turns a saved request into a result: build → pre-script →
// send → post-script → assertions. Shared by the collection runner and the
// monitors so they can never drift apart.

import { sendRequest } from "./api";
import { runAssertions } from "./assertions";
import { currentAccessToken } from "./oauth";
import { buildWireRequest, enforceSecureUrl, resolveAuth } from "./request";
import { tlsFor } from "./certificates";
import { activeRows } from "./rows";
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
  /**
   * Handle for `cancelRequest`, so a caller can abort the in-flight send
   * rather than waiting out its timeout.
   */
  cancelId?: string;
}

export interface ExecuteResult {
  status: number | null;
  statusText: string;
  timeMs: number;
  error: string | null;
  results: AssertionResult[];
  /** The response itself, for callers that show what came back. */
  body: string;
  headers: { name: string; value: string }[];
}

export async function executeRequest(
  request: SavedRequest,
  { vars, settings, onVariables, tree, cancelId }: ExecuteContext,
): Promise<ExecuteResult> {
  const config = normalizeConfig(request.config);
  config.auth = resolveAuth(tree ?? [], request.id, config.auth);
  // Renews the token first if it has expired, which is why this is awaited
  // before the request is assembled rather than inside it.
  const token = await currentAccessToken(config.auth, vars);
  const built = buildWireRequest({ ...request, config }, vars, token);

  const pre = runPreScript(config.preScript, built, vars);
  onVariables?.(pre.outcome.variables);

  const wire = pre.request;
  const started = performance.now();

  try {
    const response = await sendRequest({
      method: wire.method,
      url: enforceSecureUrl(wire.url, settings.enforceSecure),
      headers: activeRows(wire.headers),
      body: wire.body || null,
      timeoutMs: config.timeoutMs ?? settings.defaultTimeoutMs,
      httpVersion: config.httpVersion,
      verifyTls: config.verifyTls ?? settings.verifyTls,
      followRedirects: config.followRedirects ?? settings.followRedirects,
      maxRedirects: config.maxRedirects,
      noReferer: config.noReferer,
      noCookieJar: config.noCookieJar,
      ...tlsFor(wire.url, settings),
      multipart: built.multipart ?? null,
      cancelId,
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
      body: response.body,
      headers: response.headers,
    };
  } catch (e) {
    return {
      status: null,
      statusText: "",
      timeMs: Math.round(performance.now() - started),
      error: String(e),
      results: [],
      body: "",
      headers: [],
    };
  }
}

/** A request counts as healthy when it responded < 400 and every test passed. */
export function isHealthy(result: ExecuteResult): boolean {
  if (result.error || result.status === null) return false;
  if (result.status >= 400) return false;
  return result.results.every((assertion) => assertion.passed);
}
