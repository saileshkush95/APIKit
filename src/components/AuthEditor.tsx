import type { Auth, AuthType } from "../types";

interface Props {
  auth: Auth;
  onChange: (patch: Partial<Auth>) => void;
}

const TYPES: { value: AuthType; label: string }[] = [
  { value: "none", label: "No Auth" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic Auth" },
  { value: "apiKey", label: "API Key" },
];

const inputCls =
  "w-full rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-brand";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-24 flex-none text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Auth is applied at send time — see `buildWireRequest`. */
export function AuthEditor({ auth, onChange }: Props) {
  return (
    <div className="flex max-w-2xl flex-col gap-2.5">
      <Field label="Type">
        <select
          value={auth.type}
          onChange={(e) => onChange({ type: e.target.value as AuthType })}
          className={`${inputCls} cursor-pointer font-sans`}
        >
          {TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </Field>

      {auth.type === "none" && (
        <p className="text-xs text-muted">
          This request does not use any authorization.
        </p>
      )}

      {auth.type === "bearer" && (
        <Field label="Token">
          <input
            value={auth.token}
            spellCheck={false}
            placeholder="{{accessToken}}"
            onChange={(e) => onChange({ token: e.target.value })}
            className={inputCls}
          />
        </Field>
      )}

      {auth.type === "basic" && (
        <>
          <Field label="Username">
            <input
              value={auth.username}
              spellCheck={false}
              onChange={(e) => onChange({ username: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Password">
            <input
              value={auth.password}
              type="password"
              spellCheck={false}
              onChange={(e) => onChange({ password: e.target.value })}
              className={inputCls}
            />
          </Field>
        </>
      )}

      {auth.type === "apiKey" && (
        <>
          <Field label="Key">
            <input
              value={auth.key}
              spellCheck={false}
              placeholder="X-API-Key"
              onChange={(e) => onChange({ key: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Value">
            <input
              value={auth.value}
              spellCheck={false}
              placeholder="{{apiKey}}"
              onChange={(e) => onChange({ value: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Add to">
            <select
              value={auth.addTo}
              onChange={(e) =>
                onChange({ addTo: e.target.value as Auth["addTo"] })
              }
              className={`${inputCls} cursor-pointer font-sans`}
            >
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}
