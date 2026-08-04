// The collection as an interactive, self-contained HTML page.
//
// The printable document in docsPrint.ts lays everything out up front, which is
// exactly what a printer wants — but an exported page a developer opens in a
// browser is better as a viewer: a sidebar that mirrors the collection tree, a
// search box over it, one request at a time in the main pane, tabs for the
// request's parts, an environment selector that rewrites `{{variables}}`, ready
// generated code in twelve languages, a Send button that runs the request from
// the browser, syntax highlighting, copy buttons, a light/dark toggle and an
// Export PDF action that prints a document of the whole collection. Everything
// ships inside the one file, so it works from a disk, a `file://` open or a
// dropped copy in a chat with no server and no CDN.
//
// The tree is embedded as JSON in a <script> tag; a small vanilla renderer
// builds the UI from it. Markdown is rendered at build time (reusing the same
// escape-first renderer the app uses), and credentials never leave this
// machine: auth is described by scheme only, secret environment variables are
// blanked, and a credential typed literally into an auth field is dropped — the
// same rule every export follows.

import { escapeHtml, renderMarkdown } from "./markdown";
import { activeRows } from "./rows";
import { isFolder } from "./tree";
import { describeAuth } from "./docsPrint";
import { buildWireRequest } from "./request";
import { resolveInherited } from "./inherit";
import { CODE_LANGUAGE, CODE_TARGETS, generateCode } from "./codegen";
import { parseQuery } from "./query";
import { defaultAuth, PROTOCOL_LABELS } from "../types";
import type {
  Assertion,
  Auth,
  Environment,
  KeyValue,
  NodeDefaults,
  SavedRequest,
  TreeNode,
  Variable,
} from "../types";
import type { DocsScope } from "./docsPrint";

// --- View-model --------------------------------------------------------------
//
// A trimmed-down shape of the tree, with everything the viewer needs and
// nothing it can't render. Auth arrives as a description plus the redacted
// pieces the viewer needs to rebuild the header when the request is sent.

export interface ViewerOptions {
  environments?: Environment[];
  collectionVariables?: Variable[];
  /** The environment selected in the app, preselected in the exported page. */
  activeEnvironmentId?: string | null;
}

interface ViewerRow {
  name: string;
  value: string;
  description?: string;
  enabled?: boolean;
  secret?: boolean;
}

interface ViewerBody {
  mode: string;
  raw?: { language: string; text: string } | null;
  urlEncoded?: ViewerRow[];
  formData?: ViewerRow[];
  graphql?: { query: string; variables: string } | null;
  binary?: string | null;
}

interface ViewerAssertion {
  source: string;
  target: string;
  op: string;
  expected: string;
}

interface ViewerAuth {
  type: string;
  label: string | null;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  addTo: "header" | "query";
}

interface ViewerCodeSnippet {
  target: string;
  label: string;
  language: string;
  code: string;
}

interface ViewerWire {
  method: string;
  url: string;
  headers: ViewerRow[];
  /** The body string for raw / url-encoded / GraphQL bodies, or null. */
  body: string | null;
  bodyMode: string;
  /** Text-only form rows, for the viewer to rebuild a FormData body. */
  formData: ViewerRow[];
  sendable: boolean;
  note: string;
}

interface ViewerRequestData {
  kind: "request";
  name: string;
  method: string;
  url: string;
  protocol: string;
  /** Markdown already rendered to HTML by the escape-first renderer. */
  docs: string;
  query: ViewerRow[];
  headers: ViewerRow[];
  auth: ViewerAuth | null;
  body: ViewerBody | null;
  tests: ViewerAssertion[];
  preScript: string;
  postScript: string;
  settings: { label: string; value: string }[];
  /** How the request looks over the wire, with `{{variables}}` intact. */
  wire: ViewerWire;
  code: ViewerCodeSnippet[];
}

interface ViewerFolderData {
  kind: "folder";
  name: string;
  docs: string;
  headers: ViewerRow[];
  auth: string | null;
  children: ViewerNodeData[];
}

type ViewerNodeData = ViewerRequestData | ViewerFolderData;

interface ViewerEnv {
  id: string;
  name: string;
  variables: ViewerRow[];
}

interface ViewerData {
  title: string;
  subtitle: string;
  notes: string;
  sharedHeaders: ViewerRow[];
  tree: ViewerNodeData[];
  environments: ViewerEnv[];
  collectionVariables: ViewerRow[];
  initialEnv: string | null;
  hasSecrets: boolean;
}

function rowsFor(headers: KeyValue[] | undefined): ViewerRow[] {
  return activeRows(headers ?? []).map((row) => ({
    name: row.name,
    value: row.value,
    ...(row.description ? { description: row.description } : {}),
  }));
}

function variableRows(variables: Variable[]): ViewerRow[] {
  return variables.map((variable) => ({
    name: variable.name,
    value: variable.secret ? "" : variable.value,
    ...(variable.secret ? { secret: true } : {}),
    ...(variable.enabled === false ? { enabled: false } : {}),
  }));
}

function viewerTests(tests: Assertion[] | undefined): ViewerAssertion[] {
  return (tests ?? []).map((test) => ({
    source: test.source,
    target: test.target,
    op: test.op,
    expected: test.expected,
  }));
}

function viewerBody(request: SavedRequest): ViewerBody | null {
  const config = request.config;
  switch (config.bodyMode) {
    case "raw":
      return request.body.trim() === ""
        ? null
        : {
            mode: "raw",
            raw: { language: config.rawLanguage, text: request.body },
          };
    case "urlEncoded":
      return { mode: "urlEncoded", urlEncoded: rowsFor(config.urlEncoded) };
    case "formData":
      return { mode: "formData", formData: rowsFor(config.formData) };
    case "graphql":
      return config.graphqlQuery.trim() === ""
        ? null
        : {
            mode: "graphql",
            graphql: {
              query: config.graphqlQuery,
              variables: config.graphqlVariables,
            },
          };
    case "binary":
      return {
        mode: "binary",
        binary: config.binaryFilePath || "A file is sent as the body.",
      };
    default:
      return null;
  }
}

function viewerSettings(request: SavedRequest): { label: string; value: string }[] {
  const config = request.config;
  const out: { label: string; value: string }[] = [];
  if (config.protocol !== "rest") {
    out.push({ label: "Protocol", value: PROTOCOL_LABELS[config.protocol] });
  }
  if (config.httpVersion !== "auto") {
    out.push({ label: "HTTP version", value: config.httpVersion.toUpperCase() });
  }
  if (config.timeoutMs != null) {
    out.push({ label: "Timeout", value: `${config.timeoutMs} ms` });
  }
  if (config.followRedirects != null) {
    out.push({
      label: "Follow redirects",
      value: config.followRedirects ? "Yes" : "No",
    });
  }
  if (config.verifyTls != null) {
    out.push({ label: "Verify TLS", value: config.verifyTls ? "Yes" : "No" });
  }
  if (config.maxRedirects != null) {
    out.push({ label: "Max redirects", value: String(config.maxRedirects) });
  }
  return out;
}

// --- Redaction ---------------------------------------------------------------
//
// The same rule the workspace export follows: a value that is nothing but a
// `{{variable}}` reference points at a credential rather than being one, so it
// survives — keeping it is what makes the reference worth using. Anything else
// typed into a credential field is the credential itself and is dropped.

