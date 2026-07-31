import { useMemo, useState } from "react";
import { AuthEditor } from "./AuthEditor";
import { CommentsPanel } from "./CommentsPanel";
import { DocsEditor } from "./DocsEditor";
import { CodeEditor } from "../../shared/components/CodeEditor";
import { HistoryScope } from "../../shared/components/HistoryScope";
import { Input, Select } from "../../shared/components/Field";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { Modal } from "../../shared/components/Modal";
import {
  inheritedAuth,
  inheritedHeaders,
  inheritedScripts,
  inheritedSettings,
  type DefaultsLevel,
} from "../../shared/lib/inherit";
import {
  defaultAuth,
  defaultNodeSettings,
  type Header,
  type NodeDefaults,
  type NodeSettings,
} from "../../shared/types";

const TABS = [
  "docs",
  "headers",
  "auth",
  "scripts",
  "settings",
  "comments",
] as const;

type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = {
  docs: "Docs",
  headers: "Headers",
  auth: "Auth",
  scripts: "Scripts",
  settings: "Settings",
  comments: "Comments",
};

interface Props {
  /** "Users" for a folder, the workspace name for the collection. */
  title: string;
  /**
   * What the comments attach to. A folder's id; for the collection, a fixed
   * key — comments are stored by id, and the collection has no node of its own.
   */
  commentId: string;
  defaults: NodeDefaults;
  /**
   * What this level itself inherits: the collection and any folders enclosing
   * it, outermost first. Empty for the collection, which is the outermost
   * level there is.
   */
  inherited: DefaultsLevel[];
  onChange: (patch: Partial<NodeDefaults>) => void;
  /** Prints this folder or the whole collection, with the requests inside it. */
  onPrint: () => void;
  onClose: () => void;
}

/** Tri-state control: inherit / on / off, matching a request's own overrides. */
function TriState({
  label,
  hint,
  value,
  onChange,
  above,
}: {
  label: string;
  hint: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  /** What is already set further out, shown on the "Not set" option. */
  above: boolean | null;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-edge py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink">{label}</div>
        <div className="text-[11px] text-muted">{hint}</div>
      </div>
      <div className="w-40 flex-none">
        <Select
          size="compact"
          value={value === null ? "inherit" : value ? "on" : "off"}
          onChange={(event) =>
            onChange(
              event.target.value === "inherit" ? null : event.target.value === "on",
            )
          }
        >
          <option value="inherit">
            {above === null ? "Not set" : `Not set — ${above ? "on" : "off"} above`}
          </option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>
      </div>
    </div>
  );
}

function NumberRow({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  placeholder: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-edge py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink">{label}</div>
        <div className="text-[11px] text-muted">{hint}</div>
      </div>
      <div className="w-40 flex-none">
        <Input
          size="compact"
          type="number"
          min={0}
          placeholder={placeholder}
          value={value === null ? "" : String(value)}
          onChange={(event) => {
            const raw = event.target.value.trim();
            onChange(raw === "" ? null : Math.max(0, Number(raw)));
          }}
        />
      </div>
    </div>
  );
}

/**
 * The folder and collection editor: the same tabs a request has, for the levels
 * above it. Everything set here is inherited by the requests inside — see
 * `lib/inherit` for who wins when two levels set the same thing.
 */
