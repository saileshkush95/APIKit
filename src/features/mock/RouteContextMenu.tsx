import { useEffect } from "react";
import type { MockRoute } from "../../shared/types";

export interface MenuState {
  x: number;
  y: number;
  route: MockRoute;
}

interface Props {
  state: MenuState;
  /** How many rows are highlighted; >1 turns this into a bulk menu. */
  selectedCount: number;
  onClose: () => void;
  onNewRoute: (parentId: string | null) => void;
  onNewFolder: (parentId: string | null) => void;
  onRename: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
}

/** Right-click menu for the mock route list, matching the collection sidebar. */
export function RouteContextMenu({
  state,
  selectedCount,
  onClose,
  onNewRoute,
  onNewFolder,
  onRename,
  onDuplicate,
  onDelete,
  onSetEnabled,
}: Props) {
  useEffect(() => {
    function dismiss(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      onClose();
    }
    // Capture, so a click anywhere closes before it lands on a row.
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("keydown", dismiss);
    };
  }, [onClose]);

  const { route } = state;
  // A folder hosts new items directly; a route puts them beside itself.
  const parentId = route.isFolder ? route.id : (route.parentId ?? null);
  const many = selectedCount > 1;

  const items: {
    label: string;
    run: () => void;
    danger?: boolean;
    divide?: boolean;
  }[] = many
    ? [
        { label: `Enable ${selectedCount} items`, run: () => onSetEnabled(true) },
        { label: `Disable ${selectedCount} items`, run: () => onSetEnabled(false) },
        {
          label: `Duplicate ${selectedCount} items`,
          run: onDuplicate,
          divide: true,
        },
        {
          label: `Delete ${selectedCount} items`,
          run: onDelete,
          danger: true,
        },
      ]
    : [
        { label: "New route here", run: () => onNewRoute(parentId) },
        { label: "New folder here", run: () => onNewFolder(parentId), divide: true },
        { label: "Rename", run: () => onRename(route.id) },
        { label: "Duplicate", run: onDuplicate },
        {
          label: route.enabled ? "Disable" : "Enable",
          run: () => onSetEnabled(!route.enabled),
          divide: true,
        },
        { label: "Delete", run: onDelete, danger: true },
      ];

  return (
    <div
      className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl"
      // Kept inside the viewport when the click lands near an edge.
      style={{
        left: Math.min(state.x, window.innerWidth - 190),
        top: Math.min(state.y, window.innerHeight - items.length * 26 - 40),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="truncate px-3 py-1 text-[10px] tracking-wide text-muted uppercase">
        {many
          ? `${selectedCount} selected`
          : route.isFolder
            ? route.name || "Folder"
            : `${route.method} ${route.path}`}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            item.run();
            onClose();
          }}
          className={`block w-full px-3 py-1 text-left text-xs hover:bg-panel ${
            item.danger ? "text-err" : "text-ink"
          } ${item.divide ? "border-b border-edge" : ""}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
