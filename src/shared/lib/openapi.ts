// OpenAPI / Swagger import.
//
// Turns a spec into the same shapes the app already uses: a folder per tag,
// a request per operation with its parameters, an example body derived from the
// schema, the operation's description as Docs, an environment holding the
// server URL, and the spec's security scheme mapped onto request auth.

import yaml from "js-yaml";
import { newId } from "./storage";
import {
  defaultConfig,
  type Auth,
  type Folder,
  type KeyValue,
  type SavedRequest,
  type TreeNode,
} from "../types";

export interface ImportResult {
  title: string;
  nodes: TreeNode[];
  variables: KeyValue[];
  auth: Auth;
  /** Human-readable notes about anything that could not be represented. */
  warnings: string[];
  operationCount: number;
}

type Spec = Record<string, any>;

export function parseSpec(text: string): Spec {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("the document is empty");
  // JSON is valid YAML, but parsing JSON first gives better error messages.
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Spec;
  }
  const parsed = yaml.load(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("could not parse the document as JSON or YAML");
  }
  return parsed as Spec;
}

/** Resolves a local `$ref`; remote refs are not followed. */
function resolveRef(spec: Spec, node: any, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 20) return node;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  const target = ref
    .slice(2)
    .split("/")
    .reduce<any>((cursor, key) => cursor?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  return resolveRef(spec, target, depth + 1);
}

/** Builds a representative example value for a schema. */
function exampleFor(spec: Spec, schema: any, depth = 0): unknown {
  const resolved = resolveRef(spec, schema);
  if (!resolved || depth > 6) return null;
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length) return resolved.enum[0];

  const type = resolved.type ?? (resolved.properties ? "object" : undefined);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resolved.properties ?? {})) {
        out[key] = exampleFor(spec, value, depth + 1);
      }
      return out;
    }
    case "array":
      return [exampleFor(spec, resolved.items, depth + 1)].filter(
        (item) => item !== null,
      );
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      if (resolved.format === "date-time") return new Date(0).toISOString();
      if (resolved.format === "uuid") return "00000000-0000-0000-0000-000000000000";
      return "";
    default:
      return null;
  }
}

function serverUrl(spec: Spec): string {
  // OpenAPI 3 lists servers; Swagger 2 splits host/basePath/schemes.
  const fromServers = spec.servers?.[0]?.url;
  if (typeof fromServers === "string" && fromServers !== "") {
    const variables = spec.servers[0].variables ?? {};
    return fromServers.replace(/\{(\w+)\}/g, (match: string, name: string) =>
      variables[name]?.default != null ? String(variables[name].default) : match,
    );
  }
  if (typeof spec.host === "string") {
    const scheme = spec.schemes?.[0] ?? "https";
    return `${scheme}://${spec.host}${spec.basePath ?? ""}`;
  }
  return "";
}

/** Maps the first usable security scheme onto the app's auth model. */
function specAuth(spec: Spec, warnings: string[]): Auth {
  const auth = defaultConfig().auth;
  const schemes: Record<string, any> =
    spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};

  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = resolveRef(spec, raw);
    const type = String(scheme?.type ?? "").toLowerCase();

    if (type === "http" && String(scheme.scheme).toLowerCase() === "bearer") {
      return { ...auth, type: "bearer", token: "{{token}}" };
    }
    if (type === "http" && String(scheme.scheme).toLowerCase() === "basic") {
      return { ...auth, type: "basic", username: "{{username}}", password: "{{password}}" };
    }
    if (type === "apikey") {
      return {
        ...auth,
        type: "apiKey",
        key: String(scheme.name ?? "X-API-Key"),
        value: "{{apiKey}}",
        addTo: scheme.in === "query" ? "query" : "header",
      };
    }
    if (type === "oauth2" || type === "openidconnect") {
      warnings.push(
        `Security scheme "${name}" is ${type}; imported as a bearer token — paste an access token into the {{token}} variable.`,
      );
      return { ...auth, type: "bearer", token: "{{token}}" };
    }
  }
  return auth;
}