export function NodeDefaultsDialog({
  title,
  commentId,
  defaults,
  inherited,
  onChange,
  onPrint,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("docs");
  const settings: NodeSettings = { ...defaultNodeSettings(), ...defaults.settings };

  // Folders nest, so what a folder inherits is itself the product of every
  // folder above it. Showing it here is the difference between "this folder
  // sends one header" and "this folder sends four".
  const above = useMemo(
    () =>
      inheritedHeaders(inherited, {
        headers: defaults.headers ?? [],
        config: { inheritHeaders: true, excludedHeaders: [] },
      }),
    [inherited, defaults.headers],
  );
  const authAbove = useMemo(
    () => inheritedAuth(inherited, { ...defaultAuth(), type: "inherit" }),
    [inherited],
  );
  const scriptsAbove = useMemo(() => inheritedScripts(inherited), [inherited]);
  const settingsAbove = useMemo(() => inheritedSettings(inherited), [inherited]);

  /** Names the enclosing level a value came from, for the "not set" hints. */
  const fromAbove = (value: string | number | boolean | null) =>
    value === null
      ? "Not set"
      : `Not set — ${typeof value === "boolean" ? (value ? "on" : "off") : value} from above`;

  function patchSettings(patch: Partial<NodeSettings>) {
    onChange({ settings: { ...settings, ...patch } });
  }

  return (
    <Modal title={title} onClose={onClose} width="max-w-3xl">
      <HistoryScope id={`node:${commentId}`}>
        <div className="flex flex-none items-center gap-1 border-b border-edge px-3">
          {TABS.map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-2.5 py-2 text-xs ${
                tab === key
                  ? "border-brand text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {LABELS[key]}
            </button>
          ))}
        </div>

        <div className="flex h-[26rem] flex-col overflow-auto p-3">
          {tab === "docs" && (
            <DocsEditor
              value={defaults.docs ?? ""}
              onChange={(docs) => onChange({ docs })}
              subject={title}
              onPrint={onPrint}
            />
          )}

          {tab === "headers" && (
            <>
              {above.length > 0 && (
                <div className="mb-3 rounded-md border border-edge">
                  <div className="border-b border-edge px-2 py-1.5 text-[11px] font-semibold text-muted">
                    Inherited from above
                  </div>
                  <div className="divide-y divide-edge">
                    {above.map((row) => (
                      <div
                        key={row.name.toLowerCase()}
                        className={`flex items-center gap-2 px-2 py-1 text-[11px] ${
                          row.applied ? "" : "opacity-60"
                        }`}
                      >
                        <span
                          className={`w-44 flex-none truncate font-mono ${
                            row.applied ? "text-ink" : "text-muted line-through"
                          }`}
                        >
                          {row.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-muted">
                          {row.value}
                        </span>
                        <span className="flex-none text-muted">{row.source}</span>
                        {row.reason === "overridden" && (
                          <span className="flex-none text-warn">set here</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mb-2 text-[11px] leading-relaxed text-muted">
                Sent with every request inside. A nested folder setting the same
                name wins over this one, as does a request that sets it itself;
                a request can also exclude a name from its Headers tab.
              </p>
              <KeyValueEditor
                allowDisable
                allowDescription
                highlightVariables
                rows={
                  defaults.headers?.length
                    ? defaults.headers
                    : [{ name: "", value: "" }]
                }
                onChange={(headers) => onChange({ headers: headers as Header[] })}
                keyPlaceholder="Header"
                valuePlaceholder="Value"
                historyId="headers"
              />
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Put credentials in a variable and refer to it here — a value
                typed into a header is exported and committed as it stands,
                where a{" "}
                <code className="font-mono text-brand">{"{{token}}"}</code>{" "}
                reference is not.
              </p>
            </>
          )}

          {tab === "auth" && (
            <>
              <p className="mb-3 text-[11px] leading-relaxed text-muted">
                Requests inside whose authorization is “Inherit from parent” use
                this. A nested folder can set its own, and requests inside that
                one will find it first.
              </p>
              {authAbove.type !== "none" && (
                <p className="mb-3 text-[11px] leading-relaxed text-warn">
                  Leaving this at “Inherit from parent” resolves to the{" "}
                  {authAbove.type} authorization set further out.
                </p>
              )}
              <AuthEditor
                auth={{ ...defaultAuth(), ...(defaults.auth ?? {}) }}
                onChange={(patch) =>
                  onChange({
                    auth: { ...defaultAuth(), ...(defaults.auth ?? {}), ...patch },
                  })
                }
              />
            </>
          )}

          {tab === "scripts" && (
            <>
              <p className="mb-2 text-[11px] leading-relaxed text-muted">
                Run around <em>every</em> request inside, not once for the folder:
                before-scripts from the outside in and then the request’s own,
                after-scripts the other way round.
              </p>
              {(scriptsAbove.pre.length > 0 || scriptsAbove.post.length > 0) && (
                <p className="mb-2 text-[11px] leading-relaxed text-warn">
                  {scriptsAbove.pre.length} before and {scriptsAbove.post.length}{" "}
                  after already run from further out; these are added to them,
                  not instead of them.
                </p>
              )}
              <label className="mb-1 text-[11px] text-muted">Before each request</label>
              <CodeEditor
                value={defaults.preScript ?? ""}
                onChange={(preScript) => onChange({ preScript })}
                placeholder="wrk.request.headers.set('X-Trace', wrk.uuid())"
                language="javascript"
                historyKey="preScript"
                completeVariables={false}
                className="mb-3 min-h-[7rem]"
              />
              <label className="mb-1 text-[11px] text-muted">After each response</label>
              <CodeEditor
                value={defaults.postScript ?? ""}
                onChange={(postScript) => onChange({ postScript })}
                placeholder="wrk.test('is json', () => wrk.response.json() !== null)"
                language="javascript"
                historyKey="postScript"
                completeVariables={false}
                className="min-h-[7rem]"
              />
            </>
          )}

          {tab === "settings" && (
            <>
              <p className="mb-1 text-[11px] leading-relaxed text-muted">
                Defaults for the requests inside. “Not set” hands the decision
                outwards — to an enclosing folder, then the collection, then the
                application settings. A request that sets the option itself is
                never overridden.
              </p>
              <TriState
                label="Verify TLS certificates"
                hint="Off accepts self-signed and expired certificates."
                value={settings.verifyTls}
                above={settingsAbove.verifyTls}
                onChange={(verifyTls) => patchSettings({ verifyTls })}
              />
              <TriState
                label="Follow redirects"
                hint="Off returns the 3xx response as it arrived."
                value={settings.followRedirects}
                above={settingsAbove.followRedirects}
                onChange={(followRedirects) => patchSettings({ followRedirects })}
              />
              <NumberRow
                label="Timeout"
                hint="Milliseconds before a request is given up on."
                placeholder={fromAbove(settingsAbove.timeoutMs)}
                value={settings.timeoutMs}
                onChange={(timeoutMs) => patchSettings({ timeoutMs })}
              />
              <NumberRow
                label="Maximum redirects"
                hint="Only used while redirects are being followed."
                placeholder={fromAbove(settingsAbove.maxRedirects)}
                value={settings.maxRedirects}
                onChange={(maxRedirects) => patchSettings({ maxRedirects })}
              />
            </>
          )}

          {tab === "comments" && <CommentsPanel requestId={commentId} />}
        </div>
      </HistoryScope>
    </Modal>
  );
}
