import { Input, Select } from "../../shared/components/Field";
import { Toggle } from "../../shared/components/Toggle";
import type { RequestConfig } from "../../shared/types";

interface Props {
  config: RequestConfig;
  onChange: (patch: Partial<RequestConfig>) => void;
}

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-edge/60 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-muted">
          {description}
        </div>
      </div>
      <div className="flex flex-none items-center">{children}</div>
    </div>
  );
}

/** null = "use the global setting", true/false = per-request override. */
function OverrideSelect({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <Select
      value={value === null ? "default" : value ? "on" : "off"}
      onChange={(e) =>
        onChange(e.target.value === "default" ? null : e.target.value === "on")
      }
      size="compact"
      className="w-36 cursor-pointer"
    >
      <option value="default">Global default</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </Select>
  );
}

/** Numeric override; an empty field falls back to the default. */
function NumberOverride({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) =>
        onChange(
          e.target.value === ""
            ? null
            : Math.max(0, Math.floor(Number(e.target.value))),
        )
      }
      size="compact"
      className="w-36"
    />
  );
}

/** Per-request behavior overrides, applied at send time over the globals. */
export function RequestSettingsPanel({ config, onChange }: Props) {
  return (
    <div className="max-w-2xl">
      <p className="pb-1.5 text-[11px] text-muted">
        These apply to this request only. “Global default” follows the app
        Settings.
      </p>

      <Row
        title="Enable SSL certificate verification"
        description="Verify SSL certificates when sending. Verification failures abort the request."
      >
        <OverrideSelect
          value={config.verifyTls}
          onChange={(verifyTls) => onChange({ verifyTls })}
        />
      </Row>

      <Row
        title="Automatically follow redirects"
        description="Follow HTTP 3xx responses as redirects."
      >
        <OverrideSelect
          value={config.followRedirects}
          onChange={(followRedirects) => onChange({ followRedirects })}
        />
      </Row>

      <Row
        title="Maximum number of redirects"
        description="Cap on redirects to follow before the request fails. Empty uses the default of 10."
      >
        <NumberOverride
          value={config.maxRedirects}
          placeholder="10"
          onChange={(maxRedirects) => onChange({ maxRedirects })}
        />
      </Row>

      <Row
        title="Request timeout (ms)"
        description="How long to wait before giving up on this request. Empty uses the global timeout."
      >
        <NumberOverride
          value={config.timeoutMs}
          placeholder="global"
          onChange={(timeoutMs) => onChange({ timeoutMs })}
        />
      </Row>

      <Row
        title="Remove referer header on redirect"
        description="Do not send a Referer header when a redirect is followed."
      >
        <Toggle
          checked={config.noReferer}
          onChange={(noReferer) => onChange({ noReferer })}
          title="Remove referer header on redirect"
        />
      </Row>

      <Row
        title="Disable cookie jar"
        description="Cookies from this request are not stored, and stored cookies are not sent with it."
      >
        <Toggle
          checked={config.noCookieJar}
          onChange={(noCookieJar) => onChange({ noCookieJar })}
          title="Disable cookie jar"
        />
      </Row>
    </div>
  );
}
