// Export in formats other tools read.
//
// The workspace's own JSON (exportWorkspace.ts) is lossless and is what GitHub
// sync commits, but nothing else can read it — so a collection could not be
// handed to somebody on Postman, or fed to a documentation generator. These two
// writers cover that, and both are lossy by nature: they can only carry what
// the target format has a place for. Everything dropped is listed in `warnings`
// so the loss is stated rather than discovered later.
//
// Credentials are redacted the same way as in the workspace export, and for the
// same reason: these are files, and files get shared.

import { activeRows } from "./rows";
import { isFolder } from "./tree";
import { parseQuery } from "./query";
import type { Environment, KeyValue, SavedRequest, TreeNode } from "../types";

export interface InteropExport {
  text: string;
  filename: string;
  /** What the target format had no place for. */
  warnings: string[];
}

export type ExportFormat = "native" | "postman" | "openapi";

export const EXPORT_FORMATS: {
  value: ExportFormat;
  label: string;
  title: string;
  hint: string;
}[] = [
  {
    value: "native",
    label: "APIKit workspace",
    title: "Export workspace",
    hint: "Everything, losslessly — collection, environments, monitors and mock routes. The format GitHub sync uses.",
  },
  {
    value: "postman",
    label: "Postman Collection v2.1",
    title: "Export as a Postman collection",
    hint: "For handing the collection to somebody on Postman. Scripts are exported commented out, since pm.* has no equivalent here.",
  },
  {
    value: "openapi",
    label: "OpenAPI 3.1",
    title: "Export as OpenAPI",
    hint: "For documentation and code generators. The lossiest option: OpenAPI describes an API, a collection is example calls.",
  },
];

function isVariableReference(value: string): boolean {
  return /^\s*\{\{\s*[\w.\-$]+\s*\}\}\s*$/.test(value);
}

function redact(value: string): string {
  return value === "" || isVariableReference(value) ? value : "";
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "collection"
  );
}

/** Flattens the tree to its requests, keeping the folder trail for each. */
function walkRequests(
  nodes: TreeNode[],
  trail: string[] = [],
): { request: SavedRequest; trail: string[] }[] {
  const found: { request: SavedRequest; trail: string[] }[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      found.push(...walkRequests(node.children, [...trail, node.name]));
    } else {
      found.push({ request: node, trail });
    }
  }
  return found;
}

// --- Postman Collection v2.1 -------------------------------------------------

const POSTMAN_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/**
 * Postman's scripts use `pm.*`, which has no counterpart here — and the
 * importer in postman.ts makes the mirror-image choice, commenting `pm.*` out
 * rather than translating it. A mechanical rewrite looks right and is subtly
 * wrong (`wrk.response.status` is `pm.response.code`, `toBe` is `to.eql`), and
 * a script that silently asserts the wrong thing is worse than one that plainly
 * does not run.
 */
function commentedScript(source: string, kind: string): string[] {
  return [
    `// Exported from APIKit (${kind}). APIKit's wrk.* API has no direct`,
    "// equivalent in Postman — rewrite using pm.*, then uncomment.",
    ...source.split("\n").map((line) => `// ${line}`),
  ];
}

function postmanUrl(url: string) {
  const query = parseQuery(url).map((row) => ({
    key: row.name,
    value: row.value,
    ...(row.description ? { description: row.description } : {}),
    ...(row.enabled === false ? { disabled: true } : {}),
  }));
  // `raw` is what Postman actually sends; the parts are for its URL editor, and
  // it recomputes them from raw on import. Sending raw alone is valid and keeps
  // `{{variables}}` intact, which splitting a host on "." would not.
  return query.length > 0 ? { raw: url, query } : { raw: url };
}

function postmanHeaders(headers: KeyValue[]) {
  return headers
    .filter((header) => header.name.trim() !== "")
    .map((header) => ({
      key: header.name,
      value: header.value,
      ...(header.description ? { description: header.description } : {}),
      // Postman keeps a disabled header in the list too, so this round trips.
      ...(header.enabled === false ? { disabled: true } : {}),
    }));
}

