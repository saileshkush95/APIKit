import { useState } from "react";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  /** Comma-separated list, the storage format. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Email addresses as removable tags over a comma-separated string. Enter,
 * comma or leaving the field commits what is typed; Backspace on an empty
 * input removes the last tag. Entries that are not addresses stay visible,
 * marked red, so a typo is seen rather than silently kept.
 */
export function TagInput({ value, onChange, placeholder, className }: Props) {
  const [draft, setDraft] = useState("");
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  function commit(raw: string) {
    const parts = raw
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const fresh = parts.filter((part) => !tags.includes(part));
    if (fresh.length > 0) onChange([...tags, ...fresh].join(", "));
    setDraft("");
  }

  function remove(tag: string) {
    onChange(tags.filter((candidate) => candidate !== tag).join(", "));
  }

  return (
    <div
      className={`flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-edge bg-panel px-1.5 py-1 focus-within:border-brand ${
        className ?? ""
      }`}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] ${
            EMAIL.test(tag)
              ? "border-edge bg-elevated text-ink"
              : "border-err/60 bg-err/10 text-err"
          }`}
          title={EMAIL.test(tag) ? tag : `${tag} — not a valid address`}
        >
          {tag}
          <button
            onClick={() => remove(tag)}
            className="leading-none text-muted hover:text-err"
            title="Remove"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={tags.length === 0 ? placeholder : ""}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          // A typed or pasted comma commits immediately.
          if (e.target.value.includes(",")) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
            remove(tags[tags.length - 1]);
          }
        }}
        onBlur={() => commit(draft)}
        className="min-w-32 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-muted"
      />
    </div>
  );
}
