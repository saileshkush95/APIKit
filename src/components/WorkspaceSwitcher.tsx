import { useEffect, useRef, useState } from "react";
import { useWorkspaces } from "../state/workspaces";

/** Header dropdown for switching, creating, renaming and deleting workspaces. */
export function WorkspaceSwitcher() {
  const { workspaces, active, switchTo, create, rename, remove } =
    useWorkspaces();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  async function guard(action: Promise<unknown>) {
    setError(null);
    try {
      await action;
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-edge px-2.5 text-xs text-ink hover:bg-elevated"
        title="Switch workspace"
      >
        <span className="max-w-40 truncate">{active?.name ?? "Workspace"}</span>
        <span className="text-[9px] text-muted">▼</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Workspaces
          </div>

          {workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className="group flex items-center gap-1 px-1"
            >
              {renamingId === workspace.id ? (
                <input
                  defaultValue={workspace.name}
                  autoFocus
                  spellCheck={false}
                  onBlur={(e) => {
                    guard(rename(workspace.id, e.target.value));
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      guard(rename(workspace.id, e.currentTarget.value));
                      setRenamingId(null);
                    }
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="my-0.5 w-full rounded border border-brand bg-canvas px-2 py-1 text-xs text-ink outline-none"
                />
              ) : (
                <>
                  <button
                    onClick={() => {
                      switchTo(workspace.id);
                      setOpen(false);
                    }}
                    className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-xs ${
                      workspace.id === active?.id
                        ? "text-ink"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {workspace.id === active?.id ? "✓ " : "   "}
                    {workspace.name}
                  </button>
                  <button
                    onClick={() => setRenamingId(workspace.id)}
                    className="hidden flex-none px-1 text-[11px] text-muted hover:text-ink group-hover:block"
                    title="Rename"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => guard(remove(workspace.id))}
                    className="hidden flex-none px-1 text-[11px] text-muted hover:text-err group-hover:block"
                    title="Delete workspace"
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
                placeholder="Workspace name"
                onBlur={() => setCreating(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    guard(create(e.currentTarget.value));
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
                + New workspace
              </button>
            )}
          </div>

          {error && (
            <div className="px-3 py-1.5 text-[11px] text-err">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
