import { useEffect, useState } from "react";
import { Input, Select } from "../../shared/components/Field";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { Toggle } from "../../shared/components/Toggle";
import { VariableInput } from "../../shared/components/VariableInput";
import {
  oauthAuthorize,
  oauthDevicePoll,
  oauthDeviceStart,
  type OauthDeviceAuth,
} from "../../shared/lib/api";
import { notifyError } from "../../shared/lib/notify";
import {
  clearTokens,
  describeExpiry,
  fetchTokens,
  isExpired,
  loadTokens,
  resolveConfig,
  saveTokens,
  type TokenSet,
} from "../../shared/lib/oauth";
import { useEnvironments } from "../../shared/state/environments";
import type { KeyValue, OAuth2Config, OauthGrant } from "../../shared/types";

interface Props {
  config: OAuth2Config;
  onChange: (patch: Partial<OAuth2Config>) => void;
}

const GRANTS: { value: OauthGrant; label: string; hint: string }[] = [
  {
    value: "authorizationCode",
    label: "Authorization Code",
    hint: "Opens your browser to sign in. The right choice for anything acting on a user's behalf.",
  },
  {
    value: "clientCredentials",
    label: "Client Credentials",
    hint: "Machine to machine. No user, no browser — just the client id and secret.",
  },
  {
    value: "password",
    label: "Password Credentials",
    hint: "Sends a username and password directly. Deprecated by OAuth 2.1; only for legacy providers.",
  },
  {
    value: "deviceCode",
    label: "Device Code",
    hint: "Shows a code to type on another device. For inputs where a browser is awkward.",
  },
];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3">
      <span className="mt-1.5 w-28 flex-none text-xs text-muted">{label}</span>
      <span className="min-w-0 flex-1">
        {children}
        {hint && <span className="mt-0.5 block text-[10px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * The OAuth 2.0 flow editor, and the button that actually runs it.
 *
 * The token is not part of `config` — it lives in the OS keychain, so this
 * component reads it on mount and after every fetch rather than receiving it as
 * a prop. See `shared/lib/oauth.ts`.
 */
export function OauthPanel({ config, onChange }: Props) {
  const { vars } = useEnvironments();
  const [tokens, setTokens] = useState<TokenSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<OauthDeviceAuth | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTokens(config.id)
      .then((found) => !cancelled && setTokens(found))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config.id]);

  // The countdown in the summary line is only correct if it re-renders.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!tokens?.expiresAtMs) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [tokens?.expiresAtMs]);

  const grant = config.grant;
  const spec = () => resolveConfig(config, vars);

  async function run(work: () => Promise<TokenSet>) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      setTokens(result);
      if (!result.accessToken) {
        setError("The provider replied without an access token.");
      }
    } catch (e) {
      // Shown inline as well as toasted: the message is usually the provider's
      // own `error_description`, which is the thing worth reading carefully.
      setError(String(e));
      notifyError("Could not get a token", e);
    } finally {
      setBusy(false);
      setDevice(null);
    }
  }

  function getToken() {
    if (grant === "authorizationCode") {
      return run(async () => {
        const result = await oauthAuthorize(spec());
        const stored = { ...result, obtainedAtMs: Date.now() };
        await saveTokens(config.id, stored);
        return stored;
      });
    }
    if (grant === "deviceCode") {
      return run(async () => {
        const start = await oauthDeviceStart(spec());
        setDevice(start);
        const result = await oauthDevicePoll(
          spec(),
          start.deviceCode,
          start.intervalSecs,
          start.expiresInSecs,
        );
        const stored = { ...result, obtainedAtMs: Date.now() };
        await saveTokens(config.id, stored);
        return stored;
      });
    }
    return run(() => fetchTokens(config, vars, grant));
  }

  function refresh() {
    if (!tokens?.refreshToken) return;
    return run(() => fetchTokens(config, vars, "refreshToken", tokens.refreshToken));
  }

  async function forget() {
    await clearTokens(config.id);
    setTokens(null);
    setError(null);
  }

  const expired = isExpired(tokens);
  const needsBrowser = grant === "authorizationCode";
  const button =
    "rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink hover:border-brand disabled:cursor-default disabled:opacity-40 disabled:hover:border-edge";

  return (
    <div className="flex flex-col gap-2.5">
      <Row label="Grant type" hint={GRANTS.find((g) => g.value === grant)?.hint}>
        <Select
          value={grant}
          onChange={(e) => onChange({ grant: e.target.value as OauthGrant })}
          className="wrk-field cursor-pointer font-sans"
        >
          {GRANTS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </Select>
      </Row>

      {needsBrowser && (
        <>
          <Row label="Auth URL">
            <VariableInput
              value={config.authorizeUrl}
              placeholder="https://accounts.example.com/authorize"
              mono
              historyKey="oauth:authorizeUrl"
              onChange={(authorizeUrl) => onChange({ authorizeUrl })}
            />
          </Row>
          <Row
            label="Callback URL"
            hint="Must be loopback with a port, and registered with the provider — this app answers it."
          >
            <VariableInput
              value={config.redirectUri}
              placeholder="http://127.0.0.1:8731/callback"
              mono
              historyKey="oauth:redirectUri"
              onChange={(redirectUri) => onChange({ redirectUri })}
            />
          </Row>
        </>
      )}

      {grant === "deviceCode" && (
        <Row label="Device URL">
          <VariableInput
            value={config.deviceUrl}
            placeholder="https://accounts.example.com/device/code"
            mono
            historyKey="oauth:deviceUrl"
            onChange={(deviceUrl) => onChange({ deviceUrl })}
          />
        </Row>
      )}

      <Row label="Access token URL">
        <VariableInput
          value={config.tokenUrl}
          placeholder="https://accounts.example.com/oauth/token"
          mono
          historyKey="oauth:tokenUrl"
          onChange={(tokenUrl) => onChange({ tokenUrl })}
        />
      </Row>

      <Row label="Client ID">
        <VariableInput
          value={config.clientId}
          mono
          historyKey="oauth:clientId"
          onChange={(clientId) => onChange({ clientId })}
        />
      </Row>

      <Row
        label="Client secret"
        hint="Stored with the collection. Put it in a secret environment variable to keep it out of exports and sync."
      >
        <VariableInput
          value={config.clientSecret}
          placeholder="{{clientSecret}}"
          mono
          historyKey="oauth:clientSecret"
          onChange={(clientSecret) => onChange({ clientSecret })}
        />
      </Row>

      {grant === "password" && (
        <>
          <Row label="Username">
            <VariableInput
              value={config.username}
              mono
              historyKey="oauth:username"
              onChange={(username) => onChange({ username })}
            />
          </Row>
          <Row label="Password">
            <VariableInput
              value={config.password}
              placeholder="{{password}}"
              mono
              historyKey="oauth:password"
              onChange={(password) => onChange({ password })}
            />
          </Row>
        </>
      )}

      <Row label="Scope" hint="Space separated.">
        <VariableInput
          value={config.scope}
          placeholder="openid profile email"
          mono
          historyKey="oauth:scope"
          onChange={(scope) => onChange({ scope })}
        />
      </Row>

      <Row
        label="Client auth"
        hint="Where the client id and secret go. Providers disagree; if you get invalid_client, try the other."
      >
        <Select
          value={config.clientAuth}
          onChange={(e) =>
            onChange({ clientAuth: e.target.value as OAuth2Config["clientAuth"] })
          }
          className="wrk-field cursor-pointer font-sans"
        >
          <option value="basic">Send as Basic auth header</option>
          <option value="body">Send in request body</option>
        </Select>
      </Row>

      {needsBrowser && (
        <Row label="PKCE" hint="Required for public clients, and mandatory in OAuth 2.1. Leave on unless the provider rejects it.">
          <Toggle
            checked={config.usePkce}
            onChange={(usePkce) => onChange({ usePkce })}
            label="Use PKCE (S256)"
          />
        </Row>
      )}

      <Row label="Send token as">
        <div className="flex gap-1.5">
          <Select
            value={config.addTo}
            onChange={(e) =>
              onChange({ addTo: e.target.value as OAuth2Config["addTo"] })
            }
            className="wrk-field w-32 cursor-pointer font-sans"
          >
            <option value="header">Header</option>
            <option value="query">Query param</option>
          </Select>
          {config.addTo === "header" ? (
            <>
              <Input
                value={config.headerName}
                spellCheck={false}
                placeholder="Authorization"
                onChange={(e) => onChange({ headerName: e.target.value })}
                className="wrk-field font-mono"
              />
              <Input
                value={config.headerPrefix}
                spellCheck={false}
                placeholder="Bearer"
                title="Prefix before the token; empty sends the bare token"
                onChange={(e) => onChange({ headerPrefix: e.target.value })}
                className="wrk-field w-24 font-mono"
              />
            </>
          ) : (
            <Input
              value={config.queryName}
              spellCheck={false}
              placeholder="access_token"
              onChange={(e) => onChange({ queryName: e.target.value })}
              className="wrk-field font-mono"
            />
          )}
        </div>
      </Row>

      <Row label="Auto refresh" hint="Renews the token when it has expired and a refresh token is held.">
        <Toggle
          checked={config.autoRefresh}
          onChange={(autoRefresh) => onChange({ autoRefresh })}
          label="Refresh expired tokens automatically"
        />
      </Row>

      <div>
        <div className="mb-1 text-[11px] text-muted">
          Extra parameters
          <span className="ml-1.5 text-[10px]">
            sent with both the authorization and token requests — audience,
            resource, prompt
          </span>
        </div>
        <KeyValueEditor
          historyId="oauthExtraParams"
          rows={
            config.extraParams.length
              ? config.extraParams
              : [{ name: "", value: "" }]
          }
          onChange={(extraParams) =>
            onChange({ extraParams: extraParams as KeyValue[] })
          }
          allowDisable
          allowDescription
          highlightVariables
          keyPlaceholder="Parameter"
          valuePlaceholder="Value"
        />
      </div>

      {/* --- the token itself --- */}
      <div className="mt-1 rounded-md border border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-ink">Current token</span>
          <span
            className={`text-[10px] ${
              !tokens?.accessToken
                ? "text-muted"
                : expired
                  ? "text-warn"
                  : "text-ok"
            }`}
          >
            {busy ? "Working…" : describeExpiry(tokens)}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button className={button} disabled={busy} onClick={getToken}>
              {needsBrowser ? "Get token in browser" : "Get new token"}
            </button>
            <button
              className={button}
              disabled={busy || !tokens?.refreshToken}
              onClick={refresh}
              title={
                tokens?.refreshToken
                  ? "Exchange the refresh token for a new access token"
                  : "The provider did not return a refresh token"
              }
            >
              Refresh
            </button>
            <button
              className={button}
              disabled={busy || !tokens}
              onClick={forget}
              title="Delete the token from the keychain"
            >
              Forget
            </button>
          </div>
        </div>

        <div className="px-2.5 py-2">
          {device && (
            <div className="mb-2 rounded border border-brand/40 bg-elevated px-2 py-1.5">
              <div className="text-[11px] text-ink">
                Go to{" "}
                <span className="font-mono text-brand">
                  {device.verificationUri}
                </span>{" "}
                and enter{" "}
                <span className="font-mono text-brand">{device.userCode}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-muted">
                Waiting for approval…
              </div>
            </div>
          )}

          {error && (
            <div className="mb-2 rounded border border-err/40 px-2 py-1.5 text-[11px] text-err">
              {error}
            </div>
          )}

          {!tokens?.accessToken && !error && !device && (
            <p className="text-[11px] text-muted">
              No token yet. The request will be sent without one until you fetch
              it.
            </p>
          )}

          {tokens?.accessToken && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="w-20 flex-none text-[10px] text-muted">
                  Access
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                  {showToken
                    ? tokens.accessToken
                    : `${tokens.accessToken.slice(0, 12)}…${tokens.accessToken.slice(-6)}`}
                </span>
                <button
                  className="text-[10px] text-muted hover:text-ink"
                  onClick={() => setShowToken((on) => !on)}
                >
                  {showToken ? "Hide" : "Reveal"}
                </button>
                <button
                  className="text-[10px] text-muted hover:text-ink"
                  onClick={() => navigator.clipboard.writeText(tokens.accessToken)}
                >
                  Copy
                </button>
              </div>

              {tokens.scope && (
                <div className="flex items-center gap-2">
                  <span className="w-20 flex-none text-[10px] text-muted">
                    Scope
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                    {tokens.scope}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="w-20 flex-none text-[10px] text-muted">
                  Refresh
                </span>
                <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                  {tokens.refreshToken ? "held in the keychain" : "none returned"}
                </span>
              </div>

              <button
                className="self-start text-[10px] text-muted hover:text-ink"
                onClick={() => setShowRaw((on) => !on)}
              >
                {showRaw ? "Hide" : "Show"} full response
              </button>
              {showRaw && (
                <pre className="max-h-48 overflow-auto rounded border border-edge bg-panel p-2 font-mono text-[10px] leading-relaxed text-muted">
                  {tokens.raw}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
