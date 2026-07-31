// Documentation as a printable page, which is how a PDF is produced.
//
// Printing rather than generating a PDF directly: the webview already lays out,
// paginates and hyphenates, and every desktop print dialog offers "Save as
// PDF". A hand-rolled PDF writer would be a typesetter to maintain, and the
// result would be worse.
//
// Credentials are deliberately absent. A PDF is a file, and files get shared —
// so an auth block prints as the scheme it uses and never as the secret it
// holds, the same rule the workspace export follows.

import { escapeHtml, renderMarkdown } from "./markdown";
import { activeRows } from "./rows";
import { isFolder } from "./tree";
import type {
  Auth,
  Folder,
  KeyValue,
  NodeDefaults,
  SavedRequest,
  TreeNode,
} from "../types";

export type DocsScope =
  | { kind: "request"; request: SavedRequest }
  | { kind: "folder"; folder: Folder }
  | { kind: "collection"; name: string; defaults: NodeDefaults; tree: TreeNode[] };

/** The scheme in play, never the credential itself. */
function describeAuth(auth: Auth | undefined): string | null {
  switch (auth?.type) {
    case "bearer":
      return "Bearer token";
    case "basic":
      return `Basic, user ${auth.username || "—"}`;
    case "apiKey":
      return `API key ${escapeHtml(auth.key || "—")} in the ${auth.addTo === "query" ? "query string" : "headers"}`;
    case "oauth2":
      return `OAuth 2.0 (${auth.oauth2.grant})`;
    case "inherit":
      return "Inherited from the parent";
    default:
      return null;
  }
}

function table(rows: KeyValue[]): string {
  const live = activeRows(rows);
  if (live.length === 0) return "";
  const body = live
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(row.name)}</code></td><td><code>${escapeHtml(row.value)}</code></td><td>${escapeHtml(row.description ?? "")}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Name</th><th>Value</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table>`;
}

function section(title: string, inner: string): string {
  return inner === "" ? "" : `<h4>${escapeHtml(title)}</h4>${inner}`;
}

function requestBlock(request: SavedRequest, depth: number): string {
  const level = Math.min(6, depth + 1);
  const config = request.config;
  const auth = describeAuth(config.auth);
  const body =
    config.bodyMode === "none" || request.body.trim() === ""
      ? ""
      : `<pre><code>${escapeHtml(request.body)}</code></pre>`;
  const tests = (request.tests ?? []).length
    ? `<ul>${request.tests
        .map(
          (test) =>
            `<li>${escapeHtml(test.source)} ${escapeHtml(test.target)} ${escapeHtml(test.op)} <code>${escapeHtml(test.expected)}</code></li>`,
        )
        .join("")}</ul>`
    : "";

  return `
<section class="request">
  <h${level}>${escapeHtml(request.name)}</h${level}>
  <p class="endpoint"><span class="method">${escapeHtml(request.method.toUpperCase())}</span> <code>${escapeHtml(request.url)}</code></p>
  ${config.docs.trim() ? `<div class="prose">${renderMarkdown(config.docs)}</div>` : '<p class="empty">No documentation yet.</p>'}
  ${section("Headers", table(request.headers))}
  ${auth ? `${section("Authorization", `<p>${auth}</p>`)}` : ""}
  ${section("Body", body)}
  ${section("Tests", tests)}
</section>`;
}

function treeBlock(nodes: TreeNode[], depth: number): string {
  return nodes
    .map((node) =>
      isFolder(node) ? folderBlock(node, depth) : requestBlock(node, depth),
    )
    .join("");
}

function folderBlock(folder: Folder, depth: number): string {
  const level = Math.min(6, depth + 1);
  return `
<section class="folder">
  <h${level}>${escapeHtml(folder.name)}</h${level}>
  ${folder.docs?.trim() ? `<div class="prose">${renderMarkdown(folder.docs)}</div>` : ""}
  ${section("Shared headers", table(folder.headers ?? []))}
  ${treeBlock(folder.children, depth + 1)}
