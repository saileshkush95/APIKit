// Export / import of a whole workspace as one JSON document.
//
// The same document is what GitHub sync commits, so a repo checkout is a
// readable, diffable copy of the collection.

import { newId } from "./storage";
import { isFolder } from "./tree";
import {
  normalizeConfig,
  type Environment,
  type MockRoute,
  type Monitor,
  type RequestDraft,
  type TreeNode,
  type WorkspaceExport,
} from "../types";

export interface ExportInput {
  workspace: string;
  tree: TreeNode[];
  environments: Environment[];
  monitors?: Monitor[];
  mockRoutes?: MockRoute[];
}

/** Secret values are dropped: an export is a file, and files get shared. */
function withoutSecrets(environments: Environment[]): Environment[] {
  return environments.map((environment) => ({
    ...environment,
    variables: environment.variables.map((variable) =>
      variable.secret ? { ...variable, value: "" } : variable,
    ),
  }));
}

export function buildExport(input: ExportInput): WorkspaceExport {
  return {
    format: "webrequestkit",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: input.workspace,
    tree: input.tree,
    environments: withoutSecrets(input.environments),
    monitors: input.monitors,
    mockRoutes: input.mockRoutes,
  };
}

/** Stable, pretty JSON so GitHub diffs stay readable between commits. */
export function serializeExport(document: WorkspaceExport): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseExport(text: string): WorkspaceExport {
  const parsed = JSON.parse(text) as WorkspaceExport;
  if (parsed?.format !== "webrequestkit" || !Array.isArray(parsed.tree)) {
    throw new Error("not a WebRequestKit export");
  }
  return parsed;
}

/** Fills in fields added since the document was written. */
export function hydrateTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) =>
    isFolder(node)
      ? { ...node, children: hydrateTree(node.children) }
      : { ...node, tests: node.tests ?? [], config: normalizeConfig(node.config) },
  );
}

/** Re-ids an imported tree, so importing into the same workspace duplicates
 *  rather than overwriting what is already there. */
export function reidTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) =>
    isFolder(node)
      ? { ...node, id: newId(), children: reidTree(node.children) }
      : { ...node, id: newId() },
  );
}

/** Fills in anything a stored draft predates. */
export function normalizeDraft(draft: RequestDraft): RequestDraft {
  return {
    method: draft.method || "GET",
    url: draft.url ?? "",
    headers: draft.headers ?? [],
    body: draft.body ?? "",
    tests: draft.tests ?? [],
    config: normalizeConfig(draft.config),
  };
}

export function suggestFilename(workspace: string): string {
  const slug = workspace
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "workspace"}.webrequestkit.json`;
}
