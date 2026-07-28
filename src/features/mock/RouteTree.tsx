import { useState } from "react";
import { Toggle } from "../../shared/components/Toggle";
import { methodColor, statusColor } from "../../shared/lib/ui";
import type { MockRoute } from "../../shared/types";
import { flatten, isWithin, type TreeItem } from "./routeOps";

interface Props {
  routes: MockRoute[];
  selectedId: string | null;
  /** Multi-selection for bulk actions; always contains selectedId when set. */
  checked: Set<string>;
  collapsed: Set<string>;
  /** Ids to show, or null for "no search running". */
  visibleIds: Set<string> | null;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onToggleCollapse: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MockRoute>) => void;
  onMove: (ids: string[], parentId: string | null, beforeId: string | null) => void;
  onContextMenu: (id: string, event: React.MouseEvent) => void;
  renamingId: string | null;
  onRename: (id: string, name: string) => void;
}

/** Where a drop would land: inside a folder, or between two rows. */
type DropTarget = { id: string; where: "into" | "before" | "after" } | null;

export function RouteTree({
  routes,
  selectedId,
  checked,
  collapsed,
  visibleIds,
  onSelect,
  onToggleCollapse,
  onUpdate,
  onMove,
  onContextMenu,
  renamingId,
  onRename,
}: Props) {
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [drop, setDrop] = useState<DropTarget>(null);

  const items = flatten(routes, collapsed).filter(
    (item) => !visibleIds || visibleIds.has(item.route.id),
  );

  function beginDrag(item: TreeItem, e: React.DragEvent) {
    // Dragging an unselected row drags just that row, matching the sidebar.
    const ids = checked.has(item.route.id) ? Array.from(checked) : [item.route.id];
    setDragIds(ids);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ids.join(","));
  }

  function overRow(item: TreeItem, e: React.DragEvent) {
    if (dragIds.length === 0) return;
    e.preventDefault();
    // Dropping a folder into itself would detach the subtree.
    if (dragIds.some((id) => isWithin(routes, item.route.id, id))) {
      setDrop(null);
      return;
    }
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = (e.clientY - box.top) / box.height;
    if (item.route.isFolder && offset > 0.25 && offset < 0.75) {
      setDrop({ id: item.route.id, where: "into" });
    } else {
      setDrop({ id: item.route.id, where: offset < 0.5 ? "before" : "after" });
    }
  }

  function commitDrop() {
    if (!drop || dragIds.length === 0) return finishDrag();
    const target = routes.find((route) => route.id === drop.id);
    if (!target) return finishDrag();

    if (drop.where === "into") {
      onMove(dragIds, target.id, null);
    } else {
      const siblings = routes.filter(
        (route) => (route.parentId ?? null) === (target.parentId ?? null),
      );
      const index = siblings.findIndex((route) => route.id === target.id);
      const before =
        drop.where === "before"
          ? target.id
          : (siblings[index + 1]?.id ?? null);
      onMove(dragIds, target.parentId ?? null, before);
    }
    finishDrag();
  }

  function finishDrag() {
    setDragIds([]);
    setDrop(null);
  }

  if (items.length === 0) {
    return (
      <p className="px-3 py-3 text-xs leading-relaxed text-muted">
        {visibleIds
          ? "Nothing matches."
          : "No routes yet. Add one to start serving canned responses."}
      </p>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        // The empty area below the list drops at the root.
        if (dragIds.length > 0 && e.target === e.currentTarget) {
          e.preventDefault();
          setDrop(null);
        }
      }}
      onDrop={(e) => {
        if (e.target === e.currentTarget && dragIds.length > 0) {
          onMove(dragIds, null, null);
          finishDrag();
        }
      }}
      className="min-h-full"
    >
      {items.map((item) => {
        const { route, depth } = item;
        const isChecked = checked.has(route.id);
        const marker = drop?.id === route.id ? drop.where : null;

        return (
          <div
            key={route.id}
            draggable={renamingId !== route.id}
            onDragStart={(e) => beginDrag(item, e)}
            onDragOver={(e) => overRow(item, e)}
            onDragLeave={() => setDrop((d) => (d?.id === route.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commitDrop();
            }}
            onDragEnd={finishDrag}
            onClick={(e) => onSelect(route.id, e)}
            onContextMenu={(e) => onContextMenu(route.id, e)}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            className={`flex cursor-default items-center gap-1.5 border-y border-transparent py-1 pr-2 text-xs ${
              marker === "into" ? "bg-brand/20" : ""
            } ${marker === "before" ? "border-t-brand" : ""} ${
              marker === "after" ? "border-b-brand" : ""
            } ${
              route.id === selectedId
                ? "bg-elevated text-ink"
                : isChecked
                  ? "bg-brand/10 text-ink"
                  : "text-muted hover:bg-elevated/60"
            } ${route.enabled ? "" : "opacity-50"}`}
          >
            {route.isFolder ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse(route.id);
                }}
                className="w-3 flex-none text-[9px] text-muted"
              >
                {collapsed.has(route.id) ? "▸" : "▾"}
              </button>
            ) : (
              <span className="w-3 flex-none" />
            )}

            <Toggle
              checked={route.enabled}
              onChange={(enabled) => onUpdate(route.id, { enabled })}
              onClick={(e) => e.stopPropagation()}
              title={route.isFolder ? "Serve routes in this folder" : "Serve this route"}
            />

            {renamingId === route.id ? (
              <input
                autoFocus
                defaultValue={route.isFolder ? route.name : route.path}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => onRename(route.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRename(route.id, e.currentTarget.value);
                  if (e.key === "Escape") onRename(route.id, "");
                }}
                className="min-w-0 flex-1 rounded border border-brand bg-panel px-1 py-0.5 font-mono text-xs text-ink outline-none"
              />
            ) : route.isFolder ? (
              <>
                <span className="flex-none text-[11px]">📁</span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {route.name || "Folder"}
                </span>
              </>
            ) : (
              <>
                <span
                  className={`w-9 flex-none font-mono text-[10px] font-bold ${methodColor(
                    route.method,
                  )}`}
                >
                  {route.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {route.path}
                </span>
                <span
                  className={`flex-none font-mono text-[11px] ${statusColor(
                    route.status,
                  )}`}
                >
                  {route.status}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
