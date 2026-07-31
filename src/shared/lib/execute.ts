// One place that turns a saved request into a result: build → pre-script →
// send → post-script → assertions. Shared by the collection runner and the
// monitors so they can never drift apart.

import { sendRequest } from "./api";
import { runAssertions } from "./assertions";
import { currentAccessToken } from "./oauth";
import { buildWireRequest, enforceSecureUrl } from "./request";
import { resolveInherited } from "./inherit";
import { tlsFor } from "./certificates";
import { activeRows } from "./rows";
import { runPostScript, runPreScript } from "./scripts";
import type { VarMap } from "./vars";
import {
  normalizeConfig,
  type AppSettings,
  type AssertionResult,
  type Auth,
  type HttpRequestSpec,
  type HttpResponseData,
  type NodeDefaults,
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
   * What the collection contributes — headers, auth, scripts, request options.
   * Omitted, only the folders in `tree` are inherited from.
   */
  collectionDefaults?: NodeDefaults;
  /**
   * Handle for `cancelRequest`, so a caller can abort the in-flight send
   * rather than waiting out its timeout.
   */
  cancelId?: string;
  /**
   * How the request actually goes out. Defaults to the Rust backend over Tauri.
   *
   * The CLI runner supplies a fetch-based transport instead, which is the whole
   * reason this is injectable: build → pre-script → send → post-script →
   * assertions has to stay in one place, or the CLI would slowly disagree with
   * the app about what a request means.
   */
  send?: (spec: HttpRequestSpec) => Promise<HttpResponseData>;
  /**
   * Resolves the OAuth access token. Defaults to the keychain-backed resolver,
   * which exists only inside the app — outside it, tokens come from the
   * environment instead.
   */
  resolveToken?: (auth: Auth, vars: VarMap) => Promise<string>;
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
  {
    vars,
    settings,
    onVariables,
    tree,
    collectionDefaults,
    cancelId,
    send,
    resolveToken,
  }: ExecuteContext,
): Promise<ExecuteResult> {
  const transport = send ?? sendRequest;
  // Resolved against the tree at send time, so moving a request into another
  // folder changes what it inherits without touching the request itself.
  const inherited = resolveInherited(
    tree ?? [],
    request.id,
    collectionDefaults ?? {},
    { headers: request.headers, config: normalizeConfig(request.config) },
  );
  const { config, headers } = inherited;
  // Renews the token first if it has expired, which is why this is awaited
  // before the request is assembled rather than inside it.
  const token = await (resolveToken ?? currentAccessToken)(config.auth, vars);
  const built = buildWireRequest({ ...request, config, headers }, vars, token);

  // Folder and collection scripts wrap the request's own: outside in before,
  // inside out after, so each level tidies up after what it set up.
  let wire = built;
  const written: Record<string, string> = {};
  for (const source of [...inherited.preScripts, config.preScript]) {
    const step = runPreScript(source, wire, { ...vars, ...written });
    wire = step.request;
    Object.assign(written, step.outcome.variables);
  }
  onVariables?.(written);

  const started = performance.now();

  try {
    const response = await transport({
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

    const tests = [];
    for (const source of [config.postScript, ...inherited.postScripts]) {
      const post = runPostScript(source, response, { ...vars, ...written });
      Object.assign(written, post.variables);
      onVariables?.(post.variables);
      tests.push(...post.tests);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      timeMs: response.timeMs,
      error: null,
      results: [...runAssertions(request.tests ?? [], response), ...tests],
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
