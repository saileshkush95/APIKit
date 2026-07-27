import { Input, Select } from "../../shared/components/Field";
import { VariableInput } from "../../shared/components/VariableInput";
import type { Auth, AuthType } from "../../shared/types";

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
        <Select
          value={auth.type}
          onChange={(e) => onChange({ type: e.target.value as AuthType })}
          className={"wrk-field cursor-pointer font-sans"}
        >
          {TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </Select>
      </Field>

      {auth.type === "none" && (
        <p className="text-xs text-muted">
          This request does not use any authorization.
        </p>
      )}

      {auth.type === "bearer" && (
        <Field label="Token">
          <VariableInput
            value={auth.token}
            placeholder="{{accessToken}}"
            mono
            onChange={(token) => onChange({ token })}
          />
        </Field>
      )}

      {auth.type === "basic" && (
        <>
          <Field label="Username">
            <VariableInput
              value={auth.username}
              mono
              onChange={(username) => onChange({ username })}
            />
          </Field>
          <Field label="Password">
            <Input
              value={auth.password}
              type="password"
              spellCheck={false}
              onChange={(e) => onChange({ password: e.target.value })}
              className="wrk-field"
            />
          </Field>
        </>
      )}

      {auth.type === "apiKey" && (
        <>
          <Field label="Key">
            <VariableInput
              value={auth.key}
              placeholder="X-API-Key"
              mono
              onChange={(key) => onChange({ key })}
            />
          </Field>
          <Field label="Value">
            <VariableInput
              value={auth.value}
              placeholder="{{apiKey}}"
              mono
              onChange={(value) => onChange({ value })}
            />
          </Field>
          <Field label="Add to">
            <Select
              value={auth.addTo}
              onChange={(e) =>
                onChange({ addTo: e.target.value as Auth["addTo"] })
              }
              className={"wrk-field cursor-pointer font-sans"}
            >
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}