</section>`;
}

/** Counts what the document covers, for the line under the title. */
function countRequests(nodes: TreeNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total + (isFolder(node) ? countRequests(node.children) : 1),
    0,
  );
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .doc {
    max-width: 46rem;
    margin: 0 auto;
    padding: 1.5rem;
    color: #16181d;
    background: #fff;
    font: 12px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .doc h1 { font-size: 1.9em; margin: 0 0 0.2em; }
  .doc h2 { font-size: 1.45em; margin: 1.6em 0 0.4em; }
  .doc h3 { font-size: 1.2em; margin: 1.4em 0 0.4em; }
  .doc h4 { font-size: 1em; margin: 1.1em 0 0.3em; color: #555b66; }
  .doc h5, .doc h6 { font-size: 0.95em; margin: 1em 0 0.3em; }
  .doc .subtitle { margin: 0 0 1.5em; color: #6b7280; }
  .doc code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; }
  .doc pre {
    padding: 0.6em 0.8em;
    overflow-x: auto;
    border: 1px solid #e3e5e9;
    border-radius: 4px;
    background: #f7f8fa;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .doc table { width: 100%; border-collapse: collapse; margin: 0.4em 0 0.8em; }
  .doc th, .doc td {
    padding: 0.32em 0.5em;
    border: 1px solid #e3e5e9;
    text-align: left;
    vertical-align: top;
    word-break: break-word;
  }
  .doc th { background: #f7f8fa; font-weight: 600; }
  .doc .request, .doc .folder { break-inside: auto; }
  .doc .request { margin: 1.2em 0; padding-top: 0.4em; border-top: 1px solid #eceef2; }
  .doc .endpoint { margin: 0.2em 0 0.6em; }
  .doc .method {
    display: inline-block;
    padding: 0.1em 0.45em;
    border-radius: 3px;
    background: #16181d;
    color: #fff;
    font: 600 0.85em/1.5 ui-monospace, Menlo, monospace;
  }
  .doc .empty { color: #9aa1ad; font-style: italic; }
  /* A doc that opens with its own title must not outrank the heading naming the
     request it belongs to, so prose headings are scaled to sit underneath. */
  .doc .prose h2 { font-size: 1.08em; margin: 1em 0 0.3em; }
  .doc .prose h3 { font-size: 1em; margin: 0.9em 0 0.25em; }
  .doc .prose h4, .doc .prose h5 { font-size: 0.95em; margin: 0.8em 0 0.25em; color: #16181d; }
  .doc blockquote {
    margin: 0.5em 0;
    padding-left: 0.8em;
    border-left: 3px solid #e3e5e9;
    color: #555b66;
  }
  .doc ul, .doc ol { padding-left: 1.3em; }
  .doc img { max-width: 100%; height: auto; border-radius: 3px; }
  .doc mark { padding: 0 0.15em; border-radius: 2px; background: #fdf0c8; color: inherit; }
  .doc .prose table { table-layout: fixed; }
  /* A heading alone at the foot of a page reads as a mistake. */
  .doc h1, .doc h2, .doc h3, .doc h4 { break-after: avoid; }
  .doc table, .doc pre { break-inside: avoid; }
  @page { margin: 16mm; }
`;

/** The document body — exported so it can be checked without a printer. */
export function buildDocsHtml(scope: DocsScope, generatedAt: string): string {
  let title: string;
  let subtitle: string;
  let content: string;

  if (scope.kind === "request") {
    title = scope.request.name;
    subtitle = `${scope.request.method.toUpperCase()} ${scope.request.url}`;
    content = requestBlock(scope.request, 1);
  } else if (scope.kind === "folder") {
    const total = countRequests(scope.folder.children);
    title = scope.folder.name;
    subtitle = `${total} request${total === 1 ? "" : "s"}`;
    content = `${
      scope.folder.docs?.trim() ? `<div class="prose">${renderMarkdown(scope.folder.docs)}</div>` : ""
    }${section("Shared headers", table(scope.folder.headers ?? []))}${treeBlock(
      scope.folder.children,
      1,
    )}`;
  } else {
    const total = countRequests(scope.tree);
    title = scope.name;
    subtitle = `${total} request${total === 1 ? "" : "s"}`;
    content = `${
      scope.defaults.docs?.trim() ? `<div class="prose">${renderMarkdown(scope.defaults.docs)}</div>` : ""
    }${section("Shared headers", table(scope.defaults.headers ?? []))}${treeBlock(
      scope.tree,
      1,
    )}`;
  }

  return `<div class="doc">
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)} · ${escapeHtml(generatedAt)}</p>
  ${content}
</div>`;
}

const ROOT_ID = "wrk-print-root";

/**
 * Prints the document, which is where the PDF comes from.
 *
 * The page is mounted into this document and everything else hidden for print,
 * rather than opened in a second window: a Tauri webview blocks `window.open`,
 * and printing an iframe prints whichever document the platform feels like.
 */
export function printDocs(scope: DocsScope, now = new Date()): void {
  document.getElementById(ROOT_ID)?.remove();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `<style>
    #${ROOT_ID} { display: none; }
    @media print {
      body > *:not(#${ROOT_ID}) { display: none !important; }
      #${ROOT_ID} { display: block; }
      ${STYLE}
    }
  </style>${buildDocsHtml(scope, now.toLocaleString())}`;
  document.body.append(root);

  const clean = () => {
    root.remove();
    window.removeEventListener("afterprint", clean);
  };
  window.addEventListener("afterprint", clean);
  // Safari fires `afterprint` reliably, WebKitGTK less so; the timer is the
  // backstop that keeps a stale copy out of the DOM either way.
  setTimeout(clean, 60_000);

  window.print();
}
