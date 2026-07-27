import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  cloneNode,
  filterTree,
  findNode,
  insertNode,
  isFolder,
  moveNode,
  parentIdOf,
  removeNode,
  requestIdsIn,
  updateNode,
  type DropPosition,
} from "../lib/tree";
import { newId } from "../lib/storage";
import { methodColor } from "../lib/ui";
import type { Folder, SavedRequest, TreeNode } from "../types";

interface Props {
  nodes: TreeNode[];
  onChange: (nodes: TreeNode[]) => void;
  expanded: Set<string>;
  onToggleExpanded: (id: string, force?: boolean) => void;
  activeRequestId: string | null;
  onOpen: (request: SavedRequest) => void;
  /** Create a blank request in `parentId` and open it in a tab. */
  onCreateRequest: (parentId: string | null) => void;
  /** Lets open tabs unbind from requests that no longer exist. */
  onRequestsDeleted: (ids: string[]) => void;
  /** Opens the runner for a folder, or the whole collection when null. */
  onRun: (folderId: string | null) => void;
  /** Opens the OpenAPI import dialog. */
  onImport: () => void;
  /** Writes the workspace to a JSON file. */
  onExport: () => void;
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNode | null;
}

/** Id of the droppable covering empty space below the tree. */
const ROOT_DROP_ID = "__root__";

function newFolder(name = "New Folder"): Folder {
  return { kind: "folder", id: newId(), name, children: [] };
}

