import { useEffect, useRef, useState } from "react";
import { Autocomplete } from "./Autocomplete";
import { VariableInput } from "./VariableInput";
import { Input, Select } from "./Field";
import { open } from "@tauri-apps/plugin-dialog";
import type { KeyValue } from "../types";

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Lets a row carry a file instead of text (form-data). */
  allowFiles?: boolean;
  /** Lets a row be marked secret (environment variables). */
  allowSecrets?: boolean;
  /**
   * Adds the leading on/off column, for lists that are stored as rows. Off for
   * query params, which are stored only as the URL's query string and so have
   * nowhere to keep a row that is switched off.
   */
  allowDisable?: boolean;
  /** Adds the Description column — documentation, never sent. */
  allowDescription?: boolean;
  /** Completions for the key column, e.g. header names. */
  suggestName?: (query: string) => string[];
  /** Completions for the value column, given the row's key. */
  suggestValue?: (name: string, query: string) => string[];
  /** Colour {{variables}} in the value column and complete them. */
  highlightVariables?: boolean;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// One border per cell, collapsed, so neighbours share a single line. Without
// `border-collapse` every cell draws its own and the grid doubles up.
const CELL = "border border-edge p-0";
const HEAD = "border border-edge px-2 py-0.5 text-left font-medium text-muted";

/** A row the user has typed nothing into — the trailing placeholder. */
function isBlank(row: KeyValue): boolean {
  return row.name.trim() === "" && row.value.trim() === "";
}

/**
 * `Key: Value` per line, `//` in front of a row that is switched off — the
 * format Postman uses, so text pasted from there works unchanged.
 */
function toBulkText(rows: KeyValue[]): string {
  return rows
    .filter((row) => !isBlank(row))
    .map((row) => `${row.enabled === false ? "//" : ""}${row.name}:${row.value}`)
    .join("\n");
}

/**
 * Text back to rows. The format carries a name, a value and the on/off mark and
 * nothing else, so anything it cannot express — descriptions, the secret flag —
 * is carried over from the row of the same name rather than being dropped.
 */
function fromBulkText(text: string, previous: KeyValue[]): KeyValue[] {
  const kept = new Map<string, KeyValue>();
  for (const row of previous) {
    if (row.name.trim() !== "") kept.set(row.name.trim(), row);
  }

  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const trimmed = line.trimStart();
      const off = trimmed.startsWith("//");
      const rest = off ? trimmed.slice(2) : trimmed;
      const colon = rest.indexOf(":");
      const name = (colon === -1 ? rest : rest.slice(0, colon)).trim();
      const value = colon === -1 ? "" : rest.slice(colon + 1).trim();

      const row: KeyValue = { name, value };
      if (off) row.enabled = false;
      const before = kept.get(name);
      if (before?.description) row.description = before.description;
      if (before?.secret) row.secret = before.secret;
      return row;
    });

  // The editors rely on a trailing blank row to type the next entry into.
  rows.push({ name: "", value: "" });
  return rows;
}

