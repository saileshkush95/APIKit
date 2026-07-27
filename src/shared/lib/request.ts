// Turns the builder state (body mode, auth, variables) into the concrete
// method/url/headers/body that go over the wire.

import { applyQuery, parseQuery } from "./query";
import { folderPathTo } from "./tree";
import { interpolate, resolveDraft, type VarMap, type WireRequest } from "./vars";
import type { Auth, KeyValue, MultipartPart, RequestDraft, TreeNode } from "../types";

/**
 * Resolves an "inherit" auth against the nearest ancestor folder that defines
 * one. Folders set to "inherit" keep the walk going, "none" counts as unset;
 * with no ancestor defining auth (or an unsaved request) nothing is applied.
 */
export function resolveAuth(
  tree: TreeNode[],
  nodeId: string | null,
  auth: Auth,
): Auth {
  if (auth.type !== "inherit") return auth;
  if (nodeId) {
    const ancestors = folderPathTo(tree, nodeId);
    if (ancestors) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const parent = ancestors[i].auth;
        if (parent && parent.type !== "inherit" && parent.type !== "none") {
          return parent;
        }
      }
    }
  }
  return { ...auth, type: "none" };
}

/** A wire request that may carry a multipart or file body instead of text. */
export interface BuiltRequest extends WireRequest {
  multipart?: MultipartPart[];
  /** A file the backend streams as the whole body, in `binary` mode. */
  bodyFilePath?: string;
}

function activeRows(rows: KeyValue[]): KeyValue[] {
  return rows.filter((row) => row.name.trim() !== "");
}

function urlEncode(rows: KeyValue[]): string {
  return activeRows(rows)
    .map(
      (row) =>
        `${encodeURIComponent(row.name)}=${encodeURIComponent(row.value)}`,
    )
    .join("&");
}

function setHeader(headers: KeyValue[], name: string, value: string): KeyValue[] {
  const exists = headers.some(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  // A header the user typed themselves always wins over a generated one.
  return exists ? headers : [...headers, { name, value }];
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
};

/**
 * Assembles the request: body per the selected mode, auth applied, then
 * `{{variables}}` substituted across every field.
 */
export function buildWireRequest(
  draft: RequestDraft,
  vars: VarMap,
): BuiltRequest {
  const { config } = draft;
  let headers = activeRows(draft.headers);
  let url = draft.url;
  let body = "";
  let multipart: MultipartPart[] | undefined;
  let bodyFilePath: string | undefined;

  switch (config.bodyMode) {
    case "raw":
      body = draft.body;
      headers = setHeader(
        headers,
        "Content-Type",
        RAW_CONTENT_TYPES[config.rawLanguage] ?? "text/plain",
      );
      break;
    case "urlEncoded":
      body = urlEncode(config.urlEncoded);
      headers = setHeader(
        headers,
        "Content-Type",
        "application/x-www-form-urlencoded",
      );
      break;
    case "formData":
      // The backend builds the multipart body so file parts stay binary-exact,
      // and it sets its own Content-Type with the boundary.
      multipart = activeRows(config.formData).map((row) => ({
        name: interpolate(row.name, vars),
        value: interpolate(row.value, vars),
        filePath: row.kind === "file" ? row.filePath || null : null,
      }));
      break;
    case "graphql": {
      let variables: Record<string, unknown> = {};
      try {
        variables = config.graphqlVariables.trim()
          ? JSON.parse(config.graphqlVariables)
          : {};
      } catch {
        // Malformed variables are sent as an empty object rather than failing
        // the whole request; the server error is more informative.
        variables = {};
      }

      const files = (config.graphqlFiles ?? []).filter(
        (file) => file.variable.trim() !== "" && file.filePath.trim() !== "",
      );

      if (files.length > 0) {
        // GraphQL multipart request spec: an `operations` part with null
        // placeholders, a `map` part pointing at them, then the files.
        for (const file of files) {
          setVariablePath(variables, file.variable, null);
        }
        const map: Record<string, string[]> = {};
        files.forEach((file, index) => {
          map[String(index)] = [`variables.${file.variable}`];
        });
        multipart = [
          {
            name: "operations",
            value: JSON.stringify({
              query: config.graphqlQuery,
              variables,
            }),
            contentType: "application/json",
          },
          { name: "map", value: JSON.stringify(map), contentType: "application/json" },
          ...files.map((file, index) => ({
            name: String(index),
            value: "",
            filePath: file.filePath,
          })),
        ];
      } else {
        body = JSON.stringify({ query: config.graphqlQuery, variables });
        headers = setHeader(headers, "Content-Type", "application/json");
      }
      break;
    }
    case "binary":
      body = "";
      // The path is not interpolated: a file name is a local path, not a
      // value the environment should be rewriting.
      if (config.binaryFilePath.trim() !== "") {
        bodyFilePath = config.binaryFilePath;
      }
      break;
    case "none":
      body = "";
      break;
  }

  // Auth is layered on top so it can add either a header or a query param.
  const auth = config.auth;
  if (auth.type === "bearer" && auth.token.trim() !== "") {
    headers = [...headers, { name: "Authorization", value: `Bearer ${auth.token}` }];
  } else if (auth.type === "basic" && auth.username.trim() !== "") {
    const encoded = btoa(
      `${interpolate(auth.username, vars)}:${interpolate(auth.password, vars)}`,
    );
    headers = [...headers, { name: "Authorization", value: `Basic ${encoded}` }];
  } else if (auth.type === "apiKey" && auth.key.trim() !== "") {
    if (auth.addTo === "header") {
      headers = [...headers, { name: auth.key, value: auth.value }];
    } else {
      url = applyQuery(url, [
        ...parseQuery(url),
        { name: auth.key, value: auth.value },
      ]);
    }
  }

  const resolved = resolveDraft({ method: draft.method, url, headers, body }, vars);
  if (multipart) return { ...resolved, multipart };
  if (bodyFilePath) return { ...resolved, bodyFilePath };
  return resolved;
}

/** Writes `value` at a dotted path inside a variables object. */
function setVariablePath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const steps = path.split(".").filter((step) => step !== "");
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    if (typeof cursor[step] !== "object" || cursor[step] === null) {
      cursor[step] = {};
    }
    cursor = cursor[step] as Record<string, unknown>;
  }
  const last = steps[steps.length - 1];
  if (last) cursor[last] = value;
}

/** Upgrades a URL to its secure scheme when "force secure" is enabled. */
export function enforceSecureUrl(url: string, enabled: boolean): string {
  if (!enabled) return url;
  return url
    .replace(/^http:\/\//i, "https://")
    .replace(/^ws:\/\//i, "wss://")
    .replace(/^mqtt:\/\//i, "mqtts://");
}

/** Pretty-prints the raw body for the Beautify action. */
export function beautify(body: string, language: string): string {
  if (language === "json") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (language === "xml" || language === "html") {
    // Indentation by tag depth — enough to make a one-line document readable.
    let depth = 0;
    return body
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("</")) depth = Math.max(0, depth - 1);
        const indented = `${"  ".repeat(depth)}${trimmed}`;
        if (
          trimmed.startsWith("<") &&
          !trimmed.startsWith("</") &&
          !trimmed.endsWith("/>") &&
          !trimmed.startsWith("<?") &&
          !trimmed.includes("</")
        ) {
          depth += 1;
        }
        return indented;
      })
      .join("\n");
  }
  return body;
}