export function CollectionSidebar({
  nodes,
  onChange,
  expanded,
  onToggleExpanded,
  activeRequestId,
  onOpen,
  onCreateRequest,
  onRequestsDeleted,
  onRun,
  onImport,
  onExport,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string | null;
    position: DropPosition;
  } | null>(null);

  // Hovering a collapsed folder mid-drag opens it, so nested drops are
  // reachable without dropping first.
  const hoverTimer = useRef<{ id: string; timer: number } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const visible = filterTree(nodes, query);
  // While searching, everything on screen is a match — show it expanded.
  const searching = query.trim() !== "";

  function addFolder(parentId: string | null) {
    const folder = newFolder();
    onChange(insertNode(nodes, parentId, folder));
    if (parentId) onToggleExpanded(parentId, true);
    onToggleExpanded(folder.id, true);
    setRenamingId(folder.id);
  }

  function rename(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed !== "") {
      onChange(updateNode(nodes, id, (node) => ({ ...node, name: trimmed })));
    }
    setRenamingId(null);
  }

  function duplicate(id: string) {
    const node = findNode(nodes, id);
    if (!node) return;
    const copy = cloneNode(node);
    copy.name = `${node.name} copy`;
    // Sits next to the original rather than at the end of the list.
    onChange(moveNode(insertNode(nodes, null, copy), copy.id, id, "after"));
  }

  function remove(id: string) {
    const node = findNode(nodes, id);
    if (!node) return;
    onChange(removeNode(nodes, id));
    onRequestsDeleted(requestIdsIn(node));
  }

  function clearHoverTimer() {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current.timer);
      hoverTimer.current = null;
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setDragId(String(event.active.id));
  }

  /**
   * dnd-kit reports which row is under the pointer; the drop *position* comes
   * from where the dragged row's centre sits within that row — top quarter is
   * "before", bottom quarter "after", and the middle drops inside a folder.
   */
  function handleDragMove(event: DragMoveEvent) {
    const { over, active } = event;
    if (!over) {
      setDropTarget(null);
      clearHoverTimer();
      return;
    }
    if (over.id === ROOT_DROP_ID) {
      setDropTarget({ id: null, position: "after" });
      clearHoverTimer();
      return;
    }
    if (over.id === active.id) {
      setDropTarget(null);
      return;
    }

    const node = findNode(nodes, String(over.id));
    if (!node) return;

    const dragged = active.rect.current.translated;
    const centre = dragged
      ? dragged.top + dragged.height / 2
      : over.rect.top + over.rect.height / 2;
    const ratio = (centre - over.rect.top) / over.rect.height;

    let position: DropPosition;
    if (isFolder(node)) {
      position = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
    } else {
      position = ratio < 0.5 ? "before" : "after";
    }
    setDropTarget({ id: node.id, position });

    if (position === "inside" && !expanded.has(node.id)) {
      if (hoverTimer.current?.id !== node.id) {
        clearHoverTimer();
        hoverTimer.current = {
          id: node.id,
          timer: window.setTimeout(() => onToggleExpanded(node.id, true), 600),
        };
      }
    } else {
      clearHoverTimer();
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    clearHoverTimer();
    const active = String(event.active.id);
    const target = dropTarget;
    setDragId(null);
    setDropTarget(null);
    if (!target) return;

    onChange(moveNode(nodes, active, target.id, target.position));
    if (target.position === "inside" && target.id) {
      onToggleExpanded(target.id, true);
    }
  }

  function renderNode(node: TreeNode, depth: number) {
    const isOpen = searching || expanded.has(node.id);
    const drop = dropTarget?.id === node.id ? dropTarget.position : null;

    return (
      <div key={node.id}>
        <Row
          node={node}
          depth={depth}
          isOpen={isOpen}
          drop={drop}
          hidden={dragId === node.id}
          active={
            (!isFolder(node) && node.id === activeRequestId) ||
            (isFolder(node) && node.id === selectedFolderId)
          }
          renaming={renamingId === node.id}
          onRename={(name) => rename(node.id, name)}
          onCancelRename={() => setRenamingId(null)}
          onNewRequest={() => {
            onToggleExpanded(node.id, true);
            onCreateRequest(node.id);
          }}
          onNewFolder={() => addFolder(node.id)}
          onClick={() => {
            if (isFolder(node)) {
              setSelectedFolderId(node.id);
              onToggleExpanded(node.id);
            } else {
              setSelectedFolderId(null);
              onOpen(node);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, node });
          }}
        />
        {isFolder(node) && isOpen && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.children.length === 0 && (
              <div
                className="py-1 text-[11px] text-muted/60"
                style={{ paddingLeft: 12 + (depth + 1) * 12 }}
              >
                Empty
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const draggedNode = dragId ? findNode(nodes, dragId) : null;

  return (
    <aside className="flex w-60 flex-none flex-col border-r border-edge bg-panel">
      <div className="flex flex-none items-center gap-1 border-b border-edge px-2 py-1.5">
        <span className="px-1 text-xs font-semibold text-muted">Collection</span>
        <div className="ml-auto flex items-center">
          {/* New items land in the selected folder, or at the root. */}
          <button
            onClick={() => {
              if (selectedFolderId) onToggleExpanded(selectedFolderId, true);
              onCreateRequest(selectedFolderId);
            }}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-ink"
            title={
              selectedFolderId ? "New request in selected folder" : "New request"
            }
          >
            +
          </button>
          <button
            onClick={onImport}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-ink"
            title="Import an OpenAPI spec or Postman collection"
          >
            ↓
          </button>
          <button
            onClick={onExport}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-ink"
            title="Export this workspace to a file"
          >
            ↑
          </button>
          <button
            onClick={() => addFolder(selectedFolderId)}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-ink"
            title={
              selectedFolderId
                ? "New folder inside selected folder"
                : "New folder"
            }
          >
            ⊞
          </button>
        </div>
      </div>

      <div className="flex-none px-2 py-1.5">
        <input
          value={query}
          spellCheck={false}
          placeholder="Filter requests…"
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-edge bg-elevated px-2 py-1 text-xs text-ink outline-none focus:border-brand"
        />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          clearHoverTimer();
          setDragId(null);
          setDropTarget(null);
        }}
      >
        <div
          className="min-h-0 flex-1 overflow-auto"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }}
        >
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-xs leading-relaxed text-muted">
              {searching
                ? "No matches."
                : "No saved requests yet. Use + to add one, or ⊞ for a folder."}
            </p>
          ) : (
            visible.map((node) => renderNode(node, 0))
          )}
          <RootDropZone active={dropTarget?.id === null && dragId !== null} />
        </div>

        <DragOverlay dropAnimation={null}>
          {draggedNode && (
            <div className="flex items-center gap-1.5 rounded border border-brand bg-elevated px-2 py-1 text-xs text-ink shadow-lg">
              {isFolder(draggedNode) ? (
                <span className="text-[11px]">📁</span>
              ) : (
                <span
                  className={`font-mono text-[10px] font-bold ${methodColor(
                    draggedNode.method,
                  )}`}
                >
                  {draggedNode.method.toUpperCase()}
                </span>
              )}
              {draggedNode.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {menu && (
        <ContextMenu
          state={menu}
          nodes={nodes}
          onClose={() => setMenu(null)}
          onNewRequest={(parentId) => onCreateRequest(parentId)}
          onNewFolder={addFolder}
          onOpen={(node) => !isFolder(node) && onOpen(node)}
          onRename={setRenamingId}
          onDuplicate={duplicate}
          onDelete={remove}
          onRun={onRun}
        />
      )}
    </aside>
  );
}

/** Empty space below the tree; dropping here moves a node to the root. */
function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: ROOT_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-12 ${active ? "bg-brand/10" : ""}`}
      aria-hidden
    />
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  isOpen: boolean;
  drop: DropPosition | null;
  hidden: boolean;
  active: boolean;
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onNewRequest: () => void;
  onNewFolder: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function Row({
  node,
  depth,
  isOpen,
  drop,
  hidden,
  active,
  renaming,
  onRename,
  onCancelRename,
  onNewRequest,
  onNewFolder,
  onClick,
  onContextMenu,
}: RowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { setNodeRef: setDropRef } = useDroppable({ id: node.id });
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
  } = useDraggable({ id: node.id, disabled: renaming });

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const dropCls =
    drop === "inside"
      ? "bg-brand/20"
      : drop === "before"
        ? "shadow-[inset_0_2px_0_0_var(--color-brand)]"
        : drop === "after"
          ? "shadow-[inset_0_-2px_0_0_var(--color-brand)]"
          : "";

  return (
    <div
      ref={(element) => {
        setDropRef(element);
        setDragRef(element);
      }}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={`group flex cursor-default items-center gap-1.5 py-1 pr-2 text-xs ${dropCls} ${
        hidden ? "opacity-40" : ""
      } ${active ? "bg-elevated text-ink" : "text-muted hover:bg-elevated/60"}`}
      title={isFolder(node) ? node.name : `${node.method} ${node.url}`}
    >
      {isFolder(node) ? (
        <span className="w-3 flex-none text-center text-[9px] text-muted">
          {isOpen ? "▼" : "▶"}
        </span>
      ) : (
        <span className="w-3 flex-none" />
      )}

      {isFolder(node) ? (
        <span className="flex-none text-[11px]">📁</span>
      ) : (
        <span
          className={`w-11 flex-none font-mono text-[10px] font-bold ${methodColor(
            node.method,
          )}`}
        >
          {node.method.toUpperCase()}
        </span>
      )}

      {renaming ? (
        <input
          ref={inputRef}
          defaultValue={node.name}
          spellCheck={false}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename(e.currentTarget.value);
            if (e.key === "Escape") onCancelRename();
          }}
          className="min-w-0 flex-1 rounded border border-brand bg-canvas px-1 py-0.5 text-xs text-ink outline-none"
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${active ? "text-ink" : ""}`}>
          {node.name}
        </span>
      )}

      {/* Nesting affordances — right-click offers the same actions. */}
      {isFolder(node) && !renaming && (
        <span className="hidden flex-none items-center group-hover:flex">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onNewRequest();
            }}
            className="px-1 text-sm leading-none text-muted hover:text-ink"
            title="New request in this folder"
          >
            +
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onNewFolder();
            }}
            className="px-1 text-[11px] leading-none text-muted hover:text-ink"
            title="New folder inside this folder"
          >
            ⊞
          </button>
        </span>
      )}
    </div>
  );
}

