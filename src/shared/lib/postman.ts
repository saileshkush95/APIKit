// Postman collection import (v2 / v2.1).
//
// Postman's model maps closely onto this app's: items nest like folders,
// `{{variables}}` are already the same syntax, and auth/body modes have direct
// equivalents. Test scripts are JavaScript against `pm.*`, which does not exist
// here — they are carried into the request's post-response script commented
// out, so nothing is silently lost.

import { newId } from "./storage";
import {
  defaultConfig,
  type Auth,
  type KeyValue,
  type SavedRequest,
  type TreeNode,
} from "../types";

export interface PostmanImport {
  title: string;
  nodes: TreeNode[];
  variables: KeyValue[];
  warnings: string[];
  requestCount: number;
}

type Item = Record<string, any>;

function isCollection(spec: Record<string, any>): boolean {
  return Array.isArray(spec?.item) && spec?.info !== undefined;
}

/** Postman stores a URL either as a string or as a structured object. */
function urlOf(raw: any): string {
  if (typeof raw === "string") return raw;
  if (!raw) return "";
  if (typeof raw.raw === "string" && raw.raw !== "") return raw.raw;

  const host = Array.isArray(raw.host) ? raw.host.join(".") : (raw.host ?? "");
  const path = Array.isArray(raw.path) ? raw.path.join("/") : (raw.path ?? "");
  const protocol = raw.protocol ? `${raw.protocol}://` : "";
  const query = Array.isArray(raw.query)
    ? raw.query
        .filter((entry: any) => !entry.disabled)
        .map((entry: any) => `${entry.key}=${entry.value ?? ""}`)
        .join("&")
    : "";
  return `${protocol}${host}${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
}

function headersOf(raw: any): KeyValue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((header: any) => !header.disabled)
    .map((header: any) => ({
      name: String(header.key ?? ""),
      value: String(header.value ?? ""),
    }));
}

function authOf(raw: any, warnings: string[]): Auth | null {
  if (!raw?.type) return null;
  const base = defaultConfig().auth;
  // Postman stores each scheme's fields as an array of {key, value}.
  const field = (list: any[], key: string) =>
    String(list?.find((entry: any) => entry.key === key)?.value ?? "");

  switch (raw.type) {
    case "bearer":
      return { ...base, type: "bearer", token: field(raw.bearer, "token") };
    case "basic":
      return {
        ...base,
        type: "basic",
        username: field(raw.basic, "username"),
        password: field(raw.basic, "password"),
      };
    case "apikey":
      return {
        ...base,
        type: "apiKey",
        key: field(raw.apikey, "key") || "X-API-Key",
        value: field(raw.apikey, "value"),
        addTo: field(raw.apikey, "in") === "query" ? "query" : "header",
      };
    case "noauth":
      return base;
    default:
      warnings.push(
        `Auth type "${raw.type}" has no equivalent here; set it manually.`,
      );
      return null;
  }
}

function scriptOf(item: Item, kind: "prerequest" | "test"): string {
  const events = Array.isArray(item.event) ? item.event : [];
  const event = events.find((entry: any) => entry.listen === kind);
  const source = event?.script?.exec;
  if (!source) return "";
  return Array.isArray(source) ? source.join("\n") : String(source);
}

/** Postman scripts use `pm.*`; keep them as commented reference, not code. */
function portScript(source: string, kind: string): string {
  if (source.trim() === "") return "";
  return [
    `// Imported from Postman (${kind}). Postman's pm.* API is not available`,
    "// here — rewrite using wrk.* (see the Scripts tab help), then uncomment.",
    ...source.split("\n").map((line) => `// ${line}`),
  ].join("\n");
}

