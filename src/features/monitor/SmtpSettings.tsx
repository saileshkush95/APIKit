import { useEffect, useState } from "react";
import { Input, Select } from "../../shared/components/Field";
import { Row, Section } from "../../shared/components/SettingsSection";
import { TagInput } from "../../shared/components/TagInput";
import { secretGet, secretSet } from "../../shared/lib/api";
import {
  sendTestEmail,
  smtpConfigured,
  smtpSender,
  verifySmtp,
  SMTP_PASSWORD_KEY,
} from "../../shared/lib/email";
import { notify, notifyError } from "../../shared/lib/notify";
import { useSettings } from "../../shared/state/settings";
import type { SmtpSecurity } from "../../shared/types";

const SECURITY: { value: SmtpSecurity; label: string; port: number }[] = [
  { value: "starttls", label: "STARTTLS", port: 587 },
  { value: "ssl", label: "SSL/TLS", port: 465 },
  { value: "none", label: "None", port: 25 },
];

const DEFAULT_PORTS = SECURITY.map((option) => option.port);

interface Preset {
  name: string;
  host: string;
  security: SmtpSecurity;
  port: number;
  hint?: string;
}

// User-defined providers — server details only, never credentials — kept
// locally so a self-hosted or company relay is one click, like the built-ins.
const CUSTOM_PROVIDERS_KEY = "smtpProviders";

function loadCustomProviders(): Preset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PROVIDERS_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

const PRESETS: Preset[] = [
  {
    name: "Gmail",
    host: "smtp.gmail.com",
    security: "starttls",
    port: 587,
    hint: "Use a Google app password (Google Account → Security → App passwords), not your normal password.",
  },
  {
    name: "Outlook",
    host: "smtp.office365.com",
    security: "starttls",
    port: 587,
    hint: "Sign in with your full address. Accounts with 2FA need an app password.",
  },
  {
    name: "Zoho",
    host: "smtp.zoho.com",
    security: "ssl",
    port: 465,
    hint: "Enable SMTP access in Zoho Mail settings; use an app-specific password with 2FA.",
  },
  {
    name: "iCloud",
    host: "smtp.mail.me.com",
    security: "starttls",
    port: 587,
    hint: "Requires an app-specific password from appleid.apple.com.",
  },
];

/**
 * Global SMTP configuration for monitor emails, presented in the Settings
 * page's section/row language. Only the host (plus an address to send from) is
 * required; everything but the password lives in AppSettings — the password
 * goes straight to the OS keychain.
 */
