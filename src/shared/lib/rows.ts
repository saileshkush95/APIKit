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
