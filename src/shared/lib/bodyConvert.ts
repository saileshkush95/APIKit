// Converting a body between form rows and raw JSON.
//
// Values stay strings in both directions: coercing "0123" into a number or
// "true" into a boolean would silently change what gets sent, and `{{var}}`
// placeholders only survive as strings.

import type { KeyValue } from "../types";

/** Form rows → a pretty-printed JSON object body. */
export function rowsToJson(rows: KeyValue[]): {
  json: string;
  skippedFiles: number;
} {
  const result: Record<string, unknown> = {};
  let skippedFiles = 0;
  for (const row of rows) {
    if (row.name.trim() === "") continue;
    if (row.kind === "file") {
      skippedFiles += 1;
      continue;
    }
    const existing = result[row.name];
    if (existing === undefined) {
      result[row.name] = row.value;
    } else if (Array.isArray(existing)) {
      existing.push(row.value);
    } else {
      // A repeated key becomes an array, as it would in a query string.
      result[row.name] = [existing, row.value];
    }
  }
  return { json: JSON.stringify(result, null, 2), skippedFiles };
}

/**
 * A raw JSON object body → form rows. Nested objects and arrays cannot be
 * a single form field, so they are kept as compact JSON strings.
 * Throws with a readable message when the body cannot be converted.
 */
export function jsonToRows(body: string): KeyValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim() === "" ? "{}" : body);
  } catch {
    throw new Error("The body is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Only a top-level JSON object can become form fields.");
  }

  const rows: KeyValue[] = Object.entries(parsed).map(([name, value]) => ({
    name,
    value:
      typeof value === "string"
        ? value
        : value === null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value),
  }));
  // The editor always keeps one trailing blank row.
  rows.push({ name: "", value: "" });
  return rows;
}
