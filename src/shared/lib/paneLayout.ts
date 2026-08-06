// How a request's two panes are arranged. The choice belongs to the request —
// see `RequestTab.layout` — and this module only holds the default a newly
// opened tab starts from, which is the last arrangement chosen anywhere.

import type { PaneLayout } from "../types";

const LAYOUT_KEY = "clientLayout";

/**
 * A stored arrangement, including the older `horizontal`/`vertical` pair that
 * predates the response having a side to sit on.
 */
export function normalizeLayout(value: string | null | undefined): PaneLayout {
  if (value === "left" || value === "right") return value;
  if (value === "horizontal") return "right";
  return "stacked";
}

/** What a tab opened now is arranged as. */
export function defaultLayout(): PaneLayout {
  return normalizeLayout(localStorage.getItem(LAYOUT_KEY));
}

/**
 * Remember an arrangement for tabs opened later. Only the default moves: tabs
 * already open carry their own, so choosing one here never rearranges a
 * request you are not looking at.
 */
export function rememberLayout(layout: PaneLayout): void {
  localStorage.setItem(LAYOUT_KEY, layout);
}
