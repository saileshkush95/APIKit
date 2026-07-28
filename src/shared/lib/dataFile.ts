// Data files for the collection runner: one iteration per row, each row's
// columns exposed as variables.
//
// CSV and JSON only — the two formats people actually have. Every value ends up
// a string, because that is what variable substitution produces anyway.

export interface DataSet {
  /** Column names, in file order. */
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * RFC 4180-ish CSV: quoted fields may hold commas, newlines and doubled quotes.
 * Hand-rolled because a dependency for 40 lines is not worth it.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Close the row on the first terminator and swallow a following \n.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a final row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Parses a data file. JSON must be an array of objects; anything else is an
 * error the caller can show, rather than a silently empty run.
 */
export function parseDataFile(text: string, path: string): DataSet {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("the file is empty");

  const looksJson =
    path.toLowerCase().endsWith(".json") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{");

  if (looksJson) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) throw new Error("the JSON array is empty");
    if (list.some((entry) => typeof entry !== "object" || entry === null)) {
      throw new Error("expected an array of objects, one per iteration");
    }
    const columns: string[] = [];
    for (const entry of list) {
      for (const key of Object.keys(entry as object)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    const rows = list.map((entry) => {
      const row: Record<string, string> = {};
      for (const column of columns) {
        row[column] = stringify((entry as Record<string, unknown>)[column]);
      }
      return row;
    });
    return { columns, rows };
  }

  const table = parseCsv(trimmed);
  if (table.length < 2) {
    throw new Error("expected a header row and at least one data row");
  }
  const columns = table[0].map((name) => name.trim());
  const rows = table.slice(1).map((values) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = (values[index] ?? "").trim();
    });
    return row;
  });
  return { columns, rows };
}
