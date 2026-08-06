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
  folderOptions,
  insertNode,
  isFolder,
  moveNode,
  moveNodes,
  parentIdOf,
  removeNode,
  removeNodes,
  requestIdsIn,
  siblingRequestNamed,
  topmost,
  uniqueRequestName,
  updateNode,
  type DropPosition,
} from "../../shared/lib/tree";
import { NodeDefaultsDialog } from "./NodeDefaultsDialog";
import { printDocs, type DocsScope } from "../../shared/lib/docsPrint";
import { buildStandaloneHtml } from "../../shared/lib/docsViewer";
import { writeTextFile } from "../../shared/lib/api";
import { save } from "@tauri-apps/plugin-dialog";
import { defaultsChain } from "../../shared/lib/inherit";
import type { ExportFormat } from "../../shared/lib/interop";
import { notify } from "../../shared/lib/notify";
import { newId } from "../../shared/lib/storage";
import { methodColor, tabMethod } from "../../shared/lib/ui";
import { useValueHistory } from "../../shared/lib/valueHistory";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useConfirm } from "../../shared/state/confirm";
import { useWorkspaces } from "../../shared/state/workspaces";
import { NewRequestDialog } from "./NewRequestDialog";
import {
  type Folder,
  type Protocol,
  type SavedRequest,
  type TreeNode,
} from "../../shared/types";

