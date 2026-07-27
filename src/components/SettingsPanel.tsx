import { useSettings } from "../state/settings";
import { useTheme, type ThemeMode } from "../state/theme";
import type { AppSettings, HttpVersion } from "../types";

const ACCENTS = [
  "#ff6c37",
  "#5b8cff",
  "#10b981",
  "#a78bfa",
  "#ef5350",
  "#e8a33d",
];

const UI_FONTS: { label: string; value: string }[] = [
  { label: "System", value: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: "Inter / Helvetica", value: "Inter, Helvetica, Arial, sans-serif" },
  { label: "Georgia (serif)", value: "Georgia, 'Times New Roman', serif" },
];

const MONO_FONTS: { label: string; value: string }[] = [
  {
    label: "System mono",
    value:
      "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Courier", value: "'Courier New', Courier, monospace" },
];

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-edge px-6 py-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && (
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      )}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

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
    <div className="flex items-center gap-4">
      <div className="w-56 flex-none">
        <div className="text-xs text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const controlCls =
  "rounded border border-edge bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-brand";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-brand)]"
      />
      {label}
    </label>
  );
}

export function SettingsPanel() {
  const { settings, update, reset } = useSettings();
  const { mode, setMode } = useTheme();

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    update({ [key]: value } as Partial<AppSettings>);
  }

  return (
    <div className="min-h-0 w-full overflow-auto">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between px-6 pt-5">
          <h1 className="text-base font-semibold">Settings</h1>
          <button
            onClick={reset}
            className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:border-err hover:text-err"
          >
            Reset to defaults
          </button>
        </div>

        <Section
          title="Appearance"
          description="Applies across the app immediately."
        >
          <Row label="Theme">
            <div className="flex gap-1">
              {THEMES.map((theme) => (
                <button
                  key={theme.value}
                  onClick={() => setMode(theme.value)}
                  className={`rounded-md border px-3 py-1 text-xs ${
                    mode === theme.value
                      ? "border-brand text-ink"
                      : "border-edge text-muted hover:text-ink"
                  }`}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Primary colour" hint="Buttons, active tabs, highlights">
            <div className="flex items-center gap-2">
              {ACCENTS.map((color) => (
                <button
                  key={color}
                  onClick={() => set("accentColor", color)}
                  style={{ background: color }}
                  className={`h-5 w-5 rounded-full border-2 ${
                    settings.accentColor.toLowerCase() === color
                      ? "border-ink"
                      : "border-transparent"
                  }`}
                  title={color}
                />
              ))}
              <input
                type="color"
                value={settings.accentColor}
                onChange={(e) => set("accentColor", e.target.value)}
                className="h-6 w-10 cursor-pointer rounded border border-edge bg-panel"
                title="Custom colour"
              />
            </div>
          </Row>

          <Row label="Interface font">
            <select
              value={settings.uiFont}
              onChange={(e) => set("uiFont", e.target.value)}
              className={`${controlCls} w-64 cursor-pointer`}
            >
              {UI_FONTS.map((font) => (
                <option key={font.label} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Monospace font" hint="Editors, headers, response bodies">
            <select
              value={settings.monoFont}
              onChange={(e) => set("monoFont", e.target.value)}
              className={`${controlCls} w-64 cursor-pointer`}
            >
              {MONO_FONTS.map((font) => (
                <option key={font.label} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Base font size">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={11}
                max={18}
                value={settings.fontSize}
                onChange={(e) => set("fontSize", Number(e.target.value))}
                className="w-48 accent-[var(--color-brand)]"
              />
              <span className="font-mono text-xs text-muted">
                {settings.fontSize}px
              </span>
            </div>
          </Row>
        </Section>

        <Section
          title="Security"
          description="Controls how connections are made."
        >
          <Row
            label="Force secure connections"
            hint="Upgrades http:// to https:// and ws:// to wss://"
          >
            <Toggle
              checked={settings.enforceSecure}
              onChange={(value) => set("enforceSecure", value)}
              label={settings.enforceSecure ? "Enabled" : "Disabled"}
            />
          </Row>
          <Row
            label="Verify TLS certificates"
            hint="Turn off to allow self-signed certificates (HTTP requests)"
          >
            <Toggle
              checked={settings.verifyTls}
              onChange={(value) => set("verifyTls", value)}
              label={settings.verifyTls ? "Verified" : "Not verified"}
            />
          </Row>
          {!settings.verifyTls && (
            <p className="text-[11px] text-warn">
              Certificate verification is off — responses can be intercepted.
              Streaming protocols still verify certificates.
            </p>
          )}
        </Section>

        <Section
          title="Identity"
          description="Used when you comment on an endpoint."
        >
          <Row label="Display name">
            <input
              value={settings.userName}
              spellCheck={false}
              placeholder="Anonymous"
              onChange={(e) => set("userName", e.target.value)}
              className={`${controlCls} w-64`}
            />
          </Row>
        </Section>

        <Section
          title="Background"
          description="Monitors only run while the app is running."
        >
          <Row
            label="Keep running when window closes"
            hint="Closing hides the window to the tray instead of quitting"
          >
            <Toggle
              checked={settings.runInBackground}
              onChange={(value) => set("runInBackground", value)}
              label={settings.runInBackground ? "Stay running" : "Quit on close"}
            />
          </Row>
          <Row
            label="Start at login"
            hint="Launches WebRequestKit when you log in"
          >
            <Toggle
              checked={settings.startAtLogin}
              onChange={(value) => set("startAtLogin", value)}
              label={settings.startAtLogin ? "Enabled" : "Disabled"}
            />
          </Row>
          {settings.runInBackground && (
            <p className="text-[11px] text-muted">
              Use the tray icon to reopen the window, or Quit from its menu to
              stop monitoring. Monitors do not run once the app is fully quit.
            </p>
          )}
        </Section>

        <Section title="Requests" description="Defaults for new requests.">
          <Row label="Timeout">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1000}
                value={settings.defaultTimeoutMs}
                onChange={(e) =>
                  set("defaultTimeoutMs", Math.max(0, Number(e.target.value)))
                }
                className={`${controlCls} w-28 font-mono`}
              />
              <span className="text-xs text-muted">ms</span>
            </div>
          </Row>
          <Row label="Follow redirects">
            <Toggle
              checked={settings.followRedirects}
              onChange={(value) => set("followRedirects", value)}
              label={settings.followRedirects ? "Follow" : "Do not follow"}
            />
          </Row>
          <Row label="Default HTTP version">
            <select
              value={settings.defaultHttpVersion}
              onChange={(e) =>
                set("defaultHttpVersion", e.target.value as HttpVersion)
              }
              className={`${controlCls} w-40 cursor-pointer`}
            >
              <option value="auto">Auto (ALPN)</option>
              <option value="http1">HTTP/1.1</option>
              <option value="http2">HTTP/2</option>
            </select>
          </Row>
          <Row
            label="Stream history"
            hint="Messages kept per streaming session"
          >
            <input
              type="number"
              min={50}
              step={50}
              value={settings.maxStreamMessages}
              onChange={(e) =>
                set("maxStreamMessages", Math.max(50, Number(e.target.value)))
              }
              className={`${controlCls} w-28 font-mono`}
            />
          </Row>
        </Section>
      </div>
    </div>
  );
}
