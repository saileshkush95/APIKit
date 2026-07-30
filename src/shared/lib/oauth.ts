// OAuth 2.0 tokens: where they are kept, and how a request gets one.
//
// The token set lives in the OS keychain under `oauth2:<config id>`, not in the
// collection. `secrets.rs` explains why — a credential beside the collection is
// carried by every export, backup and sync of that file. It also makes the
// keychain the single source of truth for token state, which matters for
// refresh: a monitor or a load test can renew a token without owning the draft
// it came from, because there is no config field to write back to.

import { oauthToken, secretGet, secretSet } from "./api";
import { interpolate, type VarMap } from "./vars";
import { activeRows } from "./rows";
import type { Auth, OAuth2Config } from "../types";

/** What the keychain holds for one OAuth config. */
export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  idToken: string;
  scope: string;
  expiresAtMs: number | null;
  raw: string;
  /** When this set was stored, so the UI can say how old it is. */
  obtainedAtMs: number;
}

function keyFor(id: string): string {
  return `oauth2:${id}`;
}

/**
 * Renew this long before expiry. A token that expires mid-flight fails the
 * request it was attached to, and clock skew between here and the provider is
 * routinely a few seconds.
 */
const EXPIRY_MARGIN_MS = 30_000;

export async function loadTokens(id: string): Promise<TokenSet | null> {
  const stored = await secretGet(keyFor(id));
  if (!stored) return null;
  try {
    return JSON.parse(stored) as TokenSet;
  } catch {
    // Corrupt entry: treat as absent rather than failing every send from here on.
    return null;
  }
}

export async function saveTokens(id: string, tokens: TokenSet): Promise<void> {
  await secretSet(keyFor(id), JSON.stringify(tokens));
}

/** Clearing writes an empty value, which `secret_set` turns into a delete. */
export async function clearTokens(id: string): Promise<void> {
  await secretSet(keyFor(id), "");
}

export function isExpired(tokens: TokenSet | null): boolean {
  if (!tokens?.expiresAtMs) return false;
  return Date.now() >= tokens.expiresAtMs - EXPIRY_MARGIN_MS;
}

/**
 * A provider that sends no `expires_in` has told us nothing about the lifetime,
 * which is not the same as forever — so the UI says so rather than implying the
 * token is good indefinitely.
 */
export function describeExpiry(tokens: TokenSet | null): string {
  if (!tokens?.accessToken) return "No token";
  if (tokens.expiresAtMs === null) return "No expiry given by the provider";
  const remaining = tokens.expiresAtMs - Date.now();
  if (remaining <= 0) return "Expired";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return `Expires in ${Math.floor(remaining / 1000)}s`;
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `Expires in ${hours}h ${minutes % 60}m`;
}

/**
 * Interpolates every field, so a client secret can live in a secret environment
 * variable instead of being typed into the collection.
 */
export function resolveConfig(config: OAuth2Config, vars: VarMap) {
  const text = (value: string) => interpolate(value, vars);
  return {
    tokenUrl: text(config.tokenUrl),
    authorizeUrl: text(config.authorizeUrl),
    deviceUrl: text(config.deviceUrl),
    clientId: text(config.clientId),
    clientSecret: text(config.clientSecret),
    scope: text(config.scope),
    redirectUri: text(config.redirectUri),
    username: text(config.username),
    password: text(config.password),
    clientAuth: config.clientAuth,
    usePkce: config.usePkce,
    extraParams: activeRows(config.extraParams).map((row) => ({
      name: text(row.name),
      value: text(row.value),
    })),
    deviceUrlSet: config.deviceUrl.trim() !== "",
  };
}

function withObtained(tokens: Omit<TokenSet, "obtainedAtMs">): TokenSet {
  return { ...tokens, obtainedAtMs: Date.now() };
}

/** Runs a grant that needs no browser, and stores what comes back. */
export async function fetchTokens(
  config: OAuth2Config,
  vars: VarMap,
  grant: "clientCredentials" | "password" | "refreshToken",
  refreshToken = "",
): Promise<TokenSet> {
  const result = await oauthToken(resolveConfig(config, vars), grant, refreshToken);
  const tokens = withObtained(result);
  await saveTokens(config.id, tokens);
  return tokens;
}

/**
 * The access token to send, renewing it first if it has expired and can be.
 *
 * Returns an empty string when there is nothing to send — no token yet, or a
 * refresh that failed. The request then goes out unauthenticated and the server
 * says 401, which is a clearer signal than a client-side error that hides
 * whether the endpoint was reachable at all.
 */
export async function currentAccessToken(
  auth: Auth,
  vars: VarMap,
): Promise<string> {
  if (auth.type !== "oauth2") return "";
  const config = auth.oauth2;
  if (!config?.id) return "";

  let tokens = await loadTokens(config.id);
  if (!tokens) return "";

  if (isExpired(tokens) && config.autoRefresh && tokens.refreshToken) {
    try {
      tokens = await fetchTokens(config, vars, "refreshToken", tokens.refreshToken);
    } catch {
      // Keep the expired token rather than sending nothing: some providers
      // outlive their own stated expiry, and a 401 is the honest answer if not.
    }
  }

  return tokens.accessToken;
}
