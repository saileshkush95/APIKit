// Tree operations over the flat mock-route list.
//
// Routes and folders share one array whose order is meaningful: the mock server
// matches top to bottom, so every move has to keep a sensible depth-first
// order rather than just re-parenting a row in place.

import type { MockRoute } from "../../shared/types";

export interface TreeItem {
  route: MockRoute;
  depth: number;
}

/** Children of `parentId`, in stored order. */
export function childrenOf(
  routes: MockRoute[],
  parentId: string | null,
): MockRoute[] {
  return routes.filter((route) => (route.parentId ?? null) === parentId);
}

/**
 * Depth-first walk, skipping the contents of collapsed folders. This is what
 * the list renders, and (ignoring `collapsed`) the order routes match in.
 */
export function flatten(
  routes: MockRoute[],
  collapsed: Set<string> = new Set(),
  parentId: string | null = null,
  depth = 0,
): TreeItem[] {
  return childrenOf(routes, parentId).flatMap((route) => {
    const item: TreeItem = { route, depth };
    if (!route.isFolder || collapsed.has(route.id)) return [item];
    return [item, ...flatten(routes, collapsed, route.id, depth + 1)];
  });
}

/** Every descendant id of `id`, excluding itself. */
export function descendantIds(routes: MockRoute[], id: string): string[] {
  return childrenOf(routes, id).flatMap((child) => [
    child.id,
    ...descendantIds(routes, child.id),
  ]);
}

/** True when `ancestorId` is `id` or contains it, at any depth. */
export function isWithin(
  routes: MockRoute[],
  id: string,
  ancestorId: string,
): boolean {
  return id === ancestorId || descendantIds(routes, ancestorId).includes(id);
}

/** Ancestor folder ids of `id`, so a match deep in the tree can be revealed. */
export function ancestorsOf(routes: MockRoute[], id: string): string[] {
  const byId = new Map(routes.map((route) => [route.id, route]));
  const trail: string[] = [];
  let current = byId.get(id)?.parentId ?? null;
  while (current) {
    trail.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return trail;
}

/**
 * Rewrites the array so it reads in depth-first order. Storage order is what
 * the backend matches on, so this runs after every structural change.
 */
export function reorder(routes: MockRoute[]): MockRoute[] {
  const ordered = flatten(routes).map((item) => item.route);
  // Anything orphaned by a deleted parent would otherwise vanish from the
  // walk; keep it rather than silently dropping the user's data.
  const seen = new Set(ordered.map((route) => route.id));
  return [...ordered, ...routes.filter((route) => !seen.has(route.id))];
}

/**
 * Moves `ids` to a new parent, placed before `beforeId` (or last). Items being
 * moved into their own subtree are ignored, which would otherwise detach them.
 */
export function moveInto(
  routes: MockRoute[],
  ids: string[],
  parentId: string | null,
  beforeId: string | null,
): MockRoute[] {
  const moving = ids.filter(
    (id) => parentId === null || !isWithin(routes, parentId, id),
  );
  if (moving.length === 0) return routes;

  const movingSet = new Set(moving);
  const moved = routes
    .filter((route) => movingSet.has(route.id))
    .map((route) => ({ ...route, parentId }));
  const rest = routes.filter((route) => !movingSet.has(route.id));

  const at = beforeId
    ? rest.findIndex((route) => route.id === beforeId)
    : -1;
  const next =
    at === -1
      ? [...rest, ...moved]
      : [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  return reorder(next);
}

/** Removes ids together with everything inside them. */
export function removeWithChildren(
  routes: MockRoute[],
  ids: string[],
): MockRoute[] {
  const doomed = new Set(
    ids.flatMap((id) => [id, ...descendantIds(routes, id)]),
  );
  return routes.filter((route) => !doomed.has(route.id));
}

/** Matches a route or folder by name, path, method or status. */
export function matches(route: MockRoute, needle: string): boolean {
  if (needle === "") return true;
  const haystack = route.isFolder
    ? route.name
    : `${route.method} ${route.path} ${route.status}`;
  return haystack.toLowerCase().includes(needle);
}

/**
 * Ids to show for a search: every hit, plus the folders leading to it, so a
 * match nested three levels down is still reachable.
 */
export function searchVisible(
  routes: MockRoute[],
  needle: string,
): Set<string> | null {
  if (needle.trim() === "") return null;
  const query = needle.trim().toLowerCase();
  const keep = new Set<string>();
  for (const route of routes) {
    if (!matches(route, query)) continue;
    keep.add(route.id);
    for (const ancestor of ancestorsOf(routes, route.id)) keep.add(ancestor);
    // A folder that matches brings its contents along.
    if (route.isFolder) {
      for (const child of descendantIds(routes, route.id)) keep.add(child);
    }
  }
  return keep;
}