function postmanAuth(request: SavedRequest, warnings: string[]) {
  const auth = request.config.auth;
  switch (auth.type) {
    case "bearer":
      return {
        type: "bearer",
        bearer: [{ key: "token", value: redact(auth.token), type: "string" }],
      };
    case "basic":
      return {
        type: "basic",
        basic: [
          { key: "username", value: auth.username, type: "string" },
          { key: "password", value: redact(auth.password), type: "string" },
        ],
      };
    case "apiKey":
      return {
        type: "apikey",
        apikey: [
          { key: "key", value: auth.key, type: "string" },
          { key: "value", value: redact(auth.value), type: "string" },
          { key: "in", value: auth.addTo === "query" ? "query" : "header" },
        ],
      };
    case "oauth2": {
      const oauth = auth.oauth2;
      // Postman's grant names differ from the ones used here.
      const grant =
        oauth.grant === "authorizationCode"
          ? "authorization_code"
          : oauth.grant === "clientCredentials"
            ? "client_credentials"
            : oauth.grant === "password"
              ? "password_credentials"
              : "";
      if (grant === "") {
        warnings.push(
          `“${request.name}” uses the device code grant, which Postman has no equivalent for — its OAuth settings are exported without a grant type.`,
        );
      }
      const entry = (key: string, value: string) => ({
        key,
        value,
        type: "string",
      });
      return {
        type: "oauth2",
        oauth2: [
          ...(grant ? [entry("grant_type", grant)] : []),
          entry("authUrl", oauth.authorizeUrl),
          entry("accessTokenUrl", oauth.tokenUrl),
          entry("clientId", oauth.clientId),
          entry("clientSecret", redact(oauth.clientSecret)),
          entry("scope", oauth.scope),
          entry("redirect_uri", oauth.redirectUri),
          entry("challengeAlgorithm", oauth.usePkce ? "S256" : "none"),
          entry(
            "client_authentication",
            oauth.clientAuth === "basic" ? "header" : "body",
          ),
          entry("addTokenTo", oauth.addTo === "query" ? "queryParams" : "header"),
        ],
      };
    }
    case "inherit":
      // Postman's default is to inherit, so saying nothing is the translation.
      return undefined;
    default:
      return { type: "noauth" };
  }
}

function postmanBody(request: SavedRequest, warnings: string[]) {
  const config = request.config;
  switch (config.bodyMode) {
    case "raw":
      return {
        mode: "raw",
        raw: request.body,
        options: { raw: { language: config.rawLanguage } },
      };
    case "urlEncoded":
      return {
        mode: "urlencoded",
        urlencoded: postmanHeaders(config.urlEncoded),
      };
    case "formData":
      return {
        mode: "formdata",
        formdata: activeRows(config.formData).map((row) =>
          row.kind === "file"
            ? { key: row.name, type: "file", src: row.filePath ?? "" }
            : { key: row.name, value: row.value, type: "text" },
        ),
      };
    case "graphql":
      return {
        mode: "graphql",
        graphql: {
          query: config.graphqlQuery,
          variables: config.graphqlVariables,
        },
      };
    case "binary":
      if (config.binaryFilePath) {
        warnings.push(
          `“${request.name}” sends a file as its body. Postman stores only the path, so the recipient must supply the file themselves.`,
        );
      }
      return { mode: "file", file: { src: config.binaryFilePath } };
    default:
      return undefined;
  }
}

