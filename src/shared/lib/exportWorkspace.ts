// Export / import of a whole workspace as one JSON document.
//
// The same document is what GitHub sync commits, so a repo checkout is a
// readable, diffable copy of the collection.

import { newId } from "./storage";
import { isFolder } from "./tree";
import {
  normalizeConfig,
  type Auth,
  type Environment,
  type MockRoute,
  type NodeDefaults,
  type Monitor,
  type Variable,
  type RequestDraft,
  type TreeNode,
  type WorkspaceExport,
} from "../types";

export interface ExportInput {
  workspace: string;
  tree: TreeNode[];
  environments: Environment[];
  collectionVariables?: Variable[];
  collectionDefaults?: NodeDefaults;
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

/**
 * A value that is nothing but a `{{variable}}` reference points at a credential
 * rather than being one, so it survives the redaction — and keeping it is what
 * makes the reference worth using in the first place. Anything else typed into
 * a credential field is the credential itself.
 */
function isVariableReference(value: string): boolean {
  return /^\s*\{\{\s*[\w.\-$]+\s*\}\}\s*$/.test(value);
}

function redact(value: string): string {
  return value === "" || isVariableReference(value) ? value : "";
}

/**
 * Strips the credentials out of an auth block, keeping everything that merely
 * describes the scheme: usernames, header and key names, client ids, endpoints,
 * scopes. Those are configuration; the rest is not.
 */
function redactAuth(auth: Auth | undefined): Auth | undefined {
  if (!auth) return auth;
  return {
    ...auth,
    token: redact(auth.token),
    password: redact(auth.password),
    // The API key's name is configuration; its value is the key.
    value: redact(auth.value),
    oauth2: auth.oauth2
      ? {
          ...auth.oauth2,
          clientSecret: redact(auth.oauth2.clientSecret),
          password: redact(auth.oauth2.password),
        }
      : auth.oauth2,
  };
}

/**
 * The same redaction over a whole tree.
 *
 * Environment secrets were already dropped, but a password typed straight into
 * a request's auth tab was not, and this document is both what the user writes
 * to a file and what GitHub sync commits to a repository. Access and refresh
 * tokens are not handled here because they were never in the tree — they live
 * in the OS keychain (see `shared/lib/oauth.ts`).
 */
function withoutCredentials(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (isFolder(node)) {
      return {
        ...node,
        auth: redactAuth(node.auth),
        children: withoutCredentials(node.children),
      };
    }
    return {
      ...node,
      config: {
        ...node.config,
        auth: redactAuth(node.config.auth) ?? node.config.auth,
        mqttPassword: redact(node.config.mqttPassword ?? ""),
      },
    };
  });
}

export function buildExport(input: ExportInput): WorkspaceExport {
  return {
    format: "webrequestkit",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: input.workspace,
    tree: withoutCredentials(input.tree),
    environments: withoutSecrets(input.environments),
    // Same rule as an environment's: a secret's name travels so a teammate
    // knows what to fill in, its value does not.
    collectionVariables: (input.collectionVariables ?? []).map((variable) =>
      variable.secret ? { ...variable, value: "" } : variable,
    ),
    // Headers and scripts are not redacted, for the same reason a request's own
    // are not: they are part of what the collection *is*, and blanking them
    // would export something that cannot be run. Auth is, exactly as it is on a
    // folder — credentials belong in a variable the field refers to.
    collectionDefaults: input.collectionDefaults && {
      ...input.collectionDefaults,
      auth: redactAuth(input.collectionDefaults.auth),
    },
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
