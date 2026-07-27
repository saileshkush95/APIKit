// Pure operations over the collection tree. Every function returns a new array
// so React state updates stay immutable; `null` as a parent id means the root.

import { newId } from "./storage";
import type { Folder, SavedRequest, TreeNode } from "../types";

export function isFolder(node: TreeNode): node is Folder {
  return node.kind === "folder";
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (isFolder(node)) {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function findRequest(
  nodes: TreeNode[],
  id: string,
): SavedRequest | null {
  const node = findNode(nodes, id);
  return node && !isFolder(node) ? node : null;
}

/** Folder names from the root down to `id`, excluding the node itself. */
export function pathTo(nodes: TreeNode[], id: string): string[] {
  function walk(list: TreeNode[], trail: string[]): string[] | null {
    for (const node of list) {
      if (node.id === id) return trail;
      if (isFolder(node)) {
        const hit = walk(node.children, [...trail, node.name]);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(nodes, []) ?? [];
}

export function updateNode(
  nodes: TreeNode[],
  id: string,
  patch: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === id) return patch(node);
    if (isFolder(node)) {
      return { ...node, children: updateNode(node.children, id, patch) };
    }
    return node;
  });
}

export function removeNode(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) =>
      isFolder(node)
        ? { ...node, children: removeNode(node.children, id) }
        : node,
    );
}

/** Appends into `parentId`'s children, or the root list when it is `null`. */
export function insertNode(
  nodes: TreeNode[],
  parentId: string | null,
  node: TreeNode,
): TreeNode[] {
  if (parentId === null) return [...nodes, node];
  return nodes.map((candidate) => {
    if (candidate.id === parentId && isFolder(candidate)) {
      return { ...candidate, children: [...candidate.children, node] };
    }
    if (isFolder(candidate)) {
      return { ...candidate, children: insertNode(candidate.children, parentId, node) };
    }
    return candidate;
  });
}

/** Inserts `node` next to the sibling `targetId`, before or after it. */
function insertBeside(
  nodes: TreeNode[],
  targetId: string,
  node: TreeNode,
  side: "before" | "after",
): TreeNode[] {
  const index = nodes.findIndex((n) => n.id === targetId);
  if (index !== -1) {
    const next = [...nodes];
    next.splice(side === "before" ? index : index + 1, 0, node);
    return next;
  }
  return nodes.map((candidate) =>
    isFolder(candidate)
      ? {
          ...candidate,
          children: insertBeside(candidate.children, targetId, node, side),
        }
      : candidate,
  );
}

export function containsNode(root: TreeNode, id: string): boolean {
  if (root.id === id) return true;
  return isFolder(root) && root.children.some((c) => containsNode(c, id));
}

export type DropPosition = "inside" | "before" | "after";

/**
 * Moves `dragId` relative to `targetId`. Dropping a folder into its own subtree
 * is rejected (it would detach the branch), as is a no-op self drop.
 */
export function moveNode(
  nodes: TreeNode[],
  dragId: string,
  targetId: string | null,
  position: DropPosition,
): TreeNode[] {
  if (dragId === targetId) return nodes;

  const dragged = findNode(nodes, dragId);
  if (!dragged) return nodes;
  if (targetId !== null && containsNode(dragged, targetId)) return nodes;

  const pruned = removeNode(nodes, dragId);
  if (targetId === null) return [...pruned, dragged];
  if (position === "inside") return insertNode(pruned, targetId, dragged);
  return insertBeside(pruned, targetId, dragged, position);
}

/**
 * Drops ids that are already covered by another id in the set.
 *
 * Selecting a folder *and* something inside it is easy to do by accident. For
 * a move or a delete the folder alone is the whole instruction — acting on the
 * child too would move it out of the folder that is itself moving.
 */
