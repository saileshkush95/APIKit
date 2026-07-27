import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input, type InputProps } from "./Field";

interface Props extends Omit<InputProps, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Called with the current text; returns what to offer. */
  suggest: (query: string) => string[];
}

/**
 * A text field that offers completions as you type. Free text always wins —
 * the suggestions are a shortcut, never a constraint, so an unlisted header or
 * value can still be typed.
 */
export function Autocomplete({ value, onChange, suggest, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Set while choosing, so the blur that follows does not reopen the list.
  const choosing = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () =>
      setRect(inputRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !inputRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function refresh(next: string) {
    const found = suggest(next);
    setItems(found);
    setHighlighted(0);
    setOpen(found.length > 0);
  }

  function choose(item: string) {
    choosing.current = true;
    onChange(item);
    setOpen(false);
    // Let the click finish before the field can reopen on focus.
    setTimeout(() => {
      choosing.current = false;
    }, 0);
  }

  return (
    <>
      <Input
        {...rest}
        ref={inputRef}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value);
        }}
        onFocus={() => !choosing.current && refresh(value)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || items.length === 0) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHighlighted(
              (current) => (current + step + items.length) % items.length,
            );
          } else if (e.key === "Enter") {
            // Only intercept Enter while a suggestion is highlighted, so the
            // key still submits elsewhere.
            e.preventDefault();
            choose(items[highlighted]);
          } else if (e.key === "Escape") {
            setOpen(false);
          } else if (e.key === "Tab") {
            choose(items[highlighted]);
          }
        }}
      />

      {open &&
        rect &&
        items.length > 0 &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            className="wrk-select-list"
            style={{
              left: rect.left,
              width: Math.max(rect.width, 180),
              ...(window.innerHeight - rect.bottom < 220 && rect.top > 220
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }}
          >
            {items.map((item, index) => (
              <li key={item}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                  className={`block w-full truncate px-2.5 py-1.5 text-left font-mono text-xs ${
                    index === highlighted
                      ? "bg-elevated text-ink"
                      : "text-muted"
                  }`}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