function postmanItem(request: SavedRequest, warnings: string[]) {
  const config = request.config;
  const events: unknown[] = [];

  if (config.preScript.trim() !== "") {
    events.push({
      listen: "prerequest",
      script: { type: "text/javascript", exec: commentedScript(config.preScript, "pre-request") },
    });
  }
  // Declarative assertions and post-response scripts both land in Postman's
  // single "test" event.
  const testLines: string[] = [];
  if (config.postScript.trim() !== "") {
    testLines.push(...commentedScript(config.postScript, "post-response"));
  }
  if (request.tests.length > 0) {
    warnings.push(
      `“${request.name}” has ${request.tests.length} assertion${request.tests.length === 1 ? "" : "s"} in the Tests tab. Postman has no declarative equivalent, so they are exported as commented pm.test scaffolding.`,
    );
    for (const test of request.tests) {
      testLines.push(
        `// pm.test(${JSON.stringify(
          `${test.source} ${test.target} ${test.op} ${test.expected}`.trim(),
        )}, () => { /* rewrite using pm.expect */ });`,
      );
    }
  }
  if (testLines.length > 0) {
    events.push({
      listen: "test",
      script: { type: "text/javascript", exec: testLines },
    });
  }

  if (config.protocol !== "rest" && config.protocol !== "graphql") {
    warnings.push(
      `“${request.name}” is ${config.protocol.toUpperCase()}. Postman collections describe HTTP, so it is exported as a plain HTTP request.`,
    );
  }

  const auth = postmanAuth(request, warnings);
  const body = postmanBody(request, warnings);

  return {
    name: request.name,
    ...(events.length > 0 ? { event: events } : {}),
    request: {
      method: request.method.toUpperCase(),
      header: postmanHeaders(request.headers),
      ...(body ? { body } : {}),
      ...(auth ? { auth } : {}),
      url: postmanUrl(request.url),
      ...(config.docs.trim() !== "" ? { description: config.docs } : {}),
    },
  };
}

function postmanItems(nodes: TreeNode[], warnings: string[]): unknown[] {
  return nodes.map((node) =>
    isFolder(node)
      ? {
          name: node.name,
          item: postmanItems(node.children, warnings),
          ...(node.auth && node.auth.type !== "inherit" && node.auth.type !== "none"
            ? {
                auth: postmanAuth(
                  { name: node.name, config: { auth: node.auth } } as SavedRequest,
                  warnings,
                ),
              }
            : {}),
        }
      : postmanItem(node, warnings),
  );
}

/**
 * A Postman Collection v2.1 document.
 *
 * Variables come from one environment because a collection has a single
 * variable list; Postman keeps environments in separate files it does not
 * accept inline.
 */
export function toPostmanCollection(
  workspace: string,
  tree: TreeNode[],
  environment?: Environment,
): InteropExport {
  const warnings: string[] = [];

  const collection = {
    info: {
      name: workspace,
      schema: POSTMAN_SCHEMA,
      description: `Exported from APIKit on ${new Date().toISOString().slice(0, 10)}. Credentials typed directly into auth fields have been removed; {{variable}} references are kept.`,
    },
    item: postmanItems(tree, warnings),
    ...(environment
      ? {
          variable: environment.variables
            .filter((variable) => variable.name.trim() !== "")
            .map((variable) => ({
              key: variable.name,
              // A secret's value is dropped, matching the workspace export.
              value: variable.secret ? "" : variable.value,
              type: "string",
            })),
        }
      : {}),
  };

  if (environment?.variables.some((variable) => variable.secret)) {
    warnings.push(
      "Secret environment variables are exported by name only, without their values.",
    );
  }

  return {
    text: `${JSON.stringify(collection, null, 2)}\n`,
    filename: `${slug(workspace)}.postman_collection.json`,
    warnings: [...new Set(warnings)],
  };
}

// --- OpenAPI 3.1 -------------------------------------------------------------

/** Splits a URL into an origin to serve as a server, and a path. */
function splitUrl(url: string): { origin: string; path: string } {
  const withoutQuery = url.split("?")[0].split("#")[0];
  const match = /^([a-zA-Z][\w+.-]*:\/\/[^/]+)(\/.*)?$/.exec(withoutQuery);
  if (!match) {
    // A relative URL, or one that starts with a {{variable}} — there is no
    // origin to lift out, so the whole thing becomes the path.
    return { origin: "", path: withoutQuery || "/" };
  }
  return { origin: match[1], path: match[2] || "/" };
}

