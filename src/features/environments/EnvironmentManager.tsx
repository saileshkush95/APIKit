import { useEffect, useState } from "react";
import { useEnvironments } from "../../shared/state/environments";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";
import { DYNAMIC_VARS } from "../../shared/lib/dynamicVars";

interface Props {
  onClose: () => void;
}

/** Selects the workspace-wide set rather than one of the environments. */
const COLLECTION = "__collection__";

/** Modal for creating environments and editing their variables. */
export function EnvironmentManager({ onClose }: Props) {
  const {
    environments,
    activeId,
    create,
    update,
    duplicate,
    remove,
    collectionVariables,
    setCollectionVariables,
  } = useEnvironments();
  const [selectedId, setSelectedId] = useState<string | null>(
    activeId ?? environments[0]?.id ?? null,
  );
  // Inline rename in the list. The header input renames too; this makes the
  // action discoverable without selecting first.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  function commitRename() {
    if (renamingId && draftName.trim() !== "") {
      update(renamingId, { name: draftName.trim() });
    }
    setRenamingId(null);
  }

  function duplicateAndSelect(id: string) {
    const copy = duplicate(id);
    if (copy) setSelectedId(copy.id);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected =
    environments.find((env) => env.id === selectedId) ?? environments[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        // Sized to the window rather than fixed: this one holds a table of
        // values — URLs, tokens — and 46rem left the value column too narrow to
        // read one, with the room to widen it sitting unused either side.
        className="flex h-[min(85vh,44rem)] w-[min(94vw,76rem)] overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Environment list */}
        <div className="flex w-52 flex-none flex-col border-r border-edge">
          <div className="flex flex-none items-center justify-between border-b border-edge px-3 py-2">
            <span className="text-xs font-semibold text-muted">
              Environments
            </span>
            <button
              onClick={() => setSelectedId(create().id)}
              className="rounded px-1.5 text-base leading-none text-muted hover:bg-elevated hover:text-ink"
              title="New environment"
            >
              +
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {/* Not an environment: it belongs to the workspace and is always
                there, so it sits above the list rather than in it. */}
            <div
              onClick={() => setSelectedId(COLLECTION)}
              className={`mx-1 mb-1 cursor-pointer rounded px-2 py-1 text-xs ${
                selectedId === COLLECTION
                  ? "bg-elevated text-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              Collection variables
              {collectionVariables.some((v) => v.name.trim() !== "") && (
                <span className="ml-1.5 text-[10px] text-muted">
                  {collectionVariables.filter((v) => v.name.trim() !== "").length}
                </span>
              )}
            </div>

            {environments.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted">
                No environments yet.
              </p>
            )}
            {environments.map((env) => (
              <div
                key={env.id}
                onClick={() => setSelectedId(env.id)}
                onDoubleClick={() => {
                  setRenamingId(env.id);
                  setDraftName(env.name);
                }}
                className={`group flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-xs ${
                  selected?.id === env.id
                    ? "bg-elevated text-ink"
                    : "text-muted hover:bg-elevated/60 hover:text-ink"
                }`}
              >
                {renamingId === env.id ? (
                  <input
                    autoFocus
                    value={draftName}
                    spellCheck={false}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded border border-brand bg-panel px-1 py-0.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <>
                    <span className="truncate">{env.name}</span>
                    <span className="ml-auto flex flex-none items-center gap-0.5">
                      {env.id === activeId && (
                        <span className="text-[10px] text-brand group-hover:hidden">
                          active
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(env.id);
                          setDraftName(env.name);
                        }}
                        className="hidden rounded px-1 text-[11px] text-muted group-hover:block hover:bg-panel hover:text-ink"
                        title="Rename"
                      >
                        ✎
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          duplicateAndSelect(env.id);
                        }}
                        className="hidden rounded px-1 text-[11px] text-muted group-hover:block hover:bg-panel hover:text-ink"
                        title="Duplicate"
                      >
                        ⧉
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Variable editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-edge px-3 py-2">
            {selectedId === COLLECTION ? (
              <span className="min-w-0 flex-1 px-1.5 py-1 font-semibold text-ink">
                Collection variables
              </span>
            ) : selected ? (
              <>
                <input
                  value={selected.name}
                  spellCheck={false}
                  title="Click to rename"
                  onChange={(e) => update(selected.id, { name: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-semibold text-ink outline-none hover:border-edge focus:border-brand"
                />
                <button
                  onClick={() => duplicateAndSelect(selected.id)}
                  className="rounded px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-ink"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => {
                    remove(selected.id);
                    setSelectedId(null);
                  }}
                  className="rounded px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-err"
                >
                  Delete
                </button>
              </>
            ) : (
              <span className="text-xs text-muted">
                Create an environment to define variables.
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-lg leading-none text-muted hover:bg-elevated hover:text-ink"
              title="Close"
            >
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {selectedId === COLLECTION ? (
              <>
                <p className="mb-2 text-[11px] leading-relaxed text-muted">
                  Belong to the workspace rather than to one environment — for
                  the values that do not change when you switch: a client id, an
                  API version, a shared header. Resolved{" "}
                  <em>under</em> the active environment, so an environment can
                  still override any of them.
                </p>
                <KeyValueEditor
                  allowDisable
                  allowDescription
                  allowSecrets
                  rows={
                    collectionVariables.length
                      ? collectionVariables
                      : [{ name: "", value: "" }]
                  }
                  onChange={setCollectionVariables}
                  keyPlaceholder="Variable"
                  valuePlaceholder="Value"
                  historyId="collectionVariables"
                />
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  A script writing <code className="font-mono">wrk.env.set</code>{" "}
                  never writes here — those go to the active environment, or to
                  the session when there is none. These are the fixed values.
                </p>
              </>
            ) : selected ? (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  Reference these anywhere in a request as{" "}
                  <code className="font-mono text-brand">{"{{name}}"}</code>.
                </p>
                <KeyValueEditor
                  allowDisable
                  allowDescription
                  rows={selected.variables}
                  onChange={(variables) =>
                    update(selected.id, { variables })
                  }
                  keyPlaceholder="Variable"
                  valuePlaceholder="Value"
                  historyId={`env:${selected.id}`}
                  allowSecrets
                />
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  Values marked secret stay on this machine: their names sync and
                  export so teammates know what to fill in, but the values never
                  leave.
                </p>

                <details className="mt-4 border-t border-edge pt-3">
                  <summary className="cursor-default text-[11px] text-muted select-none">
                    Generated variables
                  </summary>
                  <p className="mt-1.5 mb-2 text-[11px] leading-relaxed text-muted">
                    Always available, no definition needed. Each is regenerated
                    every time you send — so a retry gets a fresh value, not the
                    one that already failed. Defining a variable with the same
                    name overrides it.
                  </p>
                  <ul className="space-y-1">
                    {DYNAMIC_VARS.map((item) => (
                      <li key={item.name} className="flex gap-2 text-[11px]">
                        <code className="w-32 flex-none font-mono text-redirect">
                          {`{{${item.name}}}`}
                        </code>
                        <span className="text-muted">{item.description}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            ) : (
              <div className="p-6 text-center text-muted">
                Nothing selected.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