function requestFrom(item: Item, warnings: string[]): SavedRequest {
  const raw = item.request ?? {};
  const config = defaultConfig();

  const auth = authOf(raw.auth, warnings);
  if (auth) config.auth = auth;

  const body = raw.body ?? {};
  let bodyText = "";
  switch (body.mode) {
    case "raw":
      config.bodyMode = "raw";
      config.rawLanguage =
        body.options?.raw?.language === "xml"
          ? "xml"
          : body.options?.raw?.language === "text"
            ? "text"
            : "json";
      bodyText = String(body.raw ?? "");
      break;
    case "urlencoded":
      config.bodyMode = "urlEncoded";
      config.urlEncoded = (body.urlencoded ?? [])
        .filter((entry: any) => !entry.disabled)
        .map((entry: any) => ({
          name: String(entry.key ?? ""),
          value: String(entry.value ?? ""),
        }));
      break;
    case "formdata":
      config.bodyMode = "formData";
      config.formData = (body.formdata ?? [])
        .filter((entry: any) => !entry.disabled)
        .map((entry: any) => ({
          name: String(entry.key ?? ""),
          value: String(entry.value ?? ""),
          kind: entry.type === "file" ? ("file" as const) : ("text" as const),
          filePath: entry.type === "file" ? String(entry.src ?? "") : "",
        }));
      break;
    case "graphql":
      config.bodyMode = "graphql";
      config.protocol = "graphql";
      config.graphqlQuery = String(body.graphql?.query ?? "");
      config.graphqlVariables = String(body.graphql?.variables ?? "{}");
      break;
    default:
      if (body.mode) {
        warnings.push(
          `${item.name}: body mode "${body.mode}" is not supported; left empty.`,
        );
      }
  }

  config.preScript = portScript(scriptOf(item, "prerequest"), "pre-request");
  config.postScript = portScript(scriptOf(item, "test"), "tests");
  config.docs =
    typeof raw.description === "string"
      ? raw.description
      : (raw.description?.content ?? "");

  return {
    kind: "request",
    id: newId(),
    name: String(item.name ?? "Untitled"),
    method: String(raw.method ?? "GET").toUpperCase(),
    url: urlOf(raw.url),
    headers: [...headersOf(raw.header), { name: "", value: "" }],
    body: bodyText,
    tests: [],
    config,
  };
}

function walk(items: Item[], warnings: string[], counter: { n: number }): TreeNode[] {
  return (items ?? []).map((item) => {
    if (Array.isArray(item.item)) {
      return {
        kind: "folder" as const,
        id: newId(),
        name: String(item.name ?? "Folder"),
        children: walk(item.item, warnings, counter),
      };
    }
    counter.n += 1;
    return requestFrom(item, warnings);
  });
}

export function importPostman(text: string): PostmanImport {
  const spec = JSON.parse(text) as Record<string, any>;
  if (!isCollection(spec)) {
    throw new Error(
      "not a Postman collection — export as Collection v2.1 and try again",
    );
  }

  const warnings: string[] = [];
  const counter = { n: 0 };
  const nodes = walk(spec.item, warnings, counter);

  const variables: KeyValue[] = [
    ...(spec.variable ?? []).map((entry: any) => ({
      name: String(entry.key ?? ""),
      value: String(entry.value ?? ""),
    })),
    { name: "", value: "" },
  ];

  const collectionAuth = authOf(spec.auth, warnings);
  if (collectionAuth && collectionAuth.type !== "none") {
    warnings.push(
      "Collection-level auth was imported onto requests that had none of their own.",
    );
    const applyAuth = (list: TreeNode[]) => {
      for (const node of list) {
        if (node.kind === "folder") applyAuth(node.children);
        else if (node.config.auth.type === "none") node.config.auth = collectionAuth;
      }
    };
    applyAuth(nodes);
  }

  if (nodes.length === 0) {
    throw new Error("the collection has no requests");
  }

  return {
    title: String(spec.info?.name ?? "Postman collection"),
    nodes,
    variables,
    warnings,
    requestCount: counter.n,
  };
}

/** Detects which importer a pasted document needs. */
export function detectFormat(text: string): "postman" | "openapi" {
  try {
    const parsed = JSON.parse(text);
    if (isCollection(parsed)) return "postman";
  } catch {
    // YAML is always OpenAPI in practice.
  }
  return "openapi";
}