function pathToTitle(path: string): string {
  return path === "/" ? "root" : path.replace(/^\//, "").split("/")[0] || "root";
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function importOpenApi(text: string): ImportResult {
  const spec = parseSpec(text);
  const warnings: string[] = [];

  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error("no `paths` section — is this an OpenAPI document?");
  }

  const base = serverUrl(spec);
  if (base === "") {
    warnings.push("No server URL in the spec; set {{baseUrl}} yourself.");
  }
  const auth = specAuth(spec, warnings);

  // One folder per tag keeps the sidebar close to how the API documents itself.
  const folders = new Map<string, Folder>();
  const loose: SavedRequest[] = [];
  let operationCount = 0;

  for (const [path, rawItem] of Object.entries<any>(spec.paths)) {
    const item = resolveRef(spec, rawItem);
    const shared = (item.parameters ?? []) as any[];

    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      operationCount += 1;

      const parameters = [...shared, ...(operation.parameters ?? [])].map((p) =>
        resolveRef(spec, p),
      );

      const query: KeyValue[] = [];
      const headers: KeyValue[] = [];
      let url = `{{baseUrl}}${path}`;

      for (const parameter of parameters) {
        const example = exampleFor(spec, parameter.schema ?? parameter);
        const value =
          example === null || example === undefined || typeof example === "object"
            ? `{{${parameter.name}}}`
            : String(example);

        if (parameter.in === "query") {
          query.push({ name: parameter.name, value });
        } else if (parameter.in === "header") {
          headers.push({ name: parameter.name, value });
        } else if (parameter.in === "path") {
          // Path placeholders become variables so they are obvious and editable.
          url = url.replace(`{${parameter.name}}`, `{{${parameter.name}}}`);
        }
      }

      if (query.length) {
        const search = query
          .map((p) => `${encodeURIComponent(p.name)}=${p.value}`)
          .join("&");
        url = `${url}?${search}`;
      }

      const config = defaultConfig();
      config.auth = auth;

      // Request body → a raw JSON example.
      const body = resolveRef(spec, operation.requestBody);
      const jsonContent =
        body?.content?.["application/json"] ??
        body?.content?.["application/x-www-form-urlencoded"];
      if (jsonContent) {
        config.bodyMode = "raw";
        config.rawLanguage = "json";
      } else if (body?.content) {
        warnings.push(
          `${method.toUpperCase()} ${path} uses ${Object.keys(body.content).join(", ")}; body left empty.`,
        );
      }

      const docs = [
        `# ${operation.summary ?? `${method.toUpperCase()} ${path}`}`,
        "",
        operation.description ?? "",
        parameters.length ? "\n## Parameters\n" : "",
        ...parameters.map(
          (parameter) =>
            `- \`${parameter.name}\` (${parameter.in})${
              parameter.required ? " — required" : ""
            }${parameter.description ? ` — ${parameter.description}` : ""}`,
        ),
        operation.responses ? "\n## Responses\n" : "",
        ...Object.entries<any>(operation.responses ?? {}).map(
          ([code, response]) =>
            `- \`${code}\` — ${resolveRef(spec, response)?.description ?? ""}`,
        ),
      ]
        .filter((line) => line !== "")
        .join("\n");
      config.docs = docs;

      const request: SavedRequest = {
        kind: "request",
        id: newId(),
        name: operation.summary || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url,
        headers: [...headers, { name: "", value: "" }],
        body: jsonContent
          ? JSON.stringify(exampleFor(spec, jsonContent.schema), null, 2)
          : "",
        tests: [],
        config,
      };

      const tag = operation.tags?.[0] ?? pathToTitle(path);
      const existing = folders.get(tag);
      if (existing) {
        existing.children.push(request);
      } else {
        folders.set(tag, {
          kind: "folder",
          id: newId(),
          name: tag,
          children: [request],
        });
      }
    }
  }

  const variables: KeyValue[] = [
    { name: "baseUrl", value: base },
    ...(auth.type === "bearer" ? [{ name: "token", value: "" }] : []),
    ...(auth.type === "apiKey" ? [{ name: "apiKey", value: "" }] : []),
    ...(auth.type === "basic"
      ? [
          { name: "username", value: "" },
          { name: "password", value: "" },
        ]
      : []),
    { name: "", value: "" },
  ];

  return {
    title: spec.info?.title ?? "Imported API",
    nodes: [...folders.values(), ...loose],
    variables,
    auth,
    warnings,
    operationCount,
  };
}
