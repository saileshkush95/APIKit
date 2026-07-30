import { useContext, useMemo, type ReactNode } from "react";
import { HistoryScopeContext } from "../lib/fieldHistory";

/**
 * Names this part of the tree for undo purposes.
 *
 * Scopes nest, so each level only supplies its own piece: the shell supplies
 * the workspace, a request pane its tab, a key/value grid the list it edits.
 * A field then needs nothing but its own short name, which is what makes it
 * cheap enough to give every field a history rather than only a chosen few.
 */
export function HistoryScope({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const parent = useContext(HistoryScopeContext);
  const scope = useMemo(() => (parent ? `${parent}:${id}` : id), [parent, id]);
  return (
    <HistoryScopeContext.Provider value={scope}>
      {children}
    </HistoryScopeContext.Provider>
  );
}