interface ContextMenuProps {
  state: MenuState;
  /** Needed to resolve the parent folder of a right-clicked request. */
  nodes: TreeNode[];
  onClose: () => void;
  onNewRequest: (parentId: string | null) => void;
  onNewFolder: (parentId: string | null) => void;
  onOpen: (node: TreeNode) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRun: (folderId: string | null) => void;
}

function ContextMenu({
  state,
  nodes,
  onClose,
  onNewRequest,
  onNewFolder,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onRun,
}: ContextMenuProps) {
  const { node } = state;
  // A folder hosts new items directly; a request puts them beside itself.
  const parentId = node
    ? isFolder(node)
      ? node.id
      : parentIdOf(nodes, node.id)
    : null;

  const items: { label: string; run: () => void; danger?: boolean }[] = [];

  if (node && !isFolder(node)) {
    items.push({ label: "Open", run: () => onOpen(node) });
  }
  items.push({ label: "New Request", run: () => onNewRequest(parentId) });
  items.push({ label: "New Folder", run: () => onNewFolder(parentId) });
  if (node && isFolder(node)) {
    items.push({ label: "Run folder", run: () => onRun(node.id) });
  } else if (!node) {
    items.push({ label: "Run collection", run: () => onRun(null) });
  }
  if (node) {
    items.push({ label: "Rename", run: () => onRename(node.id) });
    items.push({ label: "Duplicate", run: () => onDuplicate(node.id) });
    items.push({
      label: isFolder(node) ? "Delete Folder" : "Delete",
      run: () => onDelete(node.id),
      danger: true,
    });
  }

  return (
    <div
      className="fixed z-50 min-w-36 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl"
      style={{ left: state.x, top: state.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            item.run();
            onClose();
          }}
          className={`block w-full px-3 py-1 text-left text-xs hover:bg-panel ${
            item.danger ? "text-err" : "text-ink"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
