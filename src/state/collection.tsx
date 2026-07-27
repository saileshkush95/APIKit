// The saved-request tree, shared by the sidebar and the collection runner.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { saveTree, setSetting } from "../lib/api";
import { usePersist } from "../lib/persist";
import { SETTINGS, workspaceDataOnce } from "../lib/storage";
import { useSync } from "./sync";
import { useWorkspaceId } from "./workspaces";
import type { TreeNode } from "../types";

interface CollectionValue {
  tree: TreeNode[];
  setTree: (tree: TreeNode[]) => void;
  ready: boolean;
  expanded: Set<string>;
  toggleExpanded: (id: string, force?: boolean) => void;
}

const CollectionContext = createContext<CollectionValue | null>(null);

export function CollectionProvider({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();
  // Bumped when a sync applied rows, so the view reflects the new data.
  const { revision } = useSync();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        setTree(workspace.tree);
        const saved = workspace.settings[SETTINGS.expandedFolders];
        if (saved) {
          try {
            setExpanded(new Set(JSON.parse(saved) as string[]));
          } catch {
            /* ignore malformed state */
          }
        }
      })
      .catch((e) => console.error("failed to load collection", e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, revision]);

  usePersist(tree, ready, (value) => saveTree(workspaceId, value));
  usePersist(expanded, ready, (value) =>
    setSetting(
      workspaceId,
      SETTINGS.expandedFolders,
      JSON.stringify([...value]),
    ),
  );

  const toggleExpanded = useCallback((id: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const open = force ?? !next.has(id);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<CollectionValue>(
    () => ({ tree, setTree, ready, expanded, toggleExpanded }),
    [tree, ready, expanded, toggleExpanded],
  );

  return (
    <CollectionContext.Provider value={value}>
      {children}
    </CollectionContext.Provider>
  );
}

export function useCollection(): CollectionValue {
  const value = useContext(CollectionContext);
  if (!value) {
    throw new Error("useCollection must be used inside <CollectionProvider>");
  }
  return value;
}
