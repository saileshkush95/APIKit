import { useEffect, useState } from "react";
import { useEnvironments } from "../../shared/state/environments";
import { KeyValueEditor } from "../../shared/components/KeyValueEditor";

interface Props {
  onClose: () => void;
}

/** Modal for creating environments and editing their variables. */
export function EnvironmentManager({ onClose }: Props) {
  const { environments, activeId, create, update, duplicate, remove } =
    useEnvironments();
  const [selectedId, setSelectedId] = useState<string | null>(
    activeId ?? environments[0]?.id ?? null,
  );

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
        className="flex h-[26rem] w-[46rem] overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
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
            {environments.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted">
                No environments yet.
              </p>
            )}
            {environments.map((env) => (
              <button
                key={env.id}
                onClick={() => setSelectedId(env.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  selected?.id === env.id
                    ? "bg-elevated text-ink"
                    : "text-muted hover:bg-elevated/60 hover:text-ink"
                }`}
              >
                <span className="truncate">{env.name}</span>
                {env.id === activeId && (
                  <span className="ml-auto text-[10px] text-brand">active</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Variable editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-edge px-3 py-2">
            {selected ? (
              <>
                <input
                  value={selected.name}
                  spellCheck={false}
                  onChange={(e) => update(selected.id, { name: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-semibold text-ink outline-none hover:border-edge focus:border-brand"
                />
                <button
                  onClick={() => duplicate(selected.id)}
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
            {selected ? (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  Reference these anywhere in a request as{" "}
                  <code className="font-mono text-brand">{"{{name}}"}</code>.
                </p>
                <KeyValueEditor
                  rows={selected.variables}
                  onChange={(variables) =>
                    update(selected.id, { variables })
                  }
                  keyPlaceholder="Variable"
                  valuePlaceholder="Value"
                  allowSecrets
                />
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  Values marked secret stay on this machine: their names sync and
                  export so teammates know what to fill in, but the values never
                  leave.
                </p>
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