function redact(value: string): string {
  return value === "" || /^\s*\{\{\s*[\w.\-$]+\s*\}\}\s*$/.test(value)
    ? value
    : "";
}

function redactAuth(auth: Auth | undefined): Auth | undefined {
  if (!auth) return auth;
  return {
    ...auth,
    token: redact(auth.token),
    password: redact(auth.password),
    value: redact(auth.value),
  };
}

function viewerAuth(auth: Auth | undefined): ViewerAuth | null {
  const redacted = redactAuth(auth);
  if (!redacted || redacted.type === "none") return null;
  return {
    type: redacted.type,
    label: describeAuth(redacted),
    token: redacted.token,
    username: redacted.username,
    password: redacted.password,
    key: redacted.key,
    value: redacted.value,
    addTo: redacted.addTo,
  };
}

// --- Wire requests -----------------------------------------------------------

/** The effective headers, body and auth of a request, with vars left intact. */
function requestWire(
  request: SavedRequest,
  resolved: ReturnType<typeof resolveInherited>,
): ViewerWire {
  const mode = request.config.bodyMode;
  const noAuth = {
    ...resolved.config,
    auth: { ...defaultAuth(), type: "none" as const },
  };
  const built = buildWireRequest(
    {
      method: request.method,
      url: request.url,
      headers: resolved.headers,
      body: request.body,
      tests: request.tests,
      config: noAuth,
    },
    {},
  );

  const formRows = activeRows(request.config.formData ?? []);
  const formHasFiles = formRows.some((row) => row.kind === "file");
  const isRest = request.config.protocol === "rest";

  const body =
    built.body !== "" && !built.multipart && !built.bodyFilePath
      ? built.body
      : null;

  let sendable = isRest && !built.multipart && !built.bodyFilePath && !formHasFiles;
  let note = "";
  if (!isRest) {
    sendable = false;
    note = "Send is available for REST requests.";
  } else if (mode === "binary" || built.bodyFilePath) {
    note = "A local file body cannot be sent from the exported page.";
  } else if (built.multipart) {
    note = "File uploads cannot be sent from the exported page.";
  }

  return {
    method: request.method.toUpperCase(),
    url: built.url,
    headers: rowsFor(built.headers),
    body,
    bodyMode: mode,
    formData: rowsFor(request.config.formData ?? []),
    sendable,
    note,
  };
}

function codeSnippets(
  request: SavedRequest,
  resolved: ReturnType<typeof resolveInherited>,
): ViewerCodeSnippet[] {
  if (request.config.protocol !== "rest" && request.config.protocol !== "graphql") {
    return [];
  }
  const codeRequest = buildWireRequest(
    {
      method: request.method,
      url: request.url,
      headers: resolved.headers,
      body: request.body,
      tests: request.tests,
      config: { ...resolved.config, auth: redactAuth(resolved.config.auth) ?? defaultAuth() },
    },
    {},
  );
  return CODE_TARGETS.map((target) => ({
    target: target.value,
    label: target.label,
    language: CODE_LANGUAGE[target.value],
    code: generateCode(codeRequest, target.value),
  }));
}

function nodeToViewer(
  node: TreeNode,
  defaults: NodeDefaults,
  tree: TreeNode[],
): ViewerNodeData {
  if (isFolder(node)) {
    return {
      kind: "folder",
      name: node.name,
      docs: node.docs?.trim() ? renderMarkdown(node.docs) : "",
      headers: rowsFor(node.headers ?? []),
      auth: describeAuth(node.auth),
      children: node.children.map((child) => nodeToViewer(child, defaults, tree)),
    };
  }
  const resolved = resolveInherited(tree, node.id, defaults, {
    headers: node.headers,
    config: node.config,
  });
  return {
    kind: "request",
    name: node.name,
    method: node.method.toUpperCase(),
    url: node.url,
    protocol: node.config.protocol,
    docs: node.config.docs?.trim() ? renderMarkdown(node.config.docs) : "",
    query: rowsFor(parseQuery(node.url)),
    headers: rowsFor(node.headers),
    auth: viewerAuth(resolved.config.auth),
    body: viewerBody(node),
    tests: viewerTests(node.tests),
    preScript: node.config.preScript ?? "",
    postScript: node.config.postScript ?? "",
    settings: viewerSettings(node),
    wire: requestWire(node, resolved),
    code: codeSnippets(node, resolved),
  };
}

function countRequests(nodes: TreeNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total + (isFolder(node) ? countRequests(node.children) : 1),
    0,
  );
}

function buildViewerData(
  scope: DocsScope,
  options: ViewerOptions,
  generatedAt: string,
): ViewerData {
  const defaults: NodeDefaults =
    scope.kind === "request"
      ? {}
      : scope.kind === "folder"
        ? scope.folder
        : scope.defaults;
  const tree: TreeNode[] =
    scope.kind === "folder"
      ? scope.folder.children
      : scope.kind === "collection"
        ? scope.tree
        : [];
  const total = countRequests(
    scope.kind === "request" ? [] : tree,
  );

  const title =
    scope.kind === "request"
      ? scope.request.name
      : scope.kind === "folder"
        ? scope.folder.name
        : scope.name;
  const subtitle =
    scope.kind === "request"
      ? `${scope.request.method.toUpperCase()} ${scope.request.url}`
      : `${total} request${total === 1 ? "" : "s"} · generated ${generatedAt}`;
  const notes = defaults.docs?.trim() ? renderMarkdown(defaults.docs) : "";

  const nodes: ViewerNodeData[] =
    scope.kind === "request"
      ? [nodeToViewer(scope.request, defaults, tree)]
      : tree.map((node) => nodeToViewer(node, defaults, tree));

  const environments: ViewerEnv[] = (options.environments ?? []).map((env) => ({
    id: env.id,
    name: env.name,
    variables: variableRows(env.variables),
  }));
  const collectionVariables = variableRows(options.collectionVariables ?? []);
  const hasSecrets =
    (options.environments ?? []).some((env) =>
      env.variables.some((variable) => variable.secret),
    ) || (options.collectionVariables ?? []).some((variable) => variable.secret);

  return {
    title,
    subtitle,
    notes,
    sharedHeaders: rowsFor(defaults.headers ?? []),
    tree: nodes,
    environments,
    collectionVariables,
    initialEnv: options.activeEnvironmentId ?? null,
    hasSecrets,
  };
}

// --- The page ----------------------------------------------------------------

// The shell. The CSS and the renderer are interpolated in below; the data rides
// in its own <script> tag so a browser never has to see it inside a string.

const SHELL = (css: string, js: string, data: ViewerData) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} — APIKit</title>
<style>${css}</style>
</head>
<body>
<header class="wrk-topbar">
  <div class="wrk-topbar-title">
    <strong>${escapeHtml(data.title)}</strong>
    <span class="wrk-topbar-sub">${escapeHtml(data.subtitle)}</span>
  </div>
  <div class="wrk-topbar-actions">
    <select id="wrk-env" class="wrk-env" aria-label="Environment"></select>
    <button id="wrk-print" class="wrk-theme-btn" type="button" title="Export as PDF" aria-label="Export as PDF"></button>
    <button id="wrk-theme" class="wrk-theme-btn" type="button" aria-pressed="false" title="Toggle light / dark"></button>
  </div>
