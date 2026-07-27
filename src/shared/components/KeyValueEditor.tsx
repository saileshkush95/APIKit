import { Autocomplete } from "./Autocomplete";
import { VariableInput } from "./VariableInput";
import { Input, Select } from "./Field";
import { Toggle } from "./Toggle";
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


/** Editable key/value list that always keeps one trailing blank row. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  allowFiles = false,
  allowSecrets = false,
  suggestName,
  suggestValue,
  highlightVariables = false,
}: Props) {
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

  async function pickFile(index: number) {
    const selected = await open({ multiple: false, title: "Choose a file" });
    if (typeof selected === "string") {
      update(index, { kind: "file", filePath: selected });
    }
  }

  return (
    // Fixed layout: column widths must not be recomputed from cell content,
    // or switching a row between text and file would shift the whole grid.
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr className="text-left text-[11px] font-medium text-muted">
          <th className="w-1/3 p-1">{keyPlaceholder}</th>
          {allowFiles && <th className="w-24 p-1">Type</th>}
          <th className="p-1">{valuePlaceholder}</th>
          {allowSecrets && (
            <th className="w-14 p-1" title="Secret values stay on this machine">
              Secret
            </th>
          )}
          <th className="w-9"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td className="p-0.5">
              {suggestName ? (
                <Autocomplete
                  value={row.name}
                  spellCheck={false}
                  placeholder={keyPlaceholder}
                  mono
                  suggest={suggestName}
                  onChange={(name) => update(i, { name })}
                />
              ) : highlightVariables ? (
                <VariableInput
                  value={row.name}
                  placeholder={keyPlaceholder}
                  mono
                  onChange={(name) => update(i, { name })}
                />
              ) : (
                <Input
                  value={row.name}
                  spellCheck={false}
                  placeholder={keyPlaceholder}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              )}
            </td>
            {allowFiles && (
              <td className="p-0.5">
                <Select
                  value={row.kind ?? "text"}
                  onChange={(e) =>
                    update(i, {
                      kind: e.target.value as KeyValue["kind"],
                      filePath: e.target.value === "text" ? "" : row.filePath,
                    })
                  }
                  className={"wrk-field w-20 cursor-pointer"}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </Select>
              </td>
            )}
            <td className="p-0.5">
              {allowFiles && row.kind === "file" ? (
                // h-8 matches .wrk-field, so the row keeps its height when a
                // text input becomes a file picker.
                <div className="flex h-8 items-center gap-1.5">
                  <button
                    onClick={() => pickFile(i)}
                    className="h-8 flex-none rounded border border-edge px-2 text-xs text-muted hover:border-brand hover:text-ink"
                  >
                    Choose file…
                  </button>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                    title={row.filePath}
                  >
                    {row.filePath ? fileNameOf(row.filePath) : "No file selected"}
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
                      mono
                      suggest={(query) => suggestValue(row.name, query)}
                      onChange={(value) => update(i, { value })}
                    />
                  ) : (
                    <Input
                      value={row.value}
                      spellCheck={false}
                      // Masked so a shared screen does not leak the value.
                      type={secret ? "password" : "text"}
                      placeholder={valuePlaceholder}
                      onChange={(e) => update(i, { value: e.target.value })}
                    />
                  );
                })()
              )}
            </td>
            {allowSecrets && (
              <td className="p-0.5 text-center">
                <Toggle
                  checked={row.secret ?? false}
                  onChange={(secret) => update(i, { secret })}
                  title="Keep this value on this machine only"
                />
              </td>
            )}
            <td className="p-0.5">
              <button
                className="px-1.5 text-lg text-muted hover:text-err"
                onClick={() => remove(i)}
                title="Remove"
              >
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