interface Props {
  nodes: TreeNode[];
  onChange: (nodes: TreeNode[]) => void;
  expanded: Set<string>;
  onToggleExpanded: (id: string, force?: boolean) => void;
  activeRequestId: string | null;
  /** Single click: opens as a preview the next click can replace. */
  onOpen: (request: SavedRequest) => void;
  /** Double click: opens a tab that stays. */
  onOpenPermanent: (request: SavedRequest) => void;
  /** Create a blank request in `parentId` and open it in a tab. */
  onCreateRequest: (
    parentId: string | null,
    protocol?: Protocol,
    method?: string,
  ) => void;
  /** Lets open tabs unbind from requests that no longer exist. */
  onRequestsDeleted: (ids: string[]) => void;
  /** Opens the runner for a folder, or the whole collection when null. */
  onRun: (folderId: string | null) => void;
  /** Opens the OpenAPI import dialog. */
  onImport: () => void;
  /** Writes the workspace to a JSON file in the chosen format. */
  onExport: (format: ExportFormat) => void;
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
  onOpenPermanent,
  onCreateRequest,
  onRequestsDeleted,
  onRun,
  onImport,
  onExport,
}: Props) {
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Structural undo for the tree itself: a deleted request or folder has no
  // field left to press Cmd+Z in. Global, because the focus is almost never in
  // the sidebar by the time you want the deletion back — and it stands down for
  // a focused field with history of its own, or a list changed more recently.
  const history = useValueHistory("collection:tree", nodes, onChange, {
    global: true,
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newReqTarget, setNewReqTarget] = useState<{
    parentId: string | null;
  } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusPos, setPlusPos] = useState({ x: 0, y: 0 });
  const plusRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!plusOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (plusRef.current?.contains(target)) return;
      if (plusBtnRef.current?.contains(target)) return;
      setPlusOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPlusOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);
  function togglePlus() {
    if (plusOpen) {
      setPlusOpen(false);
      return;
    }
    const rect = plusBtnRef.current?.getBoundingClientRect();
    setPlusPos({ x: rect?.right ?? 0, y: rect?.bottom ?? 0 });
    setPlusOpen(true);
  }
  const [authFolderId, setAuthFolderId] = useState<string | null>(null);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const { collectionDefaults, setCollectionDefaults } = useCollection();
  const { environments, collectionVariables, activeId } = useEnvironments();
  const { active: activeWorkspace } = useWorkspaces();
  const collectionName = activeWorkspace?.name ?? "Collection";

  /** The whole workspace as one printable document. */
  const printCollection = () =>
    printDocs({
      kind: "collection",
      name: collectionName,
      defaults: collectionDefaults,
      tree: nodes,
    });

  /** Exports a request, folder or the whole collection as a standalone page. */
  async function exportDocsHtml(scope: DocsScope) {
    const fileName = `${(scope.kind === "request"
      ? scope.request.name
      : scope.kind === "folder"
        ? scope.folder.name
        : scope.name
    )
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "collection"}.html`;
    const path = await save({
      title: "Export as HTML",
      defaultPath: fileName,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return;
    await writeTextFile(
      path,
      buildStandaloneHtml(scope, { environments, collectionVariables, activeEnvironmentId: activeId }),
    );
    notify("info", "Exported documentation as HTML");
  }
  // Resolved from the id each render, so the dialog always edits fresh state.
  const authFolderNode = authFolderId ? findNode(nodes, authFolderId) : null;
  const authFolder =
    authFolderNode && isFolder(authFolderNode) ? authFolderNode : null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Where a shift-click measures its range from. */
  const [anchorId, setAnchorId] = useState<string | null>(null);
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

  // Keys for a live selection. All of them are gated on there being one, so
  // nothing here is in the way of the rest of the app the rest of the time.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        clearSelection();
        return;
      }
      // The search box and a rename field both sit inside the sidebar, and
      // Backspace in either means backspace.
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void removeSelected();
        return;
      }
      // Extends the selection to everything on screen. Scoped to a selection
      // that already exists, so ⌘A goes on meaning select-all-text elsewhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const order = visibleIds();
        setSelectedIds(new Set(order));
        setAnchorId(order[0] ?? null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, nodes, expanded, query]);

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
    history.commit(nodes);
    onChange(insertNode(nodes, parentId, folder));
    if (parentId) onToggleExpanded(parentId, true);
    onToggleExpanded(folder.id, true);
    setRenamingId(folder.id);
  }

  function rename(id: string, name: string) {
    const trimmed = name.trim();
    // A request may not share its folder's namespace with another request.
    if (
      trimmed !== "" &&
      siblingRequestNamed(nodes, parentIdOf(nodes, id), trimmed, id)
    ) {
      notify(
        "error",
        `A request named “${trimmed}” already exists in this folder`,
      );
      setRenamingId(null);
      return;
    }
    if (trimmed !== "") {
      history.commit(nodes);
      onChange(updateNode(nodes, id, (node) => ({ ...node, name: trimmed })));
    }
    setRenamingId(null);
  }

  function duplicate(id: string) {
    const node = findNode(nodes, id);
    if (!node) return;
    const copy = cloneNode(node);
    copy.name = uniqueRequestName(
      nodes,
      parentIdOf(nodes, id),
      `${node.name} copy`,
    );
    history.commit(nodes);
    // Sits next to the original rather than at the end of the list.
    onChange(moveNode(insertNode(nodes, null, copy), copy.id, id, "after"));
  }

  async function remove(id: string) {
    const node = findNode(nodes, id);
    if (!node) return;

    const contained = requestIdsIn(node);
    const isFolderNode = isFolder(node);

    // Folders take their whole subtree with them, so the count is the thing
    // worth showing. A single request is cheap to restore, so it skips the
    // prompt and relies on Undo instead.
    if (isFolderNode) {
      const ok = await confirm({
        title: `Delete “${node.name}”?`,
        body:
          contained.length === 0
            ? "This folder is empty."
            : `This deletes the folder and the ${contained.length} request${
                contained.length === 1 ? "" : "s"
              } inside it.`,
        warning:
          "Deletions are shared: peers syncing this workspace lose them too.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }

    // Keep the removed subtree so Undo can put it back exactly where it was,
    // with the same ids — which also un-deletes it on peers.
    const previous = nodes;
    history.commit(nodes);
    onChange(removeNode(nodes, id));
    onRequestsDeleted(contained);

    notify("info", `Deleted “${node.name}”`, {
      action: {
        label: "Undo",
        run: () => onChange(previous),
      },
    });
  }

  /**
   * Click behaviour, matching every file tree: plain click selects one thing
   * (and opens it), ⌘/ctrl toggles, shift extends from the last anchor.
   */
  function handleSelectClick(id: string, e: React.MouseEvent): boolean {
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId(id);
      return true;
    }

    if (e.shiftKey && anchorId) {
      // The range runs over what is *visible*: extending across a collapsed
      // folder's hidden children would select things you cannot see.
      const order = visibleIds();
      const from = order.indexOf(anchorId);
      const to = order.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedIds(new Set(order.slice(start, end + 1)));
        return true;
      }
    }

    return false;
  }

  /** Ids in the order they appear on screen, skipping collapsed subtrees. */
  function visibleIds(): string[] {
    const ids: string[] = [];
    const walk = (list: TreeNode[]) => {
      for (const node of list) {
        ids.push(node.id);
        if (isFolder(node) && (searching || expanded.has(node.id))) {
          walk(node.children);
        }
      }
    };
    walk(visible);
    return ids;
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setAnchorId(null);
  }

  async function removeSelected() {
    const ids = topmost(nodes, selectedIds);
    if (ids.length === 0) return;

    const requests = ids.flatMap((id) => {
      const node = findNode(nodes, id);
      return node ? requestIdsIn(node) : [];
    });
    const folders = ids.filter((id) => {
      const node = findNode(nodes, id);
      return node !== null && isFolder(node);
    }).length;

    const ok = await confirm({
      title: `Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`,
      body:
        folders > 0
          ? `This deletes ${folders} folder${
              folders === 1 ? "" : "s"
            } and the ${requests.length} request${
              requests.length === 1 ? "" : "s"
            } inside the selection.`
          : `This deletes ${requests.length} request${
              requests.length === 1 ? "" : "s"
            }.`,
      warning: "Deletions are shared: peers syncing this workspace lose them too.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    const previous = nodes;
    history.commit(nodes);
    onChange(removeNodes(nodes, ids));
    onRequestsDeleted(requests);
    clearSelection();

    notify("info", `Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`, {
      action: { label: "Undo", run: () => onChange(previous) },
    });
  }

  function moveSelected(targetId: string | null) {
    const ids = topmost(nodes, selectedIds);
    if (ids.length === 0) return;

    const previous = nodes;
    onChange(moveNodes(nodes, ids, targetId));
    if (targetId) onToggleExpanded(targetId, true);

    const where = targetId
      ? `“${findNode(nodes, targetId)?.name ?? "folder"}”`
      : "the top level";
    notify("info", `Moved ${ids.length} item${ids.length === 1 ? "" : "s"} to ${where}`, {
      action: { label: "Undo", run: () => onChange(previous) },
    });
  }

  function duplicateSelected() {
    const ids = topmost(nodes, selectedIds);
    let tree = nodes;
    for (const id of ids) {
      const node = findNode(tree, id);
      if (!node) continue;
      const copy = cloneNode(node);
      copy.name = uniqueRequestName(
        tree,
        parentIdOf(tree, id),
        `${node.name} copy`,
      );
      tree = moveNode(insertNode(tree, null, copy), copy.id, id, "after");
    }
    onChange(tree);
    clearSelection();
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

    // Dragging one of several selected rows moves all of them — dropping only
    // the row under the cursor would silently ignore the selection.
    if (selectedIds.size > 1 && selectedIds.has(active)) {
      const parent =
        target.position === "inside" ? target.id : parentIdOf(nodes, target.id ?? "");
      history.commit(nodes);
      onChange(moveNodes(nodes, [...selectedIds], target.id === null ? null : parent));
      if (parent) onToggleExpanded(parent, true);
      clearSelection();
      return;
    }

    history.commit(nodes);
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
          selected={selectedIds.has(node.id)}
          renaming={renamingId === node.id}
          onRename={(name) => rename(node.id, name)}
          onCancelRename={() => setRenamingId(null)}
          onNewRequest={() => {
            onToggleExpanded(node.id, true);
            setNewReqTarget({ parentId: node.id });
          }}
          onClick={(e) => {
            // A modified click is a selection gesture and never opens anything.
            if (handleSelectClick(node.id, e)) return;
            clearSelection();
            if (isFolder(node)) {
              // Clicking the selected folder again lets go of it. Selection
              // decides where a new request or folder is created, so with no
              // way to clear it everything kept landing inside whichever
              // folder was touched last.
              setSelectedFolderId((current) =>
                current === node.id ? null : node.id,
              );
              onToggleExpanded(node.id);
            } else {
              setSelectedFolderId(null);
              onOpen(node);
            }
          }}
          onDoubleClick={() => {
            if (!isFolder(node)) onOpenPermanent(node);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedIds.has(node.id)) clearSelection();
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
    <aside
      data-tour="collection"
      className="flex min-h-0 w-full flex-1 flex-col border-r border-edge bg-panel"
    >
      <div className="flex flex-none items-center gap-1 border-b border-edge px-2 py-1.5">
        {/* The collection is a level like a folder is, so it opens the same
            editor. A label nobody can click is what made it look missing. */}
        <button
          onClick={() => setCollectionOpen(true)}
          title="Collection settings — docs, headers, auth, scripts and options for every request in this workspace"
          className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold text-muted hover:bg-elevated hover:text-ink"
        >
          <span className="truncate">{collectionName}</span>
          <span className="flex-none text-[10px] opacity-70">⚙</span>
        </button>
        <div className="ml-auto flex items-center">
          <div className="flex-none">
            <button
              ref={plusBtnRef}
              onClick={togglePlus}
              className={`rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-ink ${
                plusOpen ? "bg-elevated text-ink" : ""
              }`}
              title="New request, folder, import or export"
            >
              +
            </button>
            {plusOpen && (
              <div
                ref={plusRef}
                className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl"
                style={{ top: plusPos.y, right: window.innerWidth - plusPos.x }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewReqTarget({ parentId: selectedFolderId });
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  New Request…
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    addFolder(selectedFolderId);
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  New Folder
                </button>
                <div className="my-1 border-t border-edge" />
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    onImport();
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  Import…
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    onExport("native");
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  Export workspace…
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    printCollection();
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  Export Docs (PDF)
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    exportDocsHtml({
                      kind: "collection",
                      name: collectionName,
                      defaults: collectionDefaults,
                      tree: nodes,
                    });
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
                >
                  Export as HTML
                </button>
              </div>
            )}
          </div>
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
          className="flex min-h-0 flex-1 flex-col overflow-auto"
          onClick={(e) => {
            // Anywhere that is not a row: the padding beside a row, the space
            // below the last one, the empty-collection notice.
            if ((e.target as Element).closest("[data-tree-row]")) return;
            setSelectedFolderId(null);
            clearSelection();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }}
        >
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-xs leading-relaxed text-muted">
              {searching
                ? "No matches."
                : "No saved requests yet. Use + to add one."}
            </p>
          ) : (
            visible.map((node) => renderNode(node, 0))
          )}
          <RootDropZone
            active={dropTarget?.id === null && dragId !== null}
            onClick={() => {
              setSelectedFolderId(null);
              clearSelection();
            }}
          />
        </div>

        <DragOverlay dropAnimation={null}>
          {draggedNode && (
            <div className="flex items-center gap-1.5 rounded border border-brand bg-elevated px-2 py-1 text-xs text-ink shadow-lg">
              {isFolder(draggedNode) ? (
                <span className="text-[11px]">📁</span>
              ) : (
                <span
                  className={`font-mono text-[10px] font-bold ${methodColor(
                    tabMethod(draggedNode.method, draggedNode.config.protocol),
                  )}`}
                >
                  {tabMethod(
                    draggedNode.method,
                    draggedNode.config.protocol,
                  ).toUpperCase()}
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
          onNewRequest={(parentId) => setNewReqTarget({ parentId })}
          onNewFolder={addFolder}
          onOpen={(node) => !isFolder(node) && onOpen(node)}
          onRename={setRenamingId}
          onDuplicate={duplicate}
          onDelete={remove}
          onRun={onRun}
          onEditAuth={setAuthFolderId}
          onEditCollection={() => setCollectionOpen(true)}
          onPrintCollection={printCollection}
          onExportHtml={exportDocsHtml}
          onExportCollectionHtml={() =>
            exportDocsHtml({
              kind: "collection",
              name: collectionName,
              defaults: collectionDefaults,
              tree: nodes,
            })
          }
          onImport={() => {
            setMenu(null);
            onImport();
          }}
          onExport={(format) => {
            setMenu(null);
            onExport(format);
          }}
          selectedCount={selectedIds.size}
          onMoveSelected={moveSelected}
          onDuplicateSelected={duplicateSelected}
          onDeleteSelected={removeSelected}
        />
      )}
      {authFolder && (
        <NodeDefaultsDialog
          title={authFolder.name}
          commentId={authFolder.id}
          defaults={authFolder}
          inherited={defaultsChain(nodes, authFolder.id, collectionDefaults)}
          onPrint={() => printDocs({ kind: "folder", folder: authFolder })}
          onClose={() => setAuthFolderId(null)}
          onChange={(patch) =>
            onChange(
              updateNode(nodes, authFolder.id, (node) =>
                isFolder(node) ? { ...node, ...patch } : node,
              ),
            )
          }
        />
      )}

      {collectionOpen && (
        <NodeDefaultsDialog
          title={collectionName}
          // The collection has no node of its own, so its comments hang off a
          // fixed key rather than an id that could collide with a request's.
          commentId="collection"
          defaults={collectionDefaults}
          // The collection is the outermost level; there is nothing above it.
          inherited={[]}
          onPrint={() => printCollection()}
          onClose={() => setCollectionOpen(false)}
          onChange={(patch) =>
            setCollectionDefaults({ ...collectionDefaults, ...patch })
          }
        />
      )}

      {newReqTarget && (
        <NewRequestDialog
          parentLabel={
            newReqTarget.parentId
              ? findNode(nodes, newReqTarget.parentId)?.name
              : undefined
          }
          onClose={() => setNewReqTarget(null)}
          onCreate={(protocol, method) => {
            const parentId = newReqTarget.parentId;
            if (parentId) onToggleExpanded(parentId, true);
            onCreateRequest(parentId, protocol, method);
          }}
        />
      )}
    </aside>
  );
}

/**
 * Empty space below the tree. Dropping here moves a node to the root, and
 * clicking here clears the folder selection — the same "nothing in particular"
 * meaning in both gestures.
 */
function RootDropZone({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: ROOT_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
      // flex-1 so it fills the rest of the panel: a 48px strip is a small
      // target for the gesture that gets you back to the root.
      className={`min-h-12 flex-1 ${active ? "bg-brand/10" : ""}`}
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
  selected: boolean;
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDoubleClick: () => void;
  onNewRequest: () => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function Row({
  node,
  depth,
  isOpen,
  drop,
  hidden,
  active,
  selected,
  renaming,
  onRename,
  onCancelRename,
  onDoubleClick,
  onNewRequest,
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
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      data-tree-row=""
      style={{ paddingLeft: 6 + depth * 12 }}
      className={`group flex cursor-default items-center gap-1.5 py-1 pr-2 text-xs ${dropCls} ${
        hidden ? "opacity-40" : ""
      } ${
        selected
          ? "bg-brand/20 text-ink shadow-[inset_2px_0_0_0_var(--color-brand)]"
          : active
            ? "bg-elevated text-ink"
            : "text-muted hover:bg-elevated/60"
      }`}
      title={isFolder(node) ? node.name : `${tabMethod(node.method, node.config.protocol)} ${node.url}`}
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
          // Sized to the method it shows, not to DELETE: a fixed column lined
          // the names up but left "GET" trailing a visible gap.
          className={`flex-none font-mono text-[10px] font-bold ${methodColor(
            tabMethod(node.method, node.config.protocol),
          )}`}
        >
          {tabMethod(node.method, node.config.protocol).toUpperCase()}
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
  onEditAuth: (folderId: string) => void;
  onEditCollection: () => void;
  onPrintCollection: () => void;
  onExportHtml: (scope: DocsScope) => void;
  onExportCollectionHtml: () => void;
  /** Opens the workspace import dialog. */
  onImport: () => void;
  /** Exports the workspace to a file in the chosen format. */
  onExport: (format: ExportFormat) => void;
  /** How many rows are highlighted; >1 turns the menu into a bulk menu. */
  selectedCount: number;
  onMoveSelected: (targetId: string | null) => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
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
  onEditAuth,
  onEditCollection,
  onPrintCollection,
  onExportHtml,
  onExportCollectionHtml,
  onImport,
  onExport,
  selectedCount,
  onMoveSelected,
  onDuplicateSelected,
  onDeleteSelected,
}: ContextMenuProps) {
  const [movingTo, setMovingTo] = useState(false);
  const { node } = state;
  // A folder hosts new items directly; a request puts them beside itself.
  const parentId = node
    ? isFolder(node)
      ? node.id
      : parentIdOf(nodes, node.id)
    : null;

  const items: { label: string; run: () => void; danger?: boolean }[] = [];

  // With several rows highlighted the menu acts on all of them; offering
  // single-item actions here would be ambiguous about which one they meant.
  if (selectedCount > 1) {
    const many = `${selectedCount} items`;
    return (
      <div
        className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-edge bg-elevated py-1 shadow-xl"
        style={{ left: state.x, top: state.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1 text-[10px] tracking-wide text-muted uppercase">
          {many} selected
        </div>
        <button
          onMouseEnter={() => setMovingTo(true)}
          onClick={() => setMovingTo((open) => !open)}
          className="flex w-full items-center px-3 py-1 text-left text-xs text-ink hover:bg-panel"
        >
          Move to<span className="ml-auto text-muted">›</span>
        </button>
        {movingTo && (
          <div className="max-h-56 overflow-auto border-y border-edge bg-panel/60">
            <button
              onClick={() => {
                onMoveSelected(null);
                onClose();
              }}
              className="block w-full px-5 py-1 text-left text-xs text-ink hover:bg-panel"
            >
              Top level
            </button>
            {folderOptions(nodes).map((folder) => (
              <button
                key={folder.id}
                onClick={() => {
                  onMoveSelected(folder.id);
                  onClose();
                }}
                title={folder.label}
                className="block w-full truncate px-5 py-1 text-left text-xs text-ink hover:bg-panel"
              >
                {folder.label}
              </button>
            ))}
            {folderOptions(nodes).length === 0 && (
              <p className="px-5 py-1 text-xs text-muted">No folders yet.</p>
            )}
          </div>
        )}
        <button
          onClick={() => {
            onDuplicateSelected();
            onClose();
          }}
          className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-panel"
        >
          Duplicate {many}
        </button>
        <button
          onClick={() => {
            onDeleteSelected();
            onClose();
          }}
          className="block w-full px-3 py-1 text-left text-xs text-err hover:bg-panel"
        >
          Delete {many}
        </button>
      </div>
    );
  }

  if (node && !isFolder(node)) {
    items.push({ label: "Open", run: () => onOpen(node) });
  }
  items.push({ label: "New Request…", run: () => onNewRequest(parentId) });
  items.push({ label: "New Folder", run: () => onNewFolder(parentId) });
  if (node && isFolder(node)) {
    items.push({ label: "Run folder", run: () => onRun(node.id) });
    items.push({ label: "Folder Settings", run: () => onEditAuth(node.id) });
    items.push({
      label: "Export Docs (PDF)",
      run: () => printDocs({ kind: "folder", folder: node }),
    });
    items.push({
      label: "Export as HTML",
      run: () => onExportHtml({ kind: "folder", folder: node }),
    });
  } else if (!node) {
    items.push({ label: "Run collection", run: () => onRun(null) });
    items.push({ label: "Collection Settings", run: onEditCollection });
    items.push({ label: "Import…", run: onImport });
    items.push({ label: "Export workspace…", run: () => onExport("native") });
    items.push({ label: "Export Docs (PDF)", run: onPrintCollection });
    items.push({ label: "Export as HTML", run: onExportCollectionHtml });
  }
  if (node) {
    items.push({ label: "Rename", run: () => onRename(node.id) });
    items.push({ label: "Duplicate", run: () => onDuplicate(node.id) });
    if (!isFolder(node)) {
      items.push({
        label: "Export as HTML",
        run: () =>
          onExportHtml({ kind: "request", request: node as SavedRequest }),
      });
    }
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