/** Editable key/value list that always keeps one trailing blank row. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  allowFiles = false,
  allowSecrets = false,
  allowDisable = false,
  allowDescription = false,
  suggestName,
  suggestValue,
  highlightVariables = false,
}: Props) {
  // Held separately from `rows` while bulk editing: the textarea must show
  // exactly what was typed, and a round trip through the rows would eat a
  // half-finished line or a trailing newline as it went.
  const [bulkText, setBulkText] = useState<string | null>(null);
  const bulk = bulkText !== null;

  const [menuOpen, setMenuOpen] = useState(false);
  const [showValue, setShowValue] = useState(true);
  const [showDescription, setShowDescription] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  // A file cannot be written as text, so a grid that allows them has no faithful
  // bulk form — offering one would silently drop the files.
  const canBulk = !allowFiles;
  const descriptionColumn = allowDescription && showDescription;
  // The Type and file-picker columns are meaningless without their value cell.
  const valueColumn = showValue || allowFiles;

  useEffect(() => {
    if (!menuOpen) return;
    // Containment test rather than a capture-phase handler: closing on the way
    // down would unmount the menu before the click reached the item under the
    // cursor, and nothing would happen.
    function onPointerDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  function update(index: number, patch: Partial<KeyValue>) {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    const last = next[next.length - 1];
    if (last && (last.name !== "" || last.value !== "")) {
      next.push({ name: "", value: "" });
    }
    onChange(next);
  }

  function remove(index: number) {
    const next = rows.filter((_, i) => i !== index);
    if (next.length === 0) next.push({ name: "", value: "" });
    onChange(next);
  }

  /** Switches every row that has a name; the placeholder is left alone. */
  function setAll(enabled: boolean) {
    onChange(rows.map((row) => (isBlank(row) ? row : { ...row, enabled })));
  }

  async function pickFile(index: number) {
    const selected = await open({ multiple: false, title: "Choose a file" });
    if (typeof selected === "string") {
      update(index, { kind: "file", filePath: selected });
    }
  }

  const filled = rows.filter((row) => !isBlank(row));
  const allOn = filled.length > 0 && filled.every((row) => row.enabled !== false);

  const item =
    "flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] text-ink hover:bg-elevated disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
  const heading = "px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium text-muted";

  /** A tick that keeps its width when unticked, so labels stay aligned. */
  function Tick({ on }: { on: boolean }) {
    return (
      <span className="w-2.5 flex-none text-brand">{on ? "✓" : ""}</span>
    );
  }

  // Lives in the header row's last cell, so the options cost no vertical space
  // at all — a toolbar above the table would take a whole line in a pane that
  // is almost entirely table.
  const options = (
    <div ref={menuRef} className="relative flex justify-center">
      <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className={`-mb-0.5 rounded px-1.5 text-[13px] leading-none text-muted hover:bg-elevated hover:text-ink ${
            menuOpen ? "bg-elevated text-ink" : ""
          }`}
          title="Table options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          •••
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-edge bg-panel py-1 shadow-lg"
          >
            {canBulk && (
              <button
                type="button"
                className={item}
                onClick={() => {
                  setBulkText(bulk ? null : toBulkText(rows));
                  setMenuOpen(false);
                }}
              >
                <Tick on={bulk} />
                {bulk ? "Key-value edit" : "Bulk edit"}
              </button>
            )}

            {allowDisable && (
              <button
                type="button"
                className={item}
                disabled={filled.length === 0 || bulk}
                onClick={() => {
                  setAll(!allOn);
                  setMenuOpen(false);
                }}
              >
                <Tick on={false} />
                {allOn ? "Disable all" : "Enable all"}
              </button>
            )}

            <button
              type="button"
              className={item}
              disabled={filled.length === 0}
              onClick={() => {
                onChange([{ name: "", value: "" }]);
                setBulkText(bulk ? "" : null);
                setMenuOpen(false);
              }}
            >
              <Tick on={false} />
              Clear all
            </button>

            {!bulk && (
              <>
                <div className={heading}>Show columns</div>
                <button
                  type="button"
                  className={item}
                  // Hiding it would leave the Type dropdown pointing at a cell
                  // that is not there.
                  disabled={allowFiles}
                  onClick={() => setShowValue((on) => !on)}
                >
                  <Tick on={valueColumn} />
                  {valuePlaceholder}
                </button>
                {allowDescription && (
                  <button
                    type="button"
                    className={item}
                    onClick={() => setShowDescription((on) => !on)}
                  >
                    <Tick on={showDescription} />
                    Description
                  </button>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      {bulk ? (
        <div>
          {/* No header row to hold the button while the table is hidden. */}
          <div className="mb-1 flex justify-end">{options}</div>
          <textarea
            value={bulkText ?? ""}
            spellCheck={false}
            autoFocus
            placeholder={`${keyPlaceholder}:${valuePlaceholder}`}
            onChange={(e) => {
              setBulkText(e.target.value);
              onChange(fromBulkText(e.target.value, rows));
            }}
            className="h-48 w-full resize-y rounded-md border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
          />
          <div className="mt-1 text-[10px] text-muted">
            One <span className="font-mono">Key:Value</span> per line. Prefix a
            line with <span className="font-mono">//</span> to keep it without
            sending it.
            {allowDescription && " Descriptions are kept but not shown here."}
          </div>
        </div>
      ) : (
        // Fixed layout: column widths must not be recomputed from cell content,
        // or switching a row between text and file would shift the whole grid.
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead>
            <tr>
              {allowDisable && (
                <th className={`${HEAD} w-7 text-center`}>
                  <input
                    type="checkbox"
                    className="wrk-check"
                    checked={allOn}
                    disabled={filled.length === 0}
                    onChange={(e) => setAll(e.target.checked)}
                    title={allOn ? "Switch every row off" : "Switch every row on"}
                  />
                </th>
              )}
              <th className={`${HEAD} w-1/3`}>{keyPlaceholder}</th>
              {allowFiles && <th className={`${HEAD} w-24`}>Type</th>}
              {valueColumn && <th className={HEAD}>{valuePlaceholder}</th>}
              {descriptionColumn && <th className={HEAD}>Description</th>}
              {allowSecrets && (
                <th
                  className={`${HEAD} w-12 text-center`}
                  title="Secret values stay on this machine"
                >
                  Secret
                </th>
              )}
              <th className={`${HEAD} w-8`}>{options}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const off = allowDisable && row.enabled === false;
              const blank = isBlank(row);
              return (
                <tr
                  key={i}
                  // `group` drives the remove button, which stays hidden until
                  // the row is pointed at — a × down every row is noise.
                  className={`group hover:bg-elevated/40 ${off ? "opacity-45" : ""}`}
                >
                  {allowDisable && (
                    <td className={`${CELL} text-center align-middle`}>
                      {!blank && (
                        <input
                          type="checkbox"
                          className="wrk-check"
                          checked={row.enabled !== false}
                          onChange={(e) => update(i, { enabled: e.target.checked })}
                          title={
                            off
                              ? "Switched off — kept, but not sent"
                              : "Switch off to keep this row without sending it"
                          }
                        />
                      )}
                    </td>
                  )}
                  <td className={CELL}>
                    {suggestName ? (
                      <Autocomplete
                        value={row.name}
                        spellCheck={false}
                        placeholder={keyPlaceholder}
                        size="cell"
                        mono
                        suggest={suggestName}
                        onChange={(name) => update(i, { name })}
                      />
                    ) : highlightVariables ? (
                      <VariableInput
                        value={row.name}
                        placeholder={keyPlaceholder}
                        size="cell"
                        mono
                        onChange={(name) => update(i, { name })}
                      />
                    ) : (
                      <Input
                        value={row.name}
                        spellCheck={false}
                        placeholder={keyPlaceholder}
                        size="cell"
                        onChange={(e) => update(i, { name: e.target.value })}
                      />
                    )}
                  </td>
                  {allowFiles && (
                    <td className={CELL}>
                      <Select
                        value={row.kind ?? "text"}
                        onChange={(e) =>
                          update(i, {
                            kind: e.target.value as KeyValue["kind"],
                            filePath:
                              e.target.value === "text" ? "" : row.filePath,
                          })
                        }
                        size="cell"
                        className="w-full cursor-pointer"
                      >
                        <option value="text">Text</option>
                        <option value="file">File</option>
                      </Select>
                    </td>
                  )}
                  {valueColumn && (
                    <td className={CELL}>
                      {allowFiles && row.kind === "file" ? (
                        // h-7 matches .wrk-field.cell, so the row keeps its
                        // height when a text input becomes a file picker.
                        <div className="flex h-7 items-center gap-1.5 px-2">
                          <button
                            onClick={() => pickFile(i)}
                            className="flex-none rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
                          >
                            Choose file…
                          </button>
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
                            title={row.filePath}
                          >
                            {row.filePath
                              ? fileNameOf(row.filePath)
                              : "No file selected"}
                          </span>
                        </div>
                      ) : (
                        (() => {
                          const secret = Boolean(allowSecrets && row.secret);
                          if (highlightVariables && !secret) {
                            return (
                              <VariableInput
                                value={row.value}
                                placeholder={valuePlaceholder}
                                size="cell"
                                mono
                                onChange={(value) => update(i, { value })}
                              />
                            );
                          }
                          return suggestValue && !secret ? (
                            <Autocomplete
                              value={row.value}
                              spellCheck={false}
                              placeholder={valuePlaceholder}
                              size="cell"
                              mono
                              suggest={(query) => suggestValue(row.name, query)}
                              onChange={(value) => update(i, { value })}
                            />
                          ) : (
                            <Input
                              value={row.value}
                              spellCheck={false}
                              // Masked so a shared screen does not leak it.
                              type={secret ? "password" : "text"}
                              placeholder={valuePlaceholder}
                              size="cell"
                              onChange={(e) => update(i, { value: e.target.value })}
                            />
                          );
                        })()
                      )}
                    </td>
                  )}
                  {descriptionColumn && (
                    <td className={CELL}>
                      <Input
                        value={row.description ?? ""}
                        spellCheck={false}
                        placeholder="Description"
                        size="cell"
                        onChange={(e) =>
                          update(i, { description: e.target.value })
                        }
                      />
                    </td>
                  )}
                  {allowSecrets && (
                    <td className={`${CELL} text-center align-middle`}>
                      <input
                        type="checkbox"
                        className="wrk-check"
                        checked={row.secret ?? false}
                        onChange={(e) => update(i, { secret: e.target.checked })}
                        title="Keep this value on this machine only"
                      />
                    </td>
                  )}
                  <td className={`${CELL} text-center align-middle`}>
                    {!blank && (
                      <button
                        className="px-1 text-base leading-none text-muted opacity-0 group-hover:opacity-100 hover:text-err focus-visible:opacity-100"
                        onClick={() => remove(i)}
                        title="Remove"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