/**
 * OpenAPI paths are templates, so a literal id in a URL becomes a parameter.
 * Only segments that are obviously identifiers are converted: a number, a UUID,
 * or an existing `{{variable}}`. Guessing more aggressively would turn real
 * path segments into parameters and produce a document that describes nothing.
 */
function templatePath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const segments = path.split("/").map((segment) => {
    if (segment === "") return segment;
    const variable = /^\{\{\s*([\w.\-$]+)\s*\}\}$/.exec(segment);
    if (variable) {
      params.push(variable[1]);
      return `{${variable[1]}}`;
    }
    if (/^\d+$/.test(segment)) {
      params.push("id");
      return "{id}";
    }
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
    ) {
      params.push("uuid");
      return "{uuid}";
    }
    return segment;
  });
  return { path: segments.join("/") || "/", params };
}

function exampleBody(request: SavedRequest): unknown {
  if (request.config.bodyMode === "raw" && request.config.rawLanguage === "json") {
    try {
      return JSON.parse(request.body);
    } catch {
      return request.body;
    }
  }
  return request.body;
}

function requestBodyFor(request: SavedRequest) {
  const config = request.config;
  switch (config.bodyMode) {
    case "raw": {
      const type =
        config.rawLanguage === "json"
          ? "application/json"
          : config.rawLanguage === "xml"
            ? "application/xml"
            : config.rawLanguage === "html"
              ? "text/html"
              : config.rawLanguage === "javascript"
                ? "application/javascript"
                : "text/plain";
      return {
        content: {
          [type]: {
            // A schema cannot be inferred from one example without inventing
            // constraints, so the example is given and the schema left open.
            schema: { type: "object" },
            example: exampleBody(request),
          },
        },
      };
    }
    case "urlEncoded":
      return {
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                activeRows(config.urlEncoded).map((row) => [
                  row.name,
                  { type: "string", example: row.value },
                ]),
              ),
            },
          },
        },
      };
    case "formData":
      return {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                activeRows(config.formData).map((row) => [
                  row.name,
                  row.kind === "file"
                    ? { type: "string", format: "binary" }
                    : { type: "string", example: row.value },
                ]),
              ),
            },
          },
        },
      };
    case "graphql":
      return {
        content: {
          "application/json": {
            schema: { type: "object" },
            example: {
              query: config.graphqlQuery,
              variables: config.graphqlVariables,
            },
          },
        },
      };
    default:
      return undefined;
  }
}

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

/**
 * An OpenAPI 3.1 document describing the collection.
 *
 * This is the lossiest of the exports and cannot be otherwise: OpenAPI
 * describes an API, while a collection is a set of example calls. Schemas are
 * left open rather than inferred from a single body, because a schema guessed
 * from one example states constraints nobody verified.
 */
