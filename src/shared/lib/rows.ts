// One definition of "this row goes out", shared by every send path.
//
// Two things disqualify a row: no name — which is the trailing blank row the
// editors always keep — or the user switching it off. Both used to be spelled
// out at each call site as `name.trim() !== ""`, and a new reason to skip a row
// then had to be added in a dozen places or it silently leaked onto the wire.

import type { KeyValue } from "../types";

/** `enabled` absent means on, so rows saved before it existed still count. */
export function isActive(row: KeyValue): boolean {
  return row.name.trim() !== "" && row.enabled !== false;
}

export function activeRows<T extends KeyValue>(rows: T[]): T[] {
  return rows.filter(isActive);
}

/**
 * A row nobody has typed anything into — the trailing placeholder.
 *
 * Every column counts, including the ones that never travel: a row with only a
 * description is still something someone wrote, and treating it as empty means
 * offering no way to finish it or throw it away.
 */
export function isEmptyRow(row: KeyValue): boolean {
  return (
    row.name.trim() === "" &&
    row.value.trim() === "" &&
    (row.description ?? "").trim() === "" &&
    (row.filePath ?? "") === ""
  );
}

/**
 * Rows worth storing: everything except the trailing placeholder.
 *
 * Interior empty rows are kept. A row whose name has not been typed yet cannot
 * be written to a query string, and dropping it for that reason made a param
 * disappear the moment its value was typed.
 */
export function storableRows<T extends KeyValue>(rows: T[]): T[] {
  return rows.length > 0 && isEmptyRow(rows[rows.length - 1])
    ? rows.slice(0, -1)
    : rows;
}
