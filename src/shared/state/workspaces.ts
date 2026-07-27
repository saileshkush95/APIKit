// Workspace list and the active selection.
//
// Switching workspaces reloads every workspace-scoped store; that is driven by
// `WorkspaceScope` in the app shell, which watches `activeId`.

import { create } from "zustand";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  onSyncApplied,
  renameWorkspace,
  setSetting,
} from "../lib/api";
import { notify } from "../lib/notify";
import { GLOBAL_SCOPE, invalidateWorkspace, SETTINGS } from "../lib/storage";
import type { WorkspaceMeta } from "../types";

interface WorkspacesStore {
  workspaces: WorkspaceMeta[];
  activeId: string | null;
  loaded: boolean;
  error: string | null;
  active: () => WorkspaceMeta | null;
  init: () => Promise<() => void>;
  switchTo: (id: string) => void;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useWorkspacesStore = create<WorkspacesStore>()((set, get) => ({
  workspaces: [],
  activeId: null,
  loaded: false,
  error: null,

  active: () =>
    get().workspaces.find((workspace) => workspace.id === get().activeId) ??
    null,

  init: async () => {
    try {
      const list = await listWorkspaces();
      // The backend guarantees at least one workspace exists.
      const stored = localStorage.getItem(SETTINGS.activeWorkspace);
      const initial =
        stored && list.some((w) => w.id === stored) ? stored : list[0]?.id;
      set({ workspaces: list, activeId: initial ?? null });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loaded: true });
    }

    // A sync can create a workspace in the database underneath us; without
    // this the new workspace stays invisible until the app restarts.
    const unlisten = await onSyncApplied(() => {
      listWorkspaces()
        .then((list) => {
          const known = new Set(get().workspaces.map((w) => w.id));
          for (const workspace of list.filter((w) => !known.has(w.id))) {
            notify("success", `Received workspace “${workspace.name}”`, {
              action: {
                label: "Open it",
                run: () => get().switchTo(workspace.id),
              },
            });
          }
          set({ workspaces: list });
        })
        .catch(() => {});
    });
    return unlisten;
  },

  switchTo: (id) => {
    set({ activeId: id });
    // Mirrored locally so the last workspace is known before the first query.
    localStorage.setItem(SETTINGS.activeWorkspace, id);
    setSetting(GLOBAL_SCOPE, SETTINGS.activeWorkspace, id).catch(() => {});
  },

  create: async (name) => {
    const workspace = await createWorkspace(name.trim() || "New Workspace");
    set({ workspaces: [...get().workspaces, workspace] });
    get().switchTo(workspace.id);
  },

  rename: async (id, name) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    await renameWorkspace(id, trimmed);
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === id ? { ...w, name: trimmed } : w,
      ),
    });
  },

  remove: async (id) => {
    await deleteWorkspace(id);
    invalidateWorkspace(id);
    const next = get().workspaces.filter((w) => w.id !== id);
    set({ workspaces: next });
    if (id === get().activeId && next[0]) get().switchTo(next[0].id);
  },
}));

/** Same shape the provider exposed, so consumers are unchanged. */
export function useWorkspaces() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const error = useWorkspacesStore((s) => s.error);
  const switchTo = useWorkspacesStore((s) => s.switchTo);
  const create = useWorkspacesStore((s) => s.create);
  const rename = useWorkspacesStore((s) => s.rename);
  const remove = useWorkspacesStore((s) => s.remove);

  return {
    workspaces,
    active: workspaces.find((w) => w.id === activeId) ?? null,
    switchTo,
    create,
    rename,
    remove,
    error,
  };
}

/** The active workspace id — empty string before the list has loaded. */
export function useWorkspaceId(): string {
  return useWorkspacesStore((s) => s.activeId) ?? "";
}
