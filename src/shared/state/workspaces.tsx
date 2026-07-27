// Workspace list + the active selection. Everything below this provider is
// remounted when the active workspace changes, so each consumer reloads its
// slice for the newly selected workspace.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  setSetting,
} from "../lib/api";
import { GLOBAL_SCOPE, invalidateWorkspace, SETTINGS } from "../lib/storage";
import type { WorkspaceMeta } from "../types";

interface WorkspacesValue {
  workspaces: WorkspaceMeta[];
  active: WorkspaceMeta | null;
  switchTo: (id: string) => void;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  error: string | null;
}

const WorkspacesContext = createContext<WorkspacesValue | null>(null);

export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        // The backend guarantees at least one workspace exists.
        const stored = localStorage.getItem(SETTINGS.activeWorkspace);
        const initial =
          stored && list.some((w) => w.id === stored) ? stored : list[0]?.id;
        setActiveId(initial ?? null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoaded(true));
  }, []);

  const switchTo = useCallback((id: string) => {
    setActiveId(id);
    // Mirrored locally so the last workspace is known before the first query.
    localStorage.setItem(SETTINGS.activeWorkspace, id);
    setSetting(GLOBAL_SCOPE, SETTINGS.activeWorkspace, id).catch(() => {});
  }, []);

  const create = useCallback(
    async (name: string) => {
      const workspace = await createWorkspace(name.trim() || "New Workspace");
      setWorkspaces((prev) => [...prev, workspace]);
      switchTo(workspace.id);
    },
    [switchTo],
  );

  const rename = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    await renameWorkspace(id, trimmed);
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id ? { ...w, name: trimmed } : w)),
    );
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteWorkspace(id);
      invalidateWorkspace(id);
      setWorkspaces((prev) => {
        const next = prev.filter((w) => w.id !== id);
        if (id === activeId && next[0]) switchTo(next[0].id);
        return next;
      });
    },
    [activeId, switchTo],
  );

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const value = useMemo<WorkspacesValue>(
    () => ({ workspaces, active, switchTo, create, rename, remove, error }),
    [workspaces, active, switchTo, create, rename, remove, error],
  );

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas text-muted">
        Loading workspace…
      </div>
    );
  }

  if (error && workspaces.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-8 text-center text-err">
        Could not open the workspace database: {error}
      </div>
    );
  }

  return (
    <WorkspacesContext.Provider value={value}>
      {children}
    </WorkspacesContext.Provider>
  );
}

export function useWorkspaces(): WorkspacesValue {
  const value = useContext(WorkspacesContext);
  if (!value) {
    throw new Error("useWorkspaces must be used inside <WorkspacesProvider>");
  }
  return value;
}

/** The active workspace id — safe to call below `WorkspacesProvider`. */
export function useWorkspaceId(): string {
  const { active } = useWorkspaces();
  return active?.id ?? "";
}