export function SmtpSettings() {
  const { settings, update } = useSettings();
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [custom, setCustom] = useState<Preset[]>(loadCustomProviders);
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  useEffect(() => {
    secretGet(SMTP_PASSWORD_KEY).then(setPassword).catch(() => {});
  }, []);

  const configured = smtpConfigured(settings);
  const sender = smtpSender(settings);
  const providers = [...PRESETS, ...custom];
  const activePreset = providers.find(
    (preset) => preset.host === settings.smtpHost.trim(),
  );

  function persistCustom(next: Preset[]) {
    setCustom(next);
    localStorage.setItem(CUSTOM_PROVIDERS_KEY, JSON.stringify(next));
  }

  function saveCurrentAsProvider() {
    const name = nameDraft?.trim();
    if (!name || settings.smtpHost.trim() === "") return;
    persistCustom([
      ...custom.filter((preset) => preset.name !== name),
      {
        name,
        host: settings.smtpHost.trim(),
        security: settings.smtpSecurity,
        port: settings.smtpPort,
      },
    ]);
    setNameDraft(null);
  }

  function applyPreset(preset: Preset) {
    update({
      smtpHost: preset.host,
      smtpSecurity: preset.security,
      smtpPort: preset.port,
    });
  }

  function setSecurity(security: SmtpSecurity) {
    const port = SECURITY.find((option) => option.value === security)?.port;
    // Follow the convention port unless the user typed a custom one.
    if (port && DEFAULT_PORTS.includes(settings.smtpPort)) {
      update({ smtpSecurity: security, smtpPort: port });
    } else {
      update({ smtpSecurity: security });
    }
  }

  async function verify() {
    setBusy("verify");
    try {
      await verifySmtp(settings);
      notify("success", "Connected and authenticated — SMTP works");
    } catch (e) {
      notifyError("SMTP verification failed", e);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const to = testTo.trim() || sender;
    if (to === "") return;
    setBusy("send");
    try {
      await sendTestEmail(settings, to);
      notify("success", `Test email sent to ${to}`);
    } catch (e) {
      notifyError("Test email failed", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Email alerts</h1>
          <p className="text-xs text-muted">
            {configured
              ? `Sending as ${sender} via ${settings.smtpHost.trim()}.`
              : "Optional — set up SMTP and monitors can alert you by email."}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            configured ? "bg-ok/15 text-ok" : "bg-elevated text-muted"
          }`}
        >
          {configured ? "Ready" : "Not set up"}
        </span>
      </div>

      <div className="flex flex-col">
          <Section
            title="Mail server"
            description="Monitors with email enabled alert when they start failing and again when they recover."
          >
            <Row label="Provider" hint="Fills in the server details">
              <div className="flex flex-wrap items-center gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => applyPreset(preset)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                      activePreset?.name === preset.name
                        ? "border-brand bg-brand/10 text-ink"
                        : "border-edge text-muted hover:border-brand hover:text-ink"
                    }`}
                  >
                    {preset.name}
                  </button>
                ))}
                {custom.map((preset) => (
                  <span
                    key={preset.name}
                    className={`group flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] ${
                      activePreset?.name === preset.name
                        ? "border-brand bg-brand/10 text-ink"
                        : "border-edge text-muted hover:border-brand hover:text-ink"
                    }`}
                  >
                    <button
                      onClick={() => applyPreset(preset)}
                      title={`${preset.host}:${preset.port}`}
                    >
                      {preset.name}
                    </button>
                    <button
                      onClick={() =>
                        persistCustom(
                          custom.filter(
                            (candidate) => candidate.name !== preset.name,
                          ),
                        )
                      }
                      className="leading-none text-muted opacity-0 group-hover:opacity-100 hover:text-err"
                      title="Remove this provider"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  onClick={() =>
                    update({
                      smtpHost: "",
                      smtpSecurity: "starttls",
                      smtpPort: 587,
                    })
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    !activePreset
                      ? "border-brand bg-brand/10 text-ink"
                      : "border-edge text-muted hover:border-brand hover:text-ink"
                  }`}
                  title="Enter your own server details"
                >
                  Custom
                </button>
                {nameDraft === null ? (
                  !activePreset &&
                  settings.smtpHost.trim() !== "" && (
                    <button
                      onClick={() => setNameDraft("")}
                      className="rounded-full border border-dashed border-edge px-2.5 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                      title="Keep the current server details as a one-click provider"
                    >
                      + Save as provider
                    </button>
                  )
                ) : (
                  <span className="flex items-center gap-1">
                    <Input
                      value={nameDraft}
                      autoFocus
                      placeholder="Provider name"
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCurrentAsProvider();
                        if (e.key === "Escape") setNameDraft(null);
                      }}
                      className="wrk-field h-6 w-36"
                    />
                    <button
                      onClick={saveCurrentAsProvider}
                      className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setNameDraft(null)}
                      className="rounded px-1 py-0.5 text-[11px] text-muted hover:text-ink"
                    >
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </Row>
            {activePreset?.hint && (
              <Row label="">
                <p className="text-[11px] text-muted">{activePreset.hint}</p>
              </Row>
            )}
            <Row label="SMTP host">
              <Input
                value={settings.smtpHost}
                spellCheck={false}
                placeholder="smtp.example.com"
                onChange={(e) => update({ smtpHost: e.target.value })}
                className="wrk-field w-72 font-mono"
              />
            </Row>
            <Row label="Security & port">
              <div className="flex items-center gap-2">
                <Select
                  value={settings.smtpSecurity}
                  onChange={(e) => setSecurity(e.target.value as SmtpSecurity)}
                  className="wrk-field cursor-pointer"
                >
                  {SECURITY.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  value={settings.smtpPort}
                  onChange={(e) =>
                    update({ smtpPort: Number(e.target.value) || 0 })
                  }
                  className="wrk-field w-24 font-mono"
                />
              </div>
            </Row>
            <Row
              label="Username"
              hint="Optional — leave empty if the server needs no login"
            >
              <Input
                value={settings.smtpUsername}
                spellCheck={false}
                autoComplete="off"
                placeholder="you@example.com"
                onChange={(e) => update({ smtpUsername: e.target.value })}
                className="wrk-field w-72 font-mono"
              />
            </Row>
            <Row label="Password" hint="Stored in the OS keychain">
              <Input
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder="App password"
                onChange={(e) => {
                  setPassword(e.target.value);
                  // Straight to the keychain — it must never sit in settings.
                  secretSet(SMTP_PASSWORD_KEY, e.target.value).catch((err) =>
                    notifyError("Could not store the SMTP password", err),
                  );
                }}
                className="wrk-field w-72 font-mono"
              />
            </Row>
          </Section>

          <Section title="Sender" description="How alert emails introduce themselves.">
            <Row label="From address" hint="Optional — defaults to the username">
              <Input
                value={settings.smtpFrom}
                spellCheck={false}
                placeholder={settings.smtpUsername.trim() || "apikit@example.com"}
                onChange={(e) => update({ smtpFrom: e.target.value })}
                className="wrk-field w-72 font-mono"
              />
            </Row>
            <Row label="Sender name" hint="Optional">
              <Input
                value={settings.smtpFromName}
                placeholder="APIKit"
                onChange={(e) => update({ smtpFromName: e.target.value })}
                className="wrk-field w-72"
              />
            </Row>
          </Section>

          <Section
            title="Recipients"
            description="Every monitor uses this list unless it sets its own on the Health checks page."
          >
            <Row label="Default recipients" hint="Press Enter after each address">
              <TagInput
                value={settings.smtpDefaultTo}
                onChange={(smtpDefaultTo) => update({ smtpDefaultTo })}
                placeholder="you@example.com"
                className="w-96 max-w-full"
              />
            </Row>
          </Section>

          <Section
            title="Check it works"
            description="Verify talks to the server without sending; the test email sends a real message."
          >
            <Row label="Connection">
              <button
                onClick={verify}
                disabled={busy !== null || settings.smtpHost.trim() === ""}
                className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
              >
                {busy === "verify" ? "Verifying…" : "Verify connection"}
              </button>
            </Row>
            <Row label="Test email">
              <div className="flex items-center gap-2">
                <Input
                  value={testTo}
                  spellCheck={false}
                  placeholder={sender || "Recipient"}
                  onChange={(e) => setTestTo(e.target.value)}
                  className="wrk-field w-72 font-mono"
                />
                <button
                  onClick={test}
                  disabled={busy !== null || !configured}
                  className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                  title={configured ? undefined : "Fill in the SMTP host first"}
                >
                  {busy === "send" ? "Sending…" : "Send test email"}
                </button>
              </div>
            </Row>
          </Section>
      </div>
    </>
  );
}
