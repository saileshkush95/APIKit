import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DYNAMIC_VARS, matchDynamic } from "../lib/dynamicVars";
import {
  completeVariable,
  openVariable,
  tokenize,
} from "../lib/variableTokens";
import { useEnvironments } from "../state/environments";
import type { FieldSize } from "./Field";

function describeDynamic(name: string): string {
  return DYNAMIC_VARS.find((item) => item.name === name)?.description ?? "";
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: FieldSize;
  mono?: boolean;
  className?: string;
  disabled?: boolean;
  title?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * A field that colours `{{variables}}` and completes them as you type.
 *
 * The text cannot be styled inside an <input>, so the same string is drawn in
 * an overlay behind a transparent-text field, with the two kept in step —
 * identical font and padding, and the overlay scrolled to match. A variable the
 * active environment defines shows in the accent colour; one it does not shows
 * as a warning, which is the whole point: an undefined variable is sent as
 * literal text and is otherwise easy to miss.
 */
export function VariableInput({
  value,
  onChange,
  placeholder,
  size = "default",
  mono,
  className,
  disabled,
  title,
  onKeyDown,
}: Props) {
  const { vars } = useEnvironments();
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [anchor, setAnchor] = useState<{ start: number } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const tokens = useMemo(() => tokenize(value, vars), [value, vars]);
  const names = useMemo(() => Object.keys(vars).sort(), [vars]);

  // The overlay does not scroll on its own; it follows the field.
  function syncScroll() {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }

  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () =>
      setRect(inputRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);

  useEffect(() => {
    syncScroll();
  }, [value]);

  function refresh(next: string, caret: number) {
    const open = openVariable(next, caret);
    if (!open) {
      setAnchor(null);
      return;
    }
    const needle = open.query.toLowerCase();
    const found = [
      ...names.filter((name) => name.toLowerCase().includes(needle)),
      ...matchDynamic(open.query).map((item) => item.name),
    ].slice(0, 8);
    setSuggestions(found);
    setHighlighted(0);
    setAnchor(found.length > 0 ? { start: open.start } : null);
  }

  function choose(name: string) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    if (!anchor) return;
    const result = completeVariable(value, anchor.start, caret, name);
    onChange(result.value);
    setAnchor(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(result.caret, result.caret);
    });
  }

  const shared = [
    size !== "default" ? size : "",
    mono ? "mono" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`wrk-variable-field ${className ?? ""}`}>
      <div ref={overlayRef} className={`wrk-variable-overlay ${shared}`} aria-hidden>
        {value === "" ? (
          <span className="text-muted">{placeholder}</span>
        ) : (
          tokens.map((token, index) =>
            token.name ? (
              <span
                key={index}
                className={
                  token.dynamic
                    ? "text-redirect"
                    : token.known
                      ? "text-brand"
                      : "wrk-variable-unknown"
                }
              >
                {token.text}
              </span>
            ) : (
              <span key={index}>{token.text}</span>
            ),
          )
        )}
      </div>

      <input
        ref={inputRef}
        value={value}
        spellCheck={false}
        disabled={disabled}
        title={title}
        autoComplete="off"
        className={`wrk-field wrk-variable-input ${shared}`}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? 0);
        }}
        onScroll={syncScroll}
        onClick={(e) =>
          refresh(value, e.currentTarget.selectionStart ?? 0)
        }
        onBlur={() => setTimeout(() => setAnchor(null), 120)}
        onKeyDown={(e) => {
          if (anchor && suggestions.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setHighlighted(
                (current) =>
                  (current + step + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(suggestions[highlighted]);
              return;
            }
            if (e.key === "Escape") {
              setAnchor(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />

      {anchor &&
        rect &&
        createPortal(
          <ul
            role="listbox"
            className="wrk-select-list"
            style={{
              left: rect.left,
              width: Math.max(rect.width, 200),
              ...(window.innerHeight - rect.bottom < 220 && rect.top > 220
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }}
          >
            {suggestions.map((name, index) => (
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
                      : describeDynamic(name)}
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