</header>
<div class="wrk-layout">
  <aside class="wrk-side">
    <div class="wrk-search">
      <input id="wrk-search" type="search" placeholder="Filter requests…" aria-label="Filter requests">
    </div>
    <nav id="wrk-sidebar" class="wrk-tree" aria-label="Requests"></nav>
  </aside>
  <main id="wrk-main" class="wrk-main" tabindex="-1"></main>
</div>
<script type="application/json" id="wrk-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
${js}
</script>
</body>
</html>`;

// The renderer is written so it contains neither a backtick nor a ${ sequence —
// both would collide with the template literal it ships inside. It targets the
// same browsers as the app's webview: modern, but not bleeding edge.

const RENDERER = `(function () {
  'use strict';

  var data = null;
  try {
    data = JSON.parse(document.getElementById('wrk-data').textContent);
  } catch (err) { /* the page falls back to a blank body */ }
  if (!data) return;

  var sidebar = document.getElementById('wrk-sidebar');
  var main = document.getElementById('wrk-main');
  var searchInput = document.getElementById('wrk-search');
  var themeBtn = document.getElementById('wrk-theme');
  var printBtn = document.getElementById('wrk-print');
  var envSelect = document.getElementById('wrk-env');
  var copies = [];
  var expanded = {};
  var selected = null;
  var tab = 'docs';
  var envId = null;
  var codeLangs = {};
  var responses = {};

  var THEME_KEY = 'wrk-theme';
  var ENV_KEY = 'wrk-env';

  var TABS = ['docs', 'query', 'headers', 'auth', 'body', 'scripts', 'tests', 'code', 'response'];
  var TAB_LABELS = {
    docs: 'Description', query: 'Query', headers: 'Headers', auth: 'Auth',
    body: 'Body', scripts: 'Scripts', tests: 'Tests', code: 'Code', response: 'Response'
  };
  var MASKED = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022';

  var ICONS = {
    chevron: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5l5 4.5-5 4.5"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z"/></svg>',
    collection: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 2h8v12H4z"/><path d="M6.5 5.5h3M6.5 8h3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M11 5.5V4a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M5 3.5l6.5 4.5L5 12.5z"/></svg>',
    print: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4.5 5.5V2.5h7v3"/><rect x="2.5" y="5.5" width="11" height="6" rx="1"/><path d="M4.5 9.5h7v4h-7z"/></svg>',
    sun: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.2 3.2l1 1M11.8 11.8l1 1M12.8 3.2l-1 1M4.2 11.8l-1 1"/></svg>',
    moon: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7z"/></svg>'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Theme -----------------------------------------------------------------

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeBtn.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
    themeBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }

  function initTheme() {
    var saved = null;
    var prefersDark = false;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) {}
    try { prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (err) {}
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem(THEME_KEY, currentTheme()); } catch (err) {}
  }

  // --- Variables -------------------------------------------------------------

  var VAR_RE = /\\{\\{\\s*([\\w.\\-$]+)\\s*\\}\\}/g;

  function findEnv(id) {
    if (!id || !data.environments) return null;
    for (var i = 0; i < data.environments.length; i++) {
      if (data.environments[i].id === id) return data.environments[i];
    }
    return null;
  }

  function varMapFor() {
    var map = {};
    function add(rows) {
      if (!rows) return;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !r.name || r.enabled === false) continue;
        map[r.name.trim()] = r.value;
      }
    }
    add(data.collectionVariables);
    var env = findEnv(envId);
    add(env ? env.variables : null);
    return map;
  }

  /** Replaces every \`{{name}}\` that resolves; unknown names are left as-is. */
  function sub(s, map) {
    return String(s == null ? '' : s).replace(VAR_RE, function (match, name) {
      return (name in map) ? map[name] : match;
    });
  }

  function subRows(rows, map) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({
        name: sub(rows[i].name, map),
        value: sub(rows[i].value, map),
        description: rows[i].description
      });
    }
    return out;
  }

  function initEnv() {
    printBtn.innerHTML = ICONS.print;
    if (!data.environments || data.environments.length === 0) {
      envSelect.style.display = 'none';
      return;
    }
    var saved = null;
    try { saved = localStorage.getItem(ENV_KEY); } catch (err) {}
    envId = null;
    for (var i = 0; i < data.environments.length; i++) {
      var option = document.createElement('option');
      option.value = data.environments[i].id;
      option.textContent = data.environments[i].name;
      envSelect.appendChild(option);
    }
    if (saved && findEnv(saved)) envId = saved;
    else if (data.initialEnv && findEnv(data.initialEnv)) envId = data.initialEnv;
    envSelect.value = envId || '';
    envSelect.addEventListener('change', function () {
      envId = envSelect.value || null;
      try { localStorage.setItem(ENV_KEY, envId || ''); } catch (err) {}
      renderMain(currentNode());
    });
  }

  // --- Syntax highlighting ---------------------------------------------------
  //
  // A tiny tokenizer per language. Each alternative is a capture group whose
  // class lives at the same index in 'cls', so the group that matched decides
  // the colour. Whatever is not a token is escaped and passed through.

  var PATTERNS = {
    json: {
      re: /("(?:\\\\.|[^"\\\\])*")(?=\\s*:)|("(?:\\\\.|[^"\\\\])*")|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)|\\b(true|false|null)\\b/g,
      cls: ['t-k', 't-s', 't-n', 't-l']
    },
    js: {
      re: /(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(\\b(?:function|const|let|var|if|else|return|for|while|new|typeof|instanceof|async|await|import|export|from|class|extends|try|catch|finally|throw|switch|case|break|continue|this|true|false|null|undefined)\\b)|(-?\\b\\d+(?:\\.\\d+)?\\b)/g,
      cls: ['t-c', 't-s', 't-kw', 't-n']
    },
    xml: {
      re: /(<!--[\\s\\S]*?-->)|(<\\/?[a-zA-Z][\\w.:-]*)|(\\s[a-zA-Z_][\\w.:-]*)(?==)|("[^"]*")/g,
      cls: ['t-c', 't-tag', 't-attr', 't-str']
    },
    shell: {
      re: /(#[^\\n]*)|('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")/g,
      cls: ['t-c', 't-s']
    }
  };

  function patternFor(lang) {
    if (lang === 'js' || lang === 'javascript' || lang === 'graphql') return PATTERNS.js;
    if (lang === 'xml' || lang === 'html') return PATTERNS.xml;
    if (lang === 'shell' || lang === 'bash' || lang === 'sh' || lang === 'curl') return PATTERNS.shell;
    return PATTERNS.json;
  }

  function highlight(src, lang) {
    var p = patternFor(lang);
    var re = p.re;
    var out = '';
    var last = 0;
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          out += '<span class="' + p.cls[i - 1] + '">' + esc(m[i]) + '</span>';
          break;
        }
      }
      last = m.index + m[0].length;
      if (m[0] === '') re.lastIndex += 1;
    }
    out += esc(src.slice(last));
    return out;
  }

  // --- Building blocks -------------------------------------------------------

  function methodClass(method) {
    return 'wrk-m-' + String(method || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function langLabel(lang) {
    var map = { json: 'JSON', xml: 'XML', html: 'HTML', javascript: 'JavaScript', graphql: 'GraphQL', text: 'Text' };
    return map[lang] || (lang ? String(lang).toUpperCase() : 'Code');
  }

  function copyButton(index) {
    return '<button class="wrk-copy" type="button" data-copy="' + index + '" title="Copy" aria-label="Copy">' + ICONS.copy + '</button>';
  }

  function codeBlock(text, lang) {
    if (!text) return '';
    copies.push(text);
    return '<div class="wrk-codeblock">' +
      '<div class="wrk-codeblock-bar"><span>' + esc(langLabel(lang)) + '</span>' + copyButton(copies.length - 1) + '</div>' +
      '<pre><code>' + highlight(text, lang) + '</code></pre>' +
      '</div>';
  }

  function kvTable(rows) {
    if (!rows || rows.length === 0) return '';
    var h = '<table class="wrk-table"><thead><tr><th>Name</th><th>Value</th><th>Notes</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var value = rows[i].secret ? MASKED : esc(rows[i].value);
      h += '<tr><td><code>' + esc(rows[i].name) + '</code></td><td><code>' + value + '</code></td><td>' + esc(rows[i].description || '') + '</td></tr>';
    }
    return h + '</tbody></table>';
  }

  function section(title, inner) {
    return inner ? '<h4 class="wrk-h4">' + esc(title) + '</h4>' + inner : '';
  }

  function bodyHtml(body) {
    if (!body) return '';
    if (body.mode === 'raw') return body.raw ? codeBlock(body.raw.text, body.raw.language) : '';
    if (body.mode === 'urlEncoded') return kvTable(body.urlEncoded);
    if (body.mode === 'formData') return kvTable(body.formData);
    if (body.mode === 'graphql' && body.graphql) {
      var out = codeBlock(body.graphql.query, 'graphql');
      if (body.graphql.variables && body.graphql.variables.trim() !== '{}') {
        out += '<h5 class="wrk-h5">Variables</h5>' + codeBlock(body.graphql.variables, 'json');
      }
      return out;
    }
    if (body.mode === 'binary') return '<p class="wrk-empty">' + esc(body.binary || 'A file is sent as the body.') + '</p>';
    return '';
  }

  function testsHtml(tests) {
    if (!tests || tests.length === 0) return '';
    var h = '<ul class="wrk-tests">';
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      h += '<li><span class="wrk-test-source">' + esc(t.source) + '</span>' +
        (t.target ? ' <code>' + esc(t.target) + '</code>' : '') +
        ' <span class="wrk-test-op">' + esc(t.op) + '</span> <code>' + esc(t.expected) + '</code></li>';
    }
    return h + '</ul>';
  }

  function settingsHtml(settings) {
    if (!settings || settings.length === 0) return '';
    var h = '<table class="wrk-table wrk-settings"><tbody>';
    for (var i = 0; i < settings.length; i++) {
      h += '<tr><th scope="row">' + esc(settings[i].label) + '</th><td><code>' + esc(settings[i].value) + '</code></td></tr>';
    }
    return h + '</tbody></table>';
  }

  // --- Response --------------------------------------------------------------

  function guessLang(headers) {
    var ct = '';
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].name.toLowerCase() === 'content-type') ct = headers[i].value.toLowerCase();
    }
    if (ct.indexOf('json') !== -1) return 'json';
    if (ct.indexOf('xml') !== -1 || ct.indexOf('html') !== -1) return 'xml';
    if (ct.indexOf('javascript') !== -1) return 'js';
    return 'text';
  }

  function responseHtml(resp) {
    if (!resp) return '<p class="wrk-empty">Run the request to see the response here.</p>';
    if (resp.loading) return '<p class="wrk-empty">Sending…</p>';
    if (resp.error) {
      return '<div class="wrk-resp-err"><strong>Request failed</strong>' +
        '<p>' + esc(resp.error) + '</p>' +
        '<p class="wrk-note">This page sends the request straight from the browser, so the server must allow CORS for it to work from here. The generated code snippets run without that restriction.</p></div>';
    }
    var statusClass = resp.status >= 200 && resp.status < 300 ? 'wrk-resp-ok' : resp.status >= 400 ? 'wrk-resp-bad' : 'wrk-resp-warn';
    var h = '<div class="wrk-resp-meta">' +
      '<span class="wrk-status ' + statusClass + '">' + esc(resp.status) + ' ' + esc(resp.statusText) + '</span>' +
      '<span>' + resp.timeMs + ' ms</span>' +
      '<span>' + resp.size + ' bytes</span></div>';
    if (resp.headers && resp.headers.length) {
      h += section('Response headers', kvTable(resp.headers));
    }
    if (resp.body) {
      h += '<div class="wrk-resp-body">' + codeBlock(resp.body, guessLang(resp.headers)) + '</div>';
    } else {
      h += '<p class="wrk-empty">Empty response body.</p>';
    }
    return h;
  }

  // --- Sending ---------------------------------------------------------------

  function addQuery(url, name, value) {
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + encodeURIComponent(name) + '=' + encodeURIComponent(value);
  }

  function b64(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }

  /** Adds the auth header/query to the request being built; returns the URL. */
  function applyAuth(auth, map, headers, url) {
    if (!auth) return url;
    if (auth.type === 'bearer') {
      var token = sub(auth.token, map);
      if (token) headers.push(['Authorization', 'Bearer ' + token]);
    } else if (auth.type === 'basic') {
      var user = sub(auth.username, map);
      var pass = sub(auth.password, map);
      headers.push(['Authorization', 'Basic ' + b64(user + ':' + pass)]);
    } else if (auth.type === 'apiKey') {
      var key = sub(auth.key, map);
      var value = sub(auth.value, map);
      if (key) {
        if (auth.addTo === 'header') headers.push([key, value]);
        else url = addQuery(url, key, value);
      }
    }
    return url;
  }

  function buildFetch(node, map) {
    var wire = node.wire;
    var headers = [];
    for (var i = 0; i < wire.headers.length; i++) {
      headers.push([sub(wire.headers[i].name, map), sub(wire.headers[i].value, map)]);
    }
    var url = sub(wire.url, map);
    url = applyAuth(node.auth, map, headers, url);
    var headerObject = {};
    for (var j = 0; j < headers.length; j++) {
      var name = headers[j][0];
      if (name && !(name.toLowerCase() in headerObject)) headerObject[name] = headers[j][1];
    }
    var opts = { method: wire.method, headers: headerObject };
    if (wire.bodyMode === 'formData') {
      var fd = new FormData();
      for (var k = 0; k < wire.formData.length; k++) {
        fd.append(sub(wire.formData[k].name, map), sub(wire.formData[k].value, map));
      }
      opts.body = fd;
    } else if (wire.body) {
      opts.body = sub(wire.body, map);
    }
    return { url: url, opts: opts };
  }

  function sendRequest(node) {
    var key = selected;
    var map = varMapFor();
    var request;
    try {
      request = buildFetch(node, map);
    } catch (err) {
      responses[key] = { loading: false, error: 'Could not build the request: ' + String(err && err.message || err) };
      tab = 'response';
      renderMain(node);
      return;
    }
    responses[key] = { loading: true };
    tab = 'response';
    renderMain(node);
    var started = Date.now();
    fetch(request.url, request.opts).then(function (res) {
      return res.text().then(function (text) {
        var headers = [];
        res.headers.forEach(function (value, name) {
          headers.push({ name: name, value: value });
        });
        responses[key] = {
          loading: false,
          status: res.status,
          statusText: res.statusText,
          timeMs: Date.now() - started,
          size: text.length,
          headers: headers,
          body: text,
          finalUrl: res.url || request.url
        };
        renderMain(node);
      });
    }).catch(function (err) {
      responses[key] = { loading: false, error: String(err && err.message || err) };
      renderMain(node);
    });
  }

  // --- Tabs ------------------------------------------------------------------

  function tabBar(active) {
    var h = '<div class="wrk-tabs" role="tablist">';
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      h += '<button class="wrk-tab' + (t === active ? ' wrk-tab-active' : '') + '" type="button" role="tab" data-tab="' + t + '">' + TAB_LABELS[t] + '</button>';
    }
    return h + '</div>';
  }

  function authTabHtml(node) {
    var map = varMapFor();
    if (!node.auth) return '<p class="wrk-empty">No authorization.</p>';
    var a = node.auth;
    var h = '<p class="wrk-auth">' + esc(a.label || '') + '</p>';
    if (a.type === 'bearer') {
      var token = sub(a.token, map);
      h += kvTable([{ name: 'Authorization', value: token ? 'Bearer ' + token : '' }]);
    } else if (a.type === 'basic') {
      h += kvTable([{ name: 'Username', value: sub(a.username, map) }, { name: 'Password', value: sub(a.password, map) }]);
    } else if (a.type === 'apiKey') {
      h += kvTable([{ name: a.key, value: sub(a.value, map), description: a.addTo === 'query' ? 'Sent in the query string' : 'Sent in the headers' }]);
    } else if (a.type === 'oauth2') {
      h += '<p class="wrk-note">The OAuth 2.0 token is not included in an exported page.</p>';
    }
    return h;
  }

  function codeTabHtml(node) {
    if (!node.code || node.code.length === 0) {
      return '<p class="wrk-empty">Code generation is available for REST requests.</p>';
    }
    var target = codeLangs[selected] || node.code[0].target;
    var snippet = null;
    for (var i = 0; i < node.code.length; i++) {
      if (node.code[i].target === target) { snippet = node.code[i]; break; }
    }
    if (!snippet) snippet = node.code[0];
    var map = varMapFor();
    var text = sub(snippet.code, map);
    copies.push(text);
    var h = '<div class="wrk-code-langs">';
    for (var j = 0; j < node.code.length; j++) {
      h += '<button class="wrk-lang-btn' + (node.code[j].target === snippet.target ? ' wrk-active' : '') + '" type="button" data-lang="' + node.code[j].target + '">' + esc(node.code[j].label) + '</button>';
    }
    h += '</div>';
    h += '<div class="wrk-codeblock">' +
      '<div class="wrk-codeblock-bar"><span>' + esc(snippet.label) + '</span>' + copyButton(copies.length - 1) + '</div>' +
      '<pre><code>' + highlight(text, snippet.language) + '</code></pre>' +
      '</div>';
    return h;
  }

  function tabHtml(node, active) {
    var map = varMapFor();
    switch (active) {
      case 'docs':
        return (node.docs ? '<div class="wrk-prose">' + node.docs + '</div>' : '<p class="wrk-empty">No documentation yet.</p>') + settingsHtml(node.settings);
      case 'query':
        return node.query && node.query.length ? kvTable(subRows(node.query, map)) : '<p class="wrk-empty">No query parameters.</p>';
      case 'headers':
        return node.headers && node.headers.length ? kvTable(subRows(node.headers, map)) : '<p class="wrk-empty">No headers.</p>';
      case 'auth':
        return authTabHtml(node);
      case 'body':
        return bodyHtml(node.body) || '<p class="wrk-empty">No body.</p>';
      case 'scripts': {
        var s = '';
        if (node.preScript) s += section('Pre-request script', codeBlock(node.preScript, 'javascript'));
        if (node.postScript) s += section('Post-response script', codeBlock(node.postScript, 'javascript'));
        return s || '<p class="wrk-empty">No scripts.</p>';
      }
      case 'tests':
        return testsHtml(node.tests) || '<p class="wrk-empty">No tests.</p>';
      case 'code':
        return codeTabHtml(node);
      case 'response':
        return responseHtml(responses[selected]);
    }
    return '';
  }

  function requestHtml(node) {
    var map = varMapFor();
    var url = sub(node.url, map);
    copies = [];
    copies.push(url);
    var h = '<div class="wrk-req-head">' +
      '<span class="wrk-method ' + methodClass(node.method) + '">' + esc(node.method) + '</span>' +
      '<code class="wrk-url">' + esc(url || '(no URL)') + '</code>';
    if (node.url) {
      h += '<button class="wrk-copy wrk-url-copy" type="button" data-copy="0" title="Copy URL" aria-label="Copy URL">' + ICONS.copy + '</button>';
    }
    h += '<button class="wrk-send" type="button" data-send=""' +
      (node.wire && node.wire.sendable ? '' : ' disabled') +
      ' title="' + esc((node.wire && node.wire.note) || 'Send the request') + '">' + ICONS.play + ' Send</button>';
    h += '</div>';
    if (node.wire && node.wire.note && !node.wire.sendable) {
      h += '<p class="wrk-note">' + esc(node.wire.note) + '</p>';
    }
    if (node.protocol && node.protocol !== 'rest') {
      h += '<p class="wrk-meta">Protocol: <strong>' + esc(node.protocol) + '</strong></p>';
    }
    h += tabBar(tab);
    h += '<div class="wrk-tabpanel">' + tabHtml(node, tab) + '</div>';
    return h;
  }

  function requestCount(node) {
    var n = 0;
    function walk(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].kind === 'request') n++;
        else walk(nodes[i].children);
      }
    }
    walk(node.children || []);
    return n;
  }

  function folderHtml(node) {
    copies = [];
    var count = requestCount(node);
    var h = '<div class="wrk-req-head">' +
      '<span class="wrk-folder-glyph">' + ICONS.folder + '</span>' +
      '<span class="wrk-folder-title">' + esc(node.name) + '</span></div>';
    h += '<p class="wrk-meta">' + count + ' request' + (count === 1 ? '' : 's') + ' inside. Pick one from the list.</p>';
    h += section('Documentation', node.docs ? '<div class="wrk-prose">' + node.docs + '</div>' : '<p class="wrk-empty">No documentation yet.</p>');
    h += section('Shared headers', kvTable(node.headers));
    h += section('Authorization', node.auth ? '<p class="wrk-auth">' + esc(node.auth) + '</p>' : '');
    return h;
  }

  function overviewHtml() {
    copies = [];
    var h = '<div class="wrk-req-head">' +
      '<span class="wrk-folder-glyph">' + ICONS.collection + '</span>' +
      '<span class="wrk-folder-title">' + esc(data.title) + '</span></div>';
    h += section('Documentation', data.notes ? '<div class="wrk-prose">' + data.notes + '</div>' : '<p class="wrk-empty">No documentation yet.</p>');
    h += section('Shared headers', kvTable(data.sharedHeaders));
    if (data.collectionVariables && data.collectionVariables.length) {
      h += section('Collection variables', kvTable(data.collectionVariables));
    }
    if (data.environments && data.environments.length) {
      h += '<h4 class="wrk-h4">Environments</h4>';
      for (var i = 0; i < data.environments.length; i++) {
        var env = data.environments[i];
        h += '<h5 class="wrk-h5"><button class="wrk-env-link" type="button" data-env="' + env.id + '">' + esc(env.name) + '</button>' +
          (env.id === envId ? ' <span class="wrk-env-now">(selected)</span>' : '') + '</h5>';
        h += kvTable(env.variables);
      }
      h += '<button class="wrk-env-link" type="button" data-env="">Use no environment</button>';
    }
    if (data.hasSecrets) {
      h += '<p class="wrk-note">Secret variables are not exported — their values are left blank in this page.</p>';
    }
    h += '<p class="wrk-meta">Select a request from the list to see its details.</p>';
    return h;
  }

  function renderMain(node) {
    var html = '';
    if (node && node.kind === 'request') html = requestHtml(node);
    else if (node && node.kind === 'folder') html = folderHtml(node);
    else html = overviewHtml();
    main.innerHTML = html;
    main.scrollTop = 0;
  }

  // --- Sidebar ---------------------------------------------------------------

  function matches(s, q) {
    if (!q) return true;
    return s.toLowerCase().indexOf(q) !== -1;
  }

  function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ');
  }

  function filterTree(nodes, q, base) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var path = base.concat([i]);
      var node = nodes[i];
      if (node.kind === 'folder') {
        var kids = filterTree(node.children, q, path);
        if (kids.length > 0 || matches(node.name + ' ' + stripTags(node.docs), q)) {
          out.push({ node: node, path: path, kids: kids });
        }
      } else if (matches(node.name + ' ' + node.method + ' ' + node.url, q)) {
        out.push({ node: node, path: path, kids: null });
      }
    }
    return out;
  }

  function renderTree(entries, forceOpen) {
    var h = '';
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = entry.path.join('/');
      var node = entry.node;
      if (node.kind === 'folder') {
        var open = forceOpen || expanded[key] !== false;
        h += '<div class="wrk-folder">';
        h += '<div class="wrk-folder-row">';
        h += '<button class="wrk-chev' + (open ? ' wrk-open' : '') + '" type="button" data-toggle="' + key + '" aria-label="Toggle folder" aria-expanded="' + (open ? 'true' : 'false') + '">' + ICONS.chevron + '</button>';
        h += '<span class="wrk-folder-name" data-key="' + key + '">' + esc(node.name) + '</span>';
        h += '</div>';
        if (open) {
          h += '<div class="wrk-children">' + renderTree(entry.kids || [], forceOpen) + '</div>';
        }
        h += '</div>';
      } else {
        h += '<div class="wrk-item" data-key="' + key + '" tabindex="0">' +
          '<span class="wrk-method ' + methodClass(node.method) + '">' + esc(node.method) + '</span>' +
          '<span class="wrk-name">' + esc(node.name) + '</span></div>';
      }
    }
    return h;
  }

  function markSelected() {
    if (!selected) return;
    var el = sidebar.querySelector('[data-key="' + selected + '"]');
    if (el) el.classList.add('wrk-selected');
  }

  function renderSidebar() {
    var q = searchInput.value.trim().toLowerCase();
    var entries = filterTree(data.tree, q, []);
    var html = renderTree(entries, q !== '');
    sidebar.innerHTML = html === '' ? '<p class="wrk-none">No requests match.</p>' : html;
    markSelected();
  }

  // --- Navigation ------------------------------------------------------------

  function nodeAtPath(path) {
    var nodes = data.tree;
    var node = null;
    for (var i = 0; i < path.length; i++) {
      if (!nodes || path[i] >= nodes.length) return null;
      node = nodes[path[i]];
      if (node.kind === 'folder') nodes = node.children;
      else return node;
    }
    return node;
  }

  function currentNode() {
    if (!selected) return null;
    return nodeAtPath(selected.split('/').map(Number));
  }

  function selectByKey(key) {
    selected = key;
    tab = 'docs';
    renderMain(currentNode());
    renderSidebar();
  }

  function keyOfFirstRequest(nodes, base) {
    for (var i = 0; i < nodes.length; i++) {
      var path = base.concat([i]);
      var node = nodes[i];
      if (node.kind === 'request') return path.join('/');
      var found = keyOfFirstRequest(node.children, path);
      if (found) return found;
    }
    return null;
  }

  // --- Print / PDF -----------------------------------------------------------

  function printRequest(node) {
    var map = varMapFor();
    var h = '<section class="wrk-print-req"><h3>' + esc(node.name) + '</h3>';
    h += '<p class="wrk-print-endpoint"><span class="wrk-method ' + methodClass(node.method) + '">' + esc(node.method) + '</span> <code>' + esc(sub(node.url, map)) + '</code></p>';
    h += node.docs ? '<div class="wrk-prose">' + node.docs + '</div>' : '<p class="wrk-empty">No documentation yet.</p>';
    h += section('Query parameters', node.query && node.query.length ? kvTable(subRows(node.query, map)) : '');
    h += section('Headers', node.headers && node.headers.length ? kvTable(subRows(node.headers, map)) : '');
    h += section('Authorization', node.auth ? '<p class="wrk-auth">' + esc(node.auth.label || '') + '</p>' : '');
    h += section('Body', bodyHtml(node.body));
    h += section('Tests', testsHtml(node.tests));
    if (node.preScript) h += section('Pre-request script', codeBlock(node.preScript, 'javascript'));
    if (node.postScript) h += section('Post-response script', codeBlock(node.postScript, 'javascript'));
    return h + '</section>';
  }

  function printTree(nodes) {
    var h = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.kind === 'folder') {
        h += '<section class="wrk-print-folder"><h2>' + esc(node.name) + '</h2>';
        if (node.docs) h += '<div class="wrk-prose">' + node.docs + '</div>';
        h += section('Shared headers', kvTable(node.headers));
        h += printTree(node.children);
        h += '</section>';
      } else {
        h += printRequest(node);
      }
    }
    return h;
  }

  function buildPrintHtml() {
    var h = '<div class="wrk-doc"><h1>' + esc(data.title) + '</h1>';
    h += '<p class="wrk-print-sub">' + esc(data.subtitle) + '</p>';
    if (data.notes) h += '<div class="wrk-prose">' + data.notes + '</div>';
    h += printTree(data.tree);
    return h + '</div>';
  }

  // --- Events ----------------------------------------------------------------

  themeBtn.addEventListener('click', toggleTheme);

  printBtn.addEventListener('click', function () {
    var root = document.getElementById('wrk-print-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'wrk-print-root';
      document.body.appendChild(root);
    }
    root.innerHTML = buildPrintHtml();
    window.print();
  });

  searchInput.addEventListener('input', function () {
    if (searchInput.value.trim() === '') expanded = {};
    renderSidebar();
  });

  sidebar.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      var key = toggle.getAttribute('data-toggle');
      expanded[key] = expanded[key] === false ? true : false;
      renderSidebar();
      return;
    }
    var sel = e.target.closest('.wrk-item, .wrk-folder-name');
    if (sel) selectByKey(sel.getAttribute('data-key'));
  });

  main.addEventListener('click', function (e) {
    var tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.getAttribute('data-tab');
      renderMain(currentNode());
      return;
    }
    var langBtn = e.target.closest('[data-lang]');
    if (langBtn) {
      codeLangs[selected] = langBtn.getAttribute('data-lang');
      renderMain(currentNode());
      return;
    }
    var sendBtn = e.target.closest('[data-send]');
    if (sendBtn) {
      var node = currentNode();
      if (node && node.wire && node.wire.sendable) sendRequest(node);
      return;
    }
    var envBtn = e.target.closest('[data-env]');
    if (envBtn) {
      envId = envBtn.getAttribute('data-env') || null;
      try { localStorage.setItem(ENV_KEY, envId || ''); } catch (err) {}
      envSelect.value = envId || '';
      renderMain(currentNode());
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (t && (t.classList.contains('wrk-item') || t.classList.contains('wrk-folder-name'))) {
      e.preventDefault();
      selectByKey(t.getAttribute('data-key'));
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var index = Number(btn.getAttribute('data-copy'));
    if (isNaN(index) || !copies[index]) return;
    var text = copies[index];
    var mark = function () {
      var old = btn.innerHTML;
      btn.innerHTML = ICONS.check;
      btn.classList.add('wrk-copied');
      setTimeout(function () {
        btn.innerHTML = old;
        btn.classList.remove('wrk-copied');
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(mark, function () { fallbackCopy(text, mark); });
    } else {
      fallbackCopy(text, mark);
    }
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (err) {}
    document.body.removeChild(ta);
  }

  // --- Start -----------------------------------------------------------------

  initTheme();
  initEnv();
  renderSidebar();
  var initial = keyOfFirstRequest(data.tree, []);
  if (initial) {
    selected = initial;
    renderMain(nodeAtPath(initial.split('/').map(Number)));
    markSelected();
  } else {
    renderMain(null);
  }
})();
`;

// Layout and theme are CSS variables, so the toggle is one attribute swap and
// print swaps the interactive viewer for a document of the whole collection.

const VIEWER_STYLE = `
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --bg-side: #fafbfc;
    --bg-panel: #ffffff;
    --text: #16181d;
    --muted: #6b7280;
    --faint: #9aa1ad;
    --border: #e3e5e9;
    --border-strong: #cfd4da;
    --code-bg: #f7f8fa;
    --hover: rgba(17, 24, 39, 0.05);
    --selected-bg: rgba(255, 108, 55, 0.12);
    --accent: #ff6c37;
    --tok-key: #0550ae;
    --tok-str: #0a7d2f;
    --tok-num: #c4571b;
    --tok-lit: #cf222e;
    --tok-com: #8b949e;
    --tok-kw: #8250df;
    --tok-tag: #116329;
    --tok-attr: #953800;
    --m-get: #1f9d55;
    --m-post: #b45309;
    --m-put: #2563eb;
    --m-patch: #7c3aed;
    --m-delete: #dc2626;
    --m-other: #64748b;
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg: #0f1115;
    --bg-side: #15181d;
    --bg-panel: #1a1e24;
    --text: #e6e8eb;
    --muted: #9aa1ad;
    --faint: #6b7280;
    --border: #262b33;
    --border-strong: #333a44;
    --code-bg: #101318;
    --hover: rgba(255, 255, 255, 0.05);
    --selected-bg: rgba(255, 108, 55, 0.18);
    --accent: #ff8a5c;
    --tok-key: #79b8ff;
    --tok-str: #85e89d;
    --tok-num: #f0883e;
    --tok-lit: #f97583;
    --tok-com: #8b949e;
    --tok-kw: #b392f0;
    --tok-tag: #7ee787;
    --tok-attr: #ffab70;
    --m-get: #3fb97e;
    --m-post: #e09a3e;
    --m-put: #6d9bff;
    --m-patch: #b392f0;
    --m-delete: #f47067;
    --m-other: #8b949e;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  code { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
  .wrk-topbar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 1rem;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  .wrk-topbar-title { min-width: 0; }
  .wrk-topbar-title strong { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wrk-topbar-sub { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wrk-topbar-actions { flex: none; display: flex; align-items: center; gap: 0.5rem; }
  .wrk-env {
    max-width: 200px;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
  .wrk-env:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .wrk-theme-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--muted);
    cursor: pointer;
  }
  .wrk-theme-btn:hover { color: var(--text); border-color: var(--border-strong); }
  .wrk-theme-btn:focus-visible, .wrk-chev:focus-visible, .wrk-copy:focus-visible,
  .wrk-item:focus-visible, .wrk-folder-name:focus-visible, .wrk-tab:focus-visible,
  .wrk-send:focus-visible, .wrk-lang-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  .wrk-layout { flex: 1; min-height: 0; display: flex; }
  .wrk-side {
    flex: none;
    width: 285px;
    display: flex;
    flex-direction: column;
    background: var(--bg-side);
    border-right: 1px solid var(--border);
  }
  .wrk-search { flex: none; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); }
  .wrk-search input {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
  }
  .wrk-search input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .wrk-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 0.5rem 0.5rem 1.5rem; }
  .wrk-main { flex: 1; min-width: 0; overflow-y: auto; padding: 1.5rem 2rem 4rem; background: var(--bg-panel); }
  .wrk-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.55rem;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .wrk-item:hover { background: var(--hover); }
  .wrk-item.wrk-selected { background: var(--selected-bg); }
  .wrk-name { overflow: hidden; text-overflow: ellipsis; }
  .wrk-folder-row {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.25rem 0.3rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .wrk-folder-row:hover { background: var(--hover); }
  .wrk-folder-name { font-weight: 600; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrk-folder-name.wrk-selected { color: var(--text); }
  .wrk-children { margin-left: 0.7rem; }
  .wrk-chev {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: none;
    color: var(--faint);
    cursor: pointer;
    transform: rotate(0deg);
    transition: transform 0.12s ease;
  }
  .wrk-chev.wrk-open { transform: rotate(90deg); }
  .wrk-none { color: var(--faint); font-style: italic; padding: 0.75rem 0.6rem; }
  .wrk-method {
    flex: none;
    display: inline-block;
    min-width: 3.6em;
    padding: 0.08em 0.4em;
    border-radius: 4px;
    font: 600 0.72em/1.7 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.03em;
    text-align: center;
    color: var(--m-other);
  }
  .wrk-req-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .wrk-req-head .wrk-method { font-size: 0.85em; min-width: 4.2em; }
  .wrk-url {
    flex: 1;
    min-width: 0;
    word-break: break-all;
    white-space: pre-wrap;
    font-size: 13px;
  }
  .wrk-url-copy { flex: none; }
  .wrk-send {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.32rem 0.75rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #ffffff;
    font: 600 12.5px/1 inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .wrk-send:hover { filter: brightness(1.06); }
  .wrk-send:disabled { opacity: 0.45; cursor: not-allowed; }
  .wrk-folder-glyph { color: var(--muted); display: inline-flex; }
  .wrk-folder-title { font-size: 16px; font-weight: 600; }
  .wrk-meta { color: var(--muted); font-size: 12.5px; margin: 0 0 1.2rem; }
  .wrk-note { margin: 0.2em 0 0.8em; color: var(--muted); font-size: 12px; }
  .wrk-h4 {
    margin: 1.4em 0 0.4em;
    font-size: 0.95em;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .wrk-h5 { margin: 1em 0 0.3em; font-size: 0.9em; color: var(--muted); }
  .wrk-auth { margin: 0.2em 0 0.6em; }
  .wrk-empty { color: var(--faint); font-style: italic; margin: 0.2em 0 0.6em; }
  .wrk-prose { max-width: 60rem; }
  .wrk-prose h1, .wrk-prose h2, .wrk-prose h3, .wrk-prose h4, .wrk-prose h5, .wrk-prose h6 {
    margin: 1.2em 0 0.4em; line-height: 1.3;
  }
  .wrk-prose p { margin: 0.5em 0; }
  .wrk-prose ul, .wrk-prose ol { padding-left: 1.4em; margin: 0.5em 0; }
  .wrk-prose blockquote { margin: 0.6em 0; padding-left: 0.8em; border-left: 3px solid var(--border-strong); color: var(--muted); }
  .wrk-prose table { border-collapse: collapse; margin: 0.6em 0; max-width: 100%; }
  .wrk-prose th, .wrk-prose td { border: 1px solid var(--border); padding: 0.3em 0.5em; text-align: left; }
  .wrk-prose th { background: var(--bg-side); }
  .wrk-prose a { color: var(--accent); }
  .wrk-prose img { max-width: 100%; height: auto; }
  .wrk-prose pre { margin: 0.6em 0; }
  .wrk-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    margin-bottom: 1.1rem;
    border-bottom: 1px solid var(--border);
  }
  .wrk-tab {
    padding: 0.35rem 0.7rem;
    margin-bottom: -1px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .wrk-tab:hover { color: var(--text); }
  .wrk-tab.wrk-tab-active { color: var(--text); border-bottom-color: var(--accent); }
  .wrk-code-langs { display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0 0 0.6rem; }
  .wrk-lang-btn {
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-side);
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .wrk-lang-btn:hover { color: var(--text); border-color: var(--border-strong); }
  .wrk-lang-btn.wrk-active { color: var(--accent); border-color: var(--accent); }
  .wrk-table {
    width: 100%;
    max-width: 60rem;
    border-collapse: collapse;
    margin: 0.3em 0 0.8em;
    font-size: 12.5px;
  }
  .wrk-table th, .wrk-table td {
    padding: 0.32em 0.5em;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    word-break: break-word;
  }
  .wrk-table th { background: var(--bg-side); font-weight: 600; white-space: nowrap; }
  .wrk-settings th { width: 12rem; }
  .wrk-codeblock {
    margin: 0.3em 0 0.8em;
    max-width: 60rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--code-bg);
  }
  .wrk-codeblock-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.28rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-side);
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .wrk-codeblock pre { margin: 0; }
  .wrk-codeblock pre code {
    display: block;
    padding: 0.7rem 0.8rem;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
  }
  .wrk-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-panel);
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .wrk-copy:hover { color: var(--text); border-color: var(--border-strong); }
  .wrk-copy.wrk-copied { color: var(--m-get); border-color: var(--m-get); }
  .wrk-tests { padding-left: 1.2rem; margin: 0.2em 0 0.8em; }
  .wrk-tests li { margin: 0.25em 0; }
  .wrk-tests code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.05em 0.35em; }
  .wrk-test-source { font-weight: 600; }
  .wrk-test-op { color: var(--muted); }
  .wrk-env-link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .wrk-env-link:hover { text-decoration: underline; }
  .wrk-env-now { color: var(--muted); font-size: 11px; }
  .wrk-resp-meta { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin: 0 0 0.6rem; color: var(--muted); font-size: 12.5px; }
  .wrk-status { font-weight: 600; }
  .wrk-resp-ok { color: var(--m-get); }
  .wrk-resp-bad { color: var(--m-delete); }
  .wrk-resp-warn { color: var(--m-post); }
  .wrk-resp-err {
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--m-delete);
    border-radius: 6px;
    background: rgba(220, 38, 38, 0.07);
    max-width: 60rem;
  }
  .wrk-resp-err strong { color: var(--m-delete); }
  .t-k { color: var(--tok-key); }
  .t-s { color: var(--tok-str); }
  .t-n { color: var(--tok-num); }
  .t-l { color: var(--tok-lit); }
  .t-c { color: var(--tok-com); }
  .t-kw { color: var(--tok-kw); }
  .t-tag { color: var(--tok-tag); }
  .t-attr { color: var(--tok-attr); }
  .t-str { color: var(--tok-str); }
  .wrk-m-GET { color: var(--m-get); }
  .wrk-m-POST { color: var(--m-post); }
  .wrk-m-PUT { color: var(--m-put); }
  .wrk-m-PATCH { color: var(--m-patch); }
  .wrk-m-DELETE { color: var(--m-delete); }
  .wrk-m-HEAD { color: var(--m-other); }
  .wrk-m-OPTIONS { color: var(--m-other); }
  .wrk-m-TRACE { color: var(--m-other); }
  @media (max-width: 720px) {
    .wrk-layout { flex-direction: column; }
    .wrk-side { width: 100%; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border); }
    .wrk-main { padding: 1rem; }
    .wrk-env { max-width: 130px; }
  }
  /* The print document is assembled on demand and hidden until a print. */
  #wrk-print-root { display: none; }
  .wrk-doc {
    max-width: 46rem;
    margin: 0 auto;
    padding: 1.5rem;
    font-size: 12px;
    line-height: 1.6;
    color: #16181d;
  }
  .wrk-doc h1 { font-size: 1.9em; margin: 0 0 0.2em; }
  .wrk-doc h2 { font-size: 1.45em; margin: 1.6em 0 0.4em; }
  .wrk-doc h3 { font-size: 1.2em; margin: 1.4em 0 0.4em; }
  .wrk-doc h4 { font-size: 1em; margin: 1.1em 0 0.3em; color: #555b66; }
  .wrk-doc .wrk-print-sub { color: #6b7280; margin: 0 0 1.5em; }
  .wrk-doc .wrk-print-endpoint { margin: 0.2em 0 0.6em; }
  .wrk-doc pre { margin: 0.6em 0; }
  @media print {
    body { display: block; background: #fff !important; }
    body > :not(#wrk-print-root) { display: none !important; }
    #wrk-print-root { display: block !important; }
    html {
      --tok-key: #0550ae; --tok-str: #0a7d2f; --tok-num: #c4571b;
      --tok-lit: #cf222e; --tok-com: #8b949e; --tok-kw: #8250df;
      --tok-tag: #116329; --tok-attr: #953800;
      --m-get: #1f9d55; --m-post: #b45309; --m-put: #2563eb;
      --m-patch: #7c3aed; --m-delete: #dc2626; --m-other: #64748b;
    }
    .wrk-doc { color-scheme: light; color: #16181d; }
    .wrk-doc pre {
      background: #f7f8fa !important;
      border: 1px solid #e3e5e9;
      padding: 0.6em 0.8em;
      overflow-x: auto;
    }
    .wrk-doc table { border-collapse: collapse; width: 100%; margin: 0.4em 0 0.8em; }
    .wrk-doc th, .wrk-doc td { border: 1px solid #e3e5e9; padding: 0.32em 0.5em; text-align: left; vertical-align: top; }
    .wrk-doc th { background: #f7f8fa; }
    .wrk-doc a { color: #ff6c37; }
    .wrk-doc .wrk-copy { display: none !important; }
    .wrk-doc pre, .wrk-doc table { break-inside: avoid; }
    .wrk-doc h1, .wrk-doc h2, .wrk-doc h3, .wrk-doc h4 { break-after: avoid; }
    .wrk-print-req { border-top: 1px solid #eceef2; padding-top: 0.4em; }
    @page { margin: 16mm; }
  }
`;

export function buildStandaloneHtml(
  scope: DocsScope,
  options: ViewerOptions = {},
  now = new Date(),
): string {
  const generatedAt = now.toISOString().slice(0, 10);
  const data = buildViewerData(scope, options, generatedAt);
  return SHELL(VIEWER_STYLE, RENDERER, data);
}
