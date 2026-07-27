import { open } from "@tauri-apps/plugin-dialog";
import type { KeyValue } from "../types";

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Lets a row carry a file instead of text (form-data). */
  allowFiles?: boolean;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const inputCls =
  "w-full rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-brand";

/** Editable key/value list that always keeps one trailing blank row. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  allowFiles = false,
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
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left text-[11px] font-medium text-muted">
          <th className="p-1">{keyPlaceholder}</th>
          {allowFiles && <th className="p-1">Type</th>}
          <th className="p-1">{valuePlaceholder}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td className="p-0.5">
              <input
                value={row.name}
                spellCheck={false}
                placeholder={keyPlaceholder}
                className={inputCls}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </td>
            {allowFiles && (
              <td className="p-0.5">
                <select
                  value={row.kind ?? "text"}
                  onChange={(e) =>
                    update(i, {
                      kind: e.target.value as KeyValue["kind"],
                      filePath: e.target.value === "text" ? "" : row.filePath,
                    })
                  }
                  className={`${inputCls} w-20 cursor-pointer`}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
            )}
            <td className="p-0.5">
              {allowFiles && row.kind === "file" ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => pickFile(i)}
                    className="flex-none rounded border border-edge px-2 py-1 text-xs text-muted hover:border-brand hover:text-ink"
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
                <input
                  value={row.value}
                  spellCheck={false}
                  placeholder={valuePlaceholder}
                  className={inputCls}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              )}
            </td>
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