export function topmost(nodes: TreeNode[], ids: Set<string>): string[] {
  const covered = new Set<string>();
  for (const id of ids) {
    const node = findNode(nodes, id);
    if (!node || !isFolder(node)) continue;
    for (const other of ids) {
      if (other !== id && containsNode(node, other)) covered.add(other);
    }
  }
  // Tree order, so a bulk move keeps the nodes in the order they were shown.
  return flatIds(nodes).filter((id) => ids.has(id) && !covered.has(id));
}

/** Every id in the tree, depth-first — the order the sidebar renders them. */
export function flatIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    isFolder(node) ? [node.id, ...flatIds(node.children)] : [node.id],
  );
}

export function removeNodes(nodes: TreeNode[], ids: string[]): TreeNode[] {
  return ids.reduce((tree, id) => removeNode(tree, id), nodes);
}

/**
 * Moves several nodes into `targetId` at once, keeping their relative order.
 *
 * A node that would move into itself is skipped rather than dropped, so a
 * selection spanning the destination folder still moves everything else.
 */
export function moveNodes(
  nodes: TreeNode[],
  ids: string[],
  targetId: string | null,
): TreeNode[] {
  let tree = nodes;
  for (const id of topmost(nodes, new Set(ids))) {
    if (id === targetId) continue;
    const node = findNode(tree, id);
    if (!node) continue;
    if (targetId !== null && containsNode(node, targetId)) continue;
    tree = insertNode(removeNode(tree, id), targetId, node);
  }
  return tree;
}

/** Every folder in the tree, with the path that leads to it. */
export function folderOptions(
  nodes: TreeNode[],
  trail: string[] = [],
): { id: string; label: string }[] {
  return nodes.flatMap((node) =>
    isFolder(node)
      ? [
          { id: node.id, label: [...trail, node.name].join(" / ") },
          ...folderOptions(node.children, [...trail, node.name]),
        ]
      : [],
  );
}

export function countRequests(nodes: TreeNode[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum + (isFolder(node) ? countRequests(node.children) : 1),
    0,
  );
}

/** The folder containing `id`, or `null` when it sits at the root. */
export function parentIdOf(nodes: TreeNode[], id: string): string | null {
  function walk(list: TreeNode[], parent: string | null): string | null | false {
    for (const node of list) {
      if (node.id === id) return parent;
      if (isFolder(node)) {
        const hit = walk(node.children, node.id);
        if (hit !== false) return hit;
      }
    }
    return false;
  }
  const found = walk(nodes, null);
  return found === false ? null : found;
}

/** Ids of every request inside `node`, itself included. */
export function requestIdsIn(node: TreeNode): string[] {
  if (!isFolder(node)) return [node.id];
  return node.children.flatMap(requestIdsIn);
}

/** Deep copy with fresh ids, so a duplicate never aliases the original. */
export function cloneNode(node: TreeNode): TreeNode {
  if (isFolder(node)) {
    return {
      ...node,
      id: newId(),
      children: node.children.map(cloneNode),
    };
  }
  return { ...node, id: newId(), headers: node.headers.map((h) => ({ ...h })) };
}

/** Keeps requests matching `query` by name/URL, plus the folders leading to them. */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return nodes;

  return nodes.flatMap<TreeNode>((node) => {
    if (isFolder(node)) {
      const children = filterTree(node.children, needle);
      const selfMatches = node.name.toLowerCase().includes(needle);
      if (children.length > 0) return [{ ...node, children }];
      return selfMatches ? [{ ...node, children: [] }] : [];
    }
    const haystack = `${node.name} ${node.url} ${node.method}`.toLowerCase();
    return haystack.includes(needle) ? [node] : [];
  });
}

/** Ids of every folder on the path to `id`, so the tree can reveal a node. */
export function ancestorFolderIds(nodes: TreeNode[], id: string): string[] {
  function walk(list: TreeNode[], trail: string[]): string[] | null {
    for (const node of list) {
      if (node.id === id) return trail;
      if (isFolder(node)) {
        const hit = walk(node.children, [...trail, node.id]);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(nodes, []) ?? [];
}
