// Workspace persistence. State lives in SQLite behind the Rust command layer;
// this module owns the per-workspace load cache and the keys the UI stores.

import { loadWorkspaceData } from "./api";
import type { WorkspaceData } from "../types";

/** Setting scope for values that are not tied to one workspace. */
export const GLOBAL_SCOPE = "global";

export const SETTINGS = {
  activeWorkspace: "activeWorkspaceId",
  activeEnvironment: "activeEnvironmentId",
  activeTab: "activeTabId",
  expandedFolders: "expandedFolders",
  theme: "theme",
  mockPort: "mockPort",
  loadTests: "loadTests",
  sidebarWidth: "sidebarWidth",
  sidebarCollapsed: "sidebarCollapsed",
} as const;

const pending = new Map<string, Promise<WorkspaceData>>();

/**
 * A workspace is read once and shared by every consumer, so the environments,
 * collection and tab providers do not race on separate loads. Switching
 * workspaces mounts fresh providers, which hit this cache under the new id.
 */
export function workspaceDataOnce(
  workspaceId: string,
): Promise<WorkspaceData> {
  const cached = pending.get(workspaceId);
  if (cached) return cached;

  const promise = loadWorkspaceData(workspaceId).catch((e) => {
    pending.delete(workspaceId);
    throw e;
  });
  pending.set(workspaceId, promise);
  return promise;
}

/** Forces the next load of `workspaceId` to hit the database again. */
export function invalidateWorkspace(workspaceId: string): void {
  pending.delete(workspaceId);
}

export function newId(): string {
  return crypto.randomUUID();
}
