import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../../shared/state/confirm";
import { useEnvironments } from "../../shared/state/environments";
import { EnvironmentManager } from "./EnvironmentManager";

/**
 * Active-environment picker. Deliberately the same dropdown as the workspace
 * switcher beside it: same shape, same inline rename/duplicate/delete, so the
 * two controls in the header behave alike.
 */
export function EnvironmentBar() {
  const { environments, active, activeId, setActiveId, create, update, duplicate, remove } =
    useEnvironments();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const confirm = useConfirm();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <>
      <div ref={rootRef} data-tour="environments" className="relative">
        <button
          onClick={() => setOpen((prev) => !prev)}
          className="flex h-7 items-center gap-1.5 rounded-md border border-edge px-2.5 text-xs text-ink hover:bg-elevated"
          title="Active environment"
        >
          <span className="max-w-40 truncate">
            {active?.name ?? "No environment"}
          </span>
          <span className="text-[9px] text-muted">▼</span>
        </button>

        {open && (
          <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl">
            <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
              Environments
            </div>

            <button
              onClick={() => {
                setActiveId(null);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left text-xs ${
                activeId === null ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {activeId === null ? "✓ " : "   "}
              No environment
            </button>

            {environments.map((environment) => (
              <div
                key={environment.id}
                className="group flex items-center gap-1 px-1"
              >
                {renamingId === environment.id ? (
                  <input
                    defaultValue={environment.name}
                    autoFocus
                    spellCheck={false}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name) update(environment.id, { name });
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        // Emptied first, or the blur commits what Escape meant
                        // to discard.
                        e.currentTarget.value = "";
                        e.currentTarget.blur();
                      }
                    }}
                    className="my-0.5 w-full rounded border border-brand bg-canvas px-2 py-1 text-xs text-ink outline-none"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setActiveId(environment.id);
                        setOpen(false);
                      }}
                      className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-xs ${
                        environment.id === activeId
                          ? "text-ink"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      {environment.id === activeId ? "✓ " : "   "}
                      {environment.name}
                    </button>
                    <button
                      onClick={() => setRenamingId(environment.id)}
                      className="hidden flex-none px-1 text-[11px] text-muted hover:text-ink group-hover:block"
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => duplicate(environment.id)}
                      className="hidden flex-none px-1 text-[11px] text-muted hover:text-ink group-hover:block"
                      title="Duplicate"
                    >
                      ⧉
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete environment “${environment.name}”?`,
                          body: "Its variables are removed from this workspace.",
                          warning: "This cannot be undone.",
                          confirmLabel: "Delete environment",
                          danger: true,
                        });
                        if (ok) remove(environment.id);
                      }}
                      className="hidden flex-none px-1 text-[11px] text-muted hover:text-err group-hover:block"
                      title="Delete environment"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}

            <div className="mt-1 border-t border-edge pt-1">
              {creating ? (
                <input
                  autoFocus
                  spellCheck={false}
                  placeholder="Environment name"
                  onBlur={() => setCreating(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const name = e.currentTarget.value.trim();
                      if (name) {
                        const created = create(name);
                        setActiveId(created.id);
                      }
                      setCreating(false);
                      setOpen(false);
                    }
                    if (e.key === "Escape") setCreating(false);
                  }}
                  className="mx-1 my-0.5 w-[calc(100%-0.5rem)] rounded border border-brand bg-canvas px-2 py-1 text-xs text-ink outline-none"
                />
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-muted hover:text-ink"
                >
                  + New environment
                </button>
              )}
              <button
                onClick={() => {
                  setManaging(true);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-muted hover:text-ink"
              >
                Manage variables…
              </button>
            </div>
          </div>
        )}
      </div>
      {managing && <EnvironmentManager onClose={() => setManaging(false)} />}
    </>
  );
}