export function toOpenApi(
  workspace: string,
  tree: TreeNode[],
): InteropExport {
  const warnings: string[] = [];
  const paths: Record<string, Record<string, unknown>> = {};
  const servers = new Map<string, true>();
  const securitySchemes: Record<string, unknown> = {};
  let skipped = 0;

  for (const { request, trail } of walkRequests(tree)) {
    const method = request.method.toLowerCase();
    if (!HTTP_METHODS.has(method)) {
      skipped += 1;
      continue;
    }
    if (request.config.protocol !== "rest" && request.config.protocol !== "graphql") {
      skipped += 1;
      continue;
    }
    if (request.url.trim() === "") {
      skipped += 1;
      continue;
    }

    const { origin, path } = splitUrl(request.url);
    if (origin) servers.set(origin, true);
    const templated = templatePath(path);

    const query = parseQuery(request.url)
      .filter((row) => row.name.trim() !== "" && row.enabled !== false)
      .map((row) => ({
        name: row.name,
        in: "query",
        required: false,
        ...(row.description ? { description: row.description } : {}),
        schema: { type: "string" },
        example: row.value,
      }));

    const headers = request.headers
      .filter(
        (header) =>
          header.name.trim() !== "" &&
          header.enabled !== false &&
          // Content-Type is described by the requestBody's media type, and
          // Authorization by the security scheme.
          !["content-type", "authorization"].includes(header.name.toLowerCase()),
      )
      .map((header) => ({
        name: header.name,
        in: "header",
        required: false,
        ...(header.description ? { description: header.description } : {}),
        schema: { type: "string" },
        example: header.value,
      }));

    const pathParams = [...new Set(templated.params)].map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    // Auth becomes a named security scheme, referenced by the operation.
    const auth = request.config.auth;
    let security: unknown[] | undefined;
    if (auth.type === "bearer") {
      securitySchemes.bearerAuth = { type: "http", scheme: "bearer" };
      security = [{ bearerAuth: [] }];
    } else if (auth.type === "basic") {
      securitySchemes.basicAuth = { type: "http", scheme: "basic" };
      security = [{ basicAuth: [] }];
    } else if (auth.type === "apiKey" && auth.key.trim() !== "") {
      securitySchemes.apiKeyAuth = {
        type: "apiKey",
        name: auth.key,
        in: auth.addTo === "query" ? "query" : "header",
      };
      security = [{ apiKeyAuth: [] }];
    } else if (auth.type === "oauth2") {
      const oauth = auth.oauth2;
      const flows: Record<string, unknown> = {};
      const scopes = Object.fromEntries(
        oauth.scope
          .split(/\s+/)
          .filter(Boolean)
          .map((scope) => [scope, ""]),
      );
      if (oauth.grant === "authorizationCode") {
        flows.authorizationCode = {
          authorizationUrl: oauth.authorizeUrl,
          tokenUrl: oauth.tokenUrl,
          scopes,
        };
      } else if (oauth.grant === "clientCredentials") {
        flows.clientCredentials = { tokenUrl: oauth.tokenUrl, scopes };
      } else if (oauth.grant === "password") {
        flows.password = { tokenUrl: oauth.tokenUrl, scopes };
      } else {
        // RFC 8628 has no OpenAPI flow object.
        warnings.push(
          "The device code grant has no OpenAPI flow type, so those requests are described without a security scheme.",
        );
      }
      if (Object.keys(flows).length > 0) {
        securitySchemes.oauth2 = { type: "oauth2", flows };
        security = [{ oauth2: Object.keys(scopes) }];
      }
    }

    const operation: Record<string, unknown> = {
      summary: request.name,
      ...(trail.length > 0 ? { tags: [trail[trail.length - 1]] } : {}),
      ...(request.config.docs.trim() !== ""
        ? { description: request.config.docs }
        : {}),
      // Nothing here records what a response looks like, and OpenAPI requires
      // the field, so it is declared present and undescribed.
      responses: {
        default: { description: "Not captured by the export." },
      },
    };

    const parameters = [...pathParams, ...query, ...headers];
    if (parameters.length > 0) operation.parameters = parameters;
    const body = requestBodyFor(request);
    if (body) operation.requestBody = body;
    if (security) operation.security = security;

    paths[templated.path] = { ...(paths[templated.path] ?? {}), [method]: operation };
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} request${skipped === 1 ? "" : "s"} left out: OpenAPI describes HTTP operations, so WebSocket, MQTT, gRPC, SSE and Socket.IO requests have no place in it.`,
    );
  }
  warnings.push(
    "Request and response schemas are left open. A schema inferred from one example would assert constraints nobody has checked.",
  );

  const document = {
    openapi: "3.1.0",
    info: {
      title: workspace,
      version: "1.0.0",
      description: `Exported from APIKit on ${new Date().toISOString().slice(0, 10)}.`,
    },
    ...(servers.size > 0
      ? { servers: [...servers.keys()].map((url) => ({ url })) }
      : {}),
    paths,
    ...(Object.keys(securitySchemes).length > 0
      ? { components: { securitySchemes } }
      : {}),
  };

  return {
    text: `${JSON.stringify(document, null, 2)}\n`,
    filename: `${slug(workspace)}.openapi.json`,
    warnings: [...new Set(warnings)],
  };
}
