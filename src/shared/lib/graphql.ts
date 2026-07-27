// GraphQL schema introspection: fetches the schema behind an endpoint so the
// editor can suggest fields and show the server's own documentation.

import { sendRequest } from "./api";
import type { Header } from "../types";

/** Trimmed introspection query — types, fields, args and descriptions only. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: false) {
        name
        description
        args { name description type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } }
      enumValues(includeDeprecated: false) { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

export interface SchemaField {
  name: string;
  description: string | null;
  type: string;
  args: { name: string; type: string; description: string | null }[];
}

export interface SchemaType {
  kind: string;
  name: string;
  description: string | null;
  fields: SchemaField[];
  enumValues: { name: string; description: string | null }[];
}

export interface GraphqlSchema {
  queryType: string | null;
  mutationType: string | null;
  subscriptionType: string | null;
  types: SchemaType[];
}

/** Renders a nested type reference as `[Foo!]!`. */
export function formatType(ref: TypeRef | null | undefined): string {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${formatType(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${formatType(ref.ofType)}]`;
  return ref.name ?? "Unknown";
}

function parseSchema(raw: unknown): GraphqlSchema | null {
  const schema = (raw as { data?: { __schema?: Record<string, unknown> } })?.data
    ?.__schema;
  if (!schema) return null;

  const types = ((schema.types as Record<string, unknown>[]) ?? [])
    // Introspection meta-types are noise for someone writing a query.
    .filter((type) => !String(type.name ?? "").startsWith("__"))
    .map<SchemaType>((type) => ({
      kind: String(type.kind ?? ""),
      name: String(type.name ?? ""),
      description: (type.description as string) ?? null,
      fields: (((type.fields ?? type.inputFields) as Record<string, unknown>[]) ?? []).map(
        (field) => ({
          name: String(field.name ?? ""),
          description: (field.description as string) ?? null,
          type: formatType(field.type as TypeRef),
          args: ((field.args as Record<string, unknown>[]) ?? []).map((arg) => ({
            name: String(arg.name ?? ""),
            type: formatType(arg.type as TypeRef),
            description: (arg.description as string) ?? null,
          })),
        }),
      ),
      enumValues: ((type.enumValues as Record<string, unknown>[]) ?? []).map(
        (value) => ({
          name: String(value.name ?? ""),
          description: (value.description as string) ?? null,
        }),
      ),
    }));

  const named = (key: string) =>
    ((schema[key] as { name?: string } | null)?.name ?? null) as string | null;

  return {
    queryType: named("queryType"),
    mutationType: named("mutationType"),
    subscriptionType: named("subscriptionType"),
    types,
  };
}

export async function introspect(
  url: string,
  headers: Header[],
  options: { timeoutMs: number; verifyTls: boolean },
): Promise<GraphqlSchema> {
  const response = await sendRequest({
    method: "POST",
    url,
    headers: [
      { name: "Content-Type", value: "application/json" },
      ...headers.filter((header) => header.name.trim() !== ""),
    ],
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    timeoutMs: options.timeoutMs,
    verifyTls: options.verifyTls,
  });

  if (response.status >= 400) {
    throw new Error(`introspection returned ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("endpoint did not return JSON");
  }

  const errors = (parsed as { errors?: { message: string }[] }).errors;
  if (errors?.length) {
    throw new Error(errors[0].message);
  }

  const schema = parseSchema(parsed);
  if (!schema) throw new Error("no schema in the introspection response");
  return schema;
}

export function typeByName(
  schema: GraphqlSchema,
  name: string | null,
): SchemaType | null {
  if (!name) return null;
  return schema.types.find((type) => type.name === name) ?? null;
}

/** Root operation types, in the order the editor should offer them. */
export function rootTypes(
  schema: GraphqlSchema,
): { label: string; type: SchemaType }[] {
  return (
    [
      ["Query", schema.queryType],
      ["Mutation", schema.mutationType],
      ["Subscription", schema.subscriptionType],
    ] as const
  ).flatMap(([label, name]) => {
    const type = typeByName(schema, name);
    return type ? [{ label, type }] : [];
  });
}

/** Every field name in the schema, for editor suggestions. */
export function suggestionIndex(schema: GraphqlSchema): SchemaField[] {
  const seen = new Set<string>();
  const out: SchemaField[] = [];
  for (const type of schema.types) {
    for (const field of type.fields) {
      if (!seen.has(field.name)) {
        seen.add(field.name);
        out.push(field);
      }
    }
  }
  return out;
}

/** Markdown summary of the schema, used to seed a request's Docs tab. */
/**
 * Formats a query: every brace boundary on its own line, two-space indent.
 * Strings, comments and argument lists are left untouched, and fields the
 * user grouped on one line stay grouped — only the structure is normalized.
 */
export function beautifyGraphql(source: string): string {
  // Pass 1: give each brace its own line.
  let exploded = "";
  let inString = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inComment) {
      exploded += ch;
      if (ch === "\n") inComment = false;
      continue;
    }
    if (inString) {
      exploded += ch;
      if (ch === "\\") exploded += source[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      exploded += ch;
    } else if (ch === "#") {
      inComment = true;
      exploded += ch;
    } else if (ch === "{") {
      exploded += `${/(^|[\s(])$/.test(exploded.slice(-1)) ? "" : " "}{\n`;
    } else if (ch === "}") {
      exploded += "\n}\n";
    } else if (ch === " " || ch === "\t") {
      // Runs of blanks collapse to one space.
      if (!/[\s]$/.test(exploded.slice(-1)) && exploded !== "") exploded += " ";
    } else {
      exploded += ch;
    }
  }

  // Pass 2: trim and re-indent by bracket depth. Parentheses count too, so a
  // multi-line argument list indents like a block.
  let depth = 0;
  const lines: string[] = [];
  for (const raw of exploded.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const leadingClosers = /^[}\])]+/.exec(line)?.[0].length ?? 0;
    lines.push("  ".repeat(Math.max(0, depth - leadingClosers)) + line);
    let net = 0;
    let str = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (str) {
        if (ch === "\\") i++;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "#") break;
      else if (ch === "{" || ch === "(" || ch === "[") net++;
      else if (ch === "}" || ch === ")" || ch === "]") net--;
    }
    depth = Math.max(0, depth + net);
  }
  return lines.join("\n");
}

export function schemaToMarkdown(schema: GraphqlSchema): string {
  const lines: string[] = ["# Schema", ""];
  for (const { label, type } of rootTypes(schema)) {
    lines.push(`## ${label}`, "");
    for (const field of type.fields) {
      const args = field.args
        .map((arg) => `${arg.name}: ${arg.type}`)
        .join(", ");
      lines.push(`- \`${field.name}${args ? `(${args})` : ""}: ${field.type}\``);
      if (field.description) lines.push(`  ${field.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
