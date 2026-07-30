import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
// Type-only, so the Field -> Select value re-export does not become a cycle.
import type { FieldSize } from "./Field";

/**
 * A dropdown that renders its own list.
 *
 * A native `<select>` draws its popup with the operating system, which ignores
 * the app's theme and — with the height we give the closed control — can sit
 * over the field itself. This keeps the same `<Select><option/></Select>` shape
 * so call sites are unchanged: the options are read from the children, and the
 * list is drawn in a portal positioned from the button's rectangle, so it is
 * never clipped by a scrolling panel.
 */

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Plain text, for the closed control and type-ahead. */
  text: string;
  disabled?: boolean;
}

interface Props {
  value?: string | number;
  /** Shaped like a change event so existing handlers keep working. */
  onChange?: (event: { target: { value: string } }) => void;
  children?: ReactNode;
  className?: string;
  size?: FieldSize;
  mono?: boolean;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
}

function readOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];

  function walk(nodes: ReactNode) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as Record<string, unknown>;
      // `<optgroup>` is not supported; its children are flattened.
      if (child.type === "optgroup") {
        walk(props.children as ReactNode);
        return;
      }
      if (child.type !== "option") return;
      const label = props.children as ReactNode;
      options.push({
        value: String(props.value ?? ""),
        label,
        text: typeof label === "string" ? label : String(props.value ?? ""),
        disabled: Boolean(props.disabled),
      });
    });
  }

  walk(children);
  return options;
}

export function Select({
  value,
  onChange,
  children,
  className,
  size = "default",
  mono,
  disabled,
  title,
  placeholder = "Select…",
}: Props) {
  const options = useMemo(() => readOptions(children), [children]);
  const selected = options.find((option) => option.value === String(value));

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Keeps the keyboard selection in view: the list scrolls at 15rem, and a
  // highlight moving below the fold looks like the arrow keys doing nothing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // Positioned from the button each time it opens, and kept in place while the
  // page scrolls beneath it.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(buttonRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      const index = options.findIndex((option) => option.value === String(value));
      setHighlighted(index === -1 ? 0 : index);
    }
  }, [open]);

  function choose(option: SelectOption) {
    if (option.disabled) return;
    onChange?.({ target: { value: option.value } });
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => {
        let next = current;
        // Skip past anything disabled rather than stalling on it.
        for (let i = 0; i < options.length; i++) {
          next = (next + step + options.length) % options.length;
          if (!options[next]?.disabled) break;
        }
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = options[highlighted];
      if (option) choose(option);
    } else if (e.key.length === 1) {
      // Type-ahead, as a native select does.
      const needle = e.key.toLowerCase();
      const index = options.findIndex((option) =>
        option.text.toLowerCase().startsWith(needle),
      );
      if (index !== -1) setHighlighted(index);
    }
  }

  const classes = [
    "wrk-field",
    "wrk-select",
    size !== "default" ? size : "",
    mono ? "mono" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        title={title}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        onKeyDown={onKeyDown}
        className={classes}
      >
        <span className="truncate">
          {selected ? selected.label : <span className="text-muted">{placeholder}</span>}
        </span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          className="ml-2 flex-none"
          aria-hidden
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.6"
          />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            className="wrk-select-list"
            style={{
              left: rect.left,
              width: Math.max(rect.width, 140),
              // Flip above the button when there is not room below.
              ...(window.innerHeight - rect.bottom < 240 && rect.top > 240
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }}
          >
            {options.map((option, index) => (
              <li key={option.value} data-index={index}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === String(value)}
                  disabled={option.disabled}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => choose(option)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                    option.disabled
                      ? "cursor-not-allowed text-muted/50"
                      : index === highlighted
                        ? "wrk-option-active"
                        : "text-ink"
                  }`}
                >
                  <span className="w-3 flex-none text-brand">
                    {option.value === String(value) ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
