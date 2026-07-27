import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DYNAMIC_VARS, matchDynamic } from "../lib/dynamicVars";
import { completeVariable, openVariable } from "../lib/variableTokens";
import { useEnvironments } from "../state/environments";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Lets a parent (e.g. a formatting toolbar) reach the textarea. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Off for prose, where `{{` is unlikely to mean a variable. */
  completeVariables?: boolean;
}

const LINE_HEIGHT = 20;
const PADDING = 10;

/**
 * Textarea with a gutter of line numbers, and completion for `{{variables}}`.
 *
 * The suggestion list is placed at the caret. Measuring that in a textarea
 * normally needs a mirrored copy of the content, but the font here is
 * monospace — so the column times one character's width is exact, and far
 * cheaper.
 */
export function CodeEditor({
  value,
  onChange,
  placeholder,
  className,
  inputRef,
  completeVariables = true,
}: Props) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? ownRef;
  const gutterRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(1);

  const { vars } = useEnvironments();
  const names = useMemo(() => Object.keys(vars).sort(), [vars]);
  const [completion, setCompletion] = useState<{
    items: string[];
    start: number;
    left: number;
    top: number;
  } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  useLayoutEffect(() => {
    setLineCount(value.split("\n").length);
  }, [value]);

  /** Width of one character in the textarea's own font. */
  function charWidth(element: HTMLTextAreaElement): number {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return 7.5;
    const style = window.getComputedStyle(element);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return context.measureText("M").width || 7.5;
  }

  function refresh(next: string, caret: number) {
    if (!completeVariables) return;
    const open = openVariable(next, caret);
    const element = textareaRef.current;
    if (!open || !element) {
      setCompletion(null);
      return;
    }

    const needle = open.query.toLowerCase();
    const items = [
      ...names.filter((name) => name.toLowerCase().includes(needle)),
      ...matchDynamic(open.query).map((item) => item.name),
    ].slice(0, 8);
    if (items.length === 0) {
      setCompletion(null);
      return;
    }

    const before = next.slice(0, caret);
    const line = before.split("\n").length - 1;
    const column = caret - (before.lastIndexOf("\n") + 1);
    const box = element.getBoundingClientRect();

    setCompletion({
      items,
      start: open.start,
      left: box.left + PADDING + column * charWidth(element) - element.scrollLeft,
      top: box.top + PADDING + (line + 1) * LINE_HEIGHT - element.scrollTop,
    });
    setHighlighted(0);
  }

  function choose(name: string) {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? value.length;
    if (!completion) return;
    const result = completeVariable(value, completion.start, caret, name);
    onChange(result.value);
    setCompletion(null);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(result.caret, result.caret);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (completion) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlighted(
          (current) =>
            (current + step + completion.items.length) % completion.items.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(completion.items[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        setCompletion(null);
        return;
      }
    }

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
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? 0);
        }}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart ?? 0)}
        onBlur={() => setTimeout(() => setCompletion(null), 120)}
        onKeyDown={handleKeyDown}
        onScroll={(e) => {
          if (gutterRef.current) {
            gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }
          setCompletion(null);
        }}
        className="min-h-0 w-full flex-1 resize-none bg-transparent p-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
      />

      {completion &&
        createPortal(
          <ul
            role="listbox"
            className="wrk-select-list"
            style={{
              left: completion.left,
              width: 220,
              // Flip above the caret when the list would fall off-screen.
              ...(window.innerHeight - completion.top < 200
                ? { bottom: window.innerHeight - completion.top + LINE_HEIGHT }
                : { top: completion.top }),
            }}
          >
            {completion.items.map((name, index) => (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(name)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                    index === highlighted ? "bg-elevated" : ""
                  }`}
                >
                  <span className="font-mono text-brand">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-muted">
                    {name in vars
                      ? vars[name] === ""
                        ? "empty"
                        : vars[name]
                      : DYNAMIC_VARS.find((item) => item.name === name)
                          ?.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
