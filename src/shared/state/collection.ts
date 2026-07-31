// The saved-request tree, shared by the sidebar and the collection runner.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { saveTree, setSetting } from "../lib/api";
import { notifyError } from "../lib/notify";
import { createSaver } from "../lib/save";
import { SETTINGS, workspaceDataOnce } from "../lib/storage";
import type { NodeDefaults, TreeNode } from "../types";

/**
 * Stored as JSON in a setting, like the collection variables. A malformed value
 * reads as empty: losing the defaults is bad, failing to open the workspace is
 * worse.
 */
function parseDefaults(stored: string | undefined): NodeDefaults {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" ? (parsed as NodeDefaults) : {};
  } catch {
    return {};
  }
}

interface CollectionStore {
  workspaceId: string;
  tree: TreeNode[];
  /**
   * What the collection itself contributes to every request in it — the
   * outermost level of the chain that continues through the folders. Kept
   * beside the tree rather than with the environments: it belongs to the
   * collection, not to whichever environment happens to be selected.
   */
  collectionDefaults: NodeDefaults;
  expanded: Set<string>;
  ready: boolean;
  load: (workspaceId: string) => Promise<void>;
  setTree: (tree: TreeNode[]) => void;
  setCollectionDefaults: (defaults: NodeDefaults) => void;
  toggleExpanded: (id: string, force?: boolean) => void;
}

export const useCollectionStore = create<CollectionStore>()((set, get) => {
  const saveTreeSoon = createSaver<{ workspaceId: string; tree: TreeNode[] }>(
    ({ workspaceId, tree }) => saveTree(workspaceId, tree),
  );
  const saveExpandedSoon = createSaver<{
    workspaceId: string;
    expanded: Set<string>;
  }>(({ workspaceId, expanded }) =>
    setSetting(
      workspaceId,
      SETTINGS.expandedFolders,
      JSON.stringify([...expanded]),
    ),
  );

  return {
    workspaceId: "",
    tree: [],
    collectionDefaults: {},
    expanded: new Set<string>(),
    ready: false,

    load: async (workspaceId) => {
      set({ ready: false, workspaceId });
      try {
        const workspace = await workspaceDataOnce(workspaceId);
        const saved = workspace.settings[SETTINGS.expandedFolders];
        let expanded = new Set<string>();
        if (saved) {
          try {
            expanded = new Set(JSON.parse(saved) as string[]);
          } catch {
            /* ignore malformed state */
          }
        }
        set({
          tree: workspace.tree,
          collectionDefaults: parseDefaults(
            workspace.settings[SETTINGS.collectionDefaults],
          ),
          expanded,
        });
      } catch (e) {
        notifyError("Could not load the collection", e);
      } finally {
        set({ ready: true });
      }
    },

    setTree: (tree) => {
      set({ tree });
      saveTreeSoon({ workspaceId: get().workspaceId, tree });
    },

    setCollectionDefaults: (collectionDefaults) => {
      set({ collectionDefaults });
      setSetting(
        get().workspaceId,
        SETTINGS.collectionDefaults,
        JSON.stringify(collectionDefaults),
      ).catch((e) => notifyError("Could not save the collection settings", e));
    },

    toggleExpanded: (id, force) => {
      const expanded = new Set(get().expanded);
      if (force ?? !expanded.has(id)) expanded.add(id);
      else expanded.delete(id);
      set({ expanded });
      saveExpandedSoon({ workspaceId: get().workspaceId, expanded });
    },
  };
});

/** Same shape the provider exposed, so consumers are unchanged. */
export function useCollection() {
  // `useShallow` is required in Zustand 5: a selector that builds a new object
  // every call would otherwise re-render without end.
  return useCollectionStore(
    useShallow((s) => ({
      tree: s.tree,
      setTree: s.setTree,
      collectionDefaults: s.collectionDefaults,
      setCollectionDefaults: s.setCollectionDefaults,
      ready: s.ready,
      expanded: s.expanded,
      toggleExpanded: s.toggleExpanded,
    })),
  );
}
