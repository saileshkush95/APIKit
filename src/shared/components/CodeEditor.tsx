import { useLayoutEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Lets a parent (e.g. a formatting toolbar) reach the textarea. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Textarea with a gutter of line numbers, kept in sync by mirroring the
 * textarea's scroll position onto the gutter.
 */
export function CodeEditor({
  value,
  onChange,
  placeholder,
  className,
  inputRef,
}: Props) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? ownRef;
  const gutterRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(1);

  useLayoutEffect(() => {
    setLineCount(value.split("\n").length);
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    // Tab indents instead of leaving the editor, as in any code editor.
    e.preventDefault();
    const target = e.currentTarget;
    const { selectionStart, selectionEnd } = target;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = selectionStart + 2;
    });
  }

  return (
    <div
      className={`flex min-h-0 overflow-hidden rounded-md border border-edge bg-panel ${
        className ?? ""
      }`}
    >
      <div
        ref={gutterRef}
        aria-hidden
        className="flex-none select-none overflow-hidden border-r border-edge bg-elevated/40 px-2 py-2.5 text-right font-mono text-[12.5px] leading-relaxed text-muted"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={(e) => {
          if (gutterRef.current) {
            gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }
        }}
        className="min-h-0 w-full flex-1 resize-none bg-transparent p-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
      />
    </div>
  );
}
