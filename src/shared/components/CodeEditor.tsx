import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchDynamic } from "../lib/dynamicVars";
import {
  applyShownEdit,
  foldRanges,
  hiddenLines,
  lineStarts,
  project,
  shiftFolds,
  toFullOffset,
  toShownOffset,
  visibleLines,
} from "../lib/folding";
import {
  renderHighlighted,
  type HighlightLanguage,
} from "../lib/highlight";
import { useFieldHistory } from "../lib/fieldHistory";
import { typeInto } from "../lib/textEdit";
import { completeVariable, openVariable } from "../lib/variableTokens";
import { useEnvironments } from "../state/environments";
import { useVariableHover } from "./VariableTooltip";

/** One entry offered by a custom `suggest` source. */
export interface Suggestion {
  name: string;
  /** Shown dimmed on the right — a type, a value, a description. */
  detail?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Lets a parent (e.g. a formatting toolbar) reach the textarea. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Off for prose, where `{{` is unlikely to mean a variable. */
  completeVariables?: boolean;
  /**
   * Context completions beyond `{{variables}}` — e.g. GraphQL schema fields.
   * Returns the candidates and where the token being completed starts, or
   * null when the caret is not somewhere completable.
   */
  suggest?: (
    value: string,
    caret: number,
  ) => { items: Suggestion[]; start: number } | null;
  /** Enables syntax colouring and bracket/quote auto-closing. */
  language?: HighlightLanguage;
  /**
   * Stable identity for this field's undo history, e.g. `${tab.id}:body`. Left
   * out, the browser's own undo stack is used unchanged.
   */
  historyKey?: string;
  /**
   * Arrows in the gutter that fold each `{...}` and `[...]` block away. Opt-in:
   * it costs a scan of the text on every keystroke, and it is only worth it
   * where documents are deep enough to need it.
   */
  foldable?: boolean;
}

const LINE_HEIGHT = 20;
const PADDING = 10;
/** Past this, the highlight overlay would cost more than it is worth. */
const HIGHLIGHT_LIMIT = 120_000;

const PAIRS: Record<string, string> = {
  "{": "}",
  "[": "]",
  "(": ")",
  '"': '"',
};
const CLOSERS = new Set(Object.values(PAIRS));

/**
 * Textarea with a gutter of line numbers, completion for `{{variables}}` and
 * custom sources, and — when a language is set — syntax highlighting via a
 * backdrop overlay: the textarea's own text is transparent and a highlighted
 * copy sits behind it, kept aligned by sharing the exact same font metrics.
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
  suggest,
  language = "none",
  historyKey,
  foldable = false,
}: Props) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? ownRef;
  const gutterRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const [lineCount, setLineCount] = useState(1);

  // --- Folding ---------------------------------------------------------------
  //
  // A textarea shows exactly the string it holds, so a folded line cannot be
  // present-but-unseen: it holds the text *minus* the folded lines, and every
  // edit made in it is mapped back onto the whole in `lib/folding`. Nothing
  // folded — which is every editor that does not ask for this — makes `shown`
  // the value itself and each of these an identity.
  const [folds, setFolds] = useState<Set<number>>(() => new Set());
  const ranges = useMemo(
    () => (foldable ? foldRanges(value, language) : new Map<number, number>()),
    [foldable, value, language],
  );
  const fullLines = useMemo(() => value.split("\n"), [value]);
  const visible = useMemo(
    () => visibleLines(fullLines.length, hiddenLines(folds, ranges)),
    [fullLines.length, folds, ranges],
  );
  const fullStarts = useMemo(() => lineStarts(value), [value]);
  const folded = visible.length < fullLines.length;
  const shown = folded ? project(fullLines, visible) : value;
  /** Where the caret was, in the full text, while a fold opens or shuts. */
  const pendingCaret = useRef<number | null>(null);

  /** An edit made in the textarea, written back onto the whole text. */
  function commit(nextShown: string) {
    if (!folded) {
      onChange(nextShown);
      return;
    }
    const edit = applyShownEdit(value, shown, nextShown, visible);
    setFolds(shiftFolds(folds, edit, foldRanges(edit.text, language)));
    onChange(edit.text);
  }

  function toggleFold(line: number) {
    const element = textareaRef.current;
    if (element) {
      pendingCaret.current = toFullOffset(
        shown,
        element.selectionStart,
        visible,
        fullStarts,
        value.length,
      );
    }
    setFolds((current) => {
      const next = new Set(current);
      if (!next.delete(line)) next.add(line);
      return next;
    });
  }

  // Folding rewrites the textarea, which would otherwise leave the caret at the
  // end of it. A fold is a view of the text, not an edit to it, so the caret
  // stays on the character it was on — or, if that has just been folded away,
  // at the end of the line that swallowed it.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const element = textareaRef.current;
    if (!element) return;
    const at = toShownOffset(value, caret, visible, fullStarts, shown.length);
    element.setSelectionRange(at, at);
  }, [folds]);

  const { vars } = useEnvironments();
  const names = useMemo(() => Object.keys(vars).sort(), [vars]);
  const [completion, setCompletion] = useState<{
    kind: "variable" | "custom";
    items: Suggestion[];
    start: number;
    left: number;
    top: number;
  } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The list scrolls at 15rem, so moving the highlight past the visible rows
  // looked like the arrow keys did nothing at all.
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // Hovering reads the overlay's token rects, so it works wherever the overlay
  // is drawn — that is, any editor with a language set.
  const { hoverProps, tooltip } = useVariableHover(overlayRef);
  const history = useFieldHistory(historyKey, shown, textareaRef, commit);

  const highlightOn = language !== "none" && shown.length > 0 && shown.length <= HIGHLIGHT_LIMIT;
  const overlay = useMemo(
    () => (highlightOn ? renderHighlighted(shown, language) : null),
    [highlightOn, shown, language],
  );

  useLayoutEffect(() => {
    setLineCount(shown.split("\n").length);
  }, [shown]);

  // The overlay must wrap at exactly the textarea's content width; a classic
  // scrollbar (Windows/Linux) eats into that width, so it is measured rather
  // than assumed.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const overlayElement = overlayRef.current;
    if (!textarea || !overlayElement) return;
    const sync = () => {
      overlayElement.style.width = `${textarea.clientWidth}px`;
      overlayElement.scrollTop = textarea.scrollTop;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [overlay !== null]);

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
    const element = textareaRef.current;
    if (!element) {
      setCompletion(null);
      return;
    }

    let kind: "variable" | "custom" = "variable";
    let items: Suggestion[] = [];
    let start = 0;

    const open = completeVariables ? openVariable(next, caret) : null;
    if (open) {
      const needle = open.query.toLowerCase();
      items = [
        ...names
          .filter((name) => name.toLowerCase().includes(needle))
          .map((name) => ({
            name,
            detail: vars[name] === "" ? "empty" : vars[name],
          })),
        ...matchDynamic(open.query).map((item) => ({
          name: item.name,
          detail: item.description,
        })),
      ].slice(0, 8);
      start = open.start;
    } else if (suggest) {
      const custom = suggest(next, caret);
      if (custom && custom.items.length > 0) {
        kind = "custom";
        items = custom.items.slice(0, 8);
        start = custom.start;
      }
    }

    if (items.length === 0) {
      setCompletion(null);
      return;
    }

    const before = next.slice(0, caret);
    const line = before.split("\n").length - 1;
    const column = caret - (before.lastIndexOf("\n") + 1);
    const box = element.getBoundingClientRect();

    setCompletion({
      kind,
      items,
      start,
      left: box.left + PADDING + column * charWidth(element) - element.scrollLeft,
      top: box.top + PADDING + (line + 1) * LINE_HEIGHT - element.scrollTop,
    });
    setHighlighted(0);
  }

  function choose(name: string) {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? shown.length;
    if (!completion) return;

    setCompletion(null);
    if (completion.kind === "custom") {
      splice(name, completion.start, caret);
      return;
    }
    const result = completeVariable(shown, completion.start, caret, name);
    splice(result.text, result.from, result.to);
  }

  /**
   * Replaces `[from, to)` with `text`, keeping it undoable.
   *
   * The edit goes through the textarea rather than through state, so it lands
   * on the browser's own undo stack — see `lib/textEdit`. `caretStart` is only
   * needed when the caret should not end up after the inserted text, which is
   * where the browser leaves it.
   */
  function splice(
    text: string,
    from: number,
    to: number,
    caretStart?: number,
    caretEnd = caretStart,
  ) {
    const element = textareaRef.current;
    // Only where the caret is being placed somewhere other than after the
    // insert. Completions are worked out from the input event, which fires
    // before that move — auto-closing a quote leaves the caret reported past
    // the pair when what is being typed starts between it — and a caller that
    // wants the default position (`choose`, above) has just closed the list
    // and must not have it reopened underneath the word it inserted.
    const recomplete = (at: number) => {
      if (caretStart !== undefined && element) refresh(element.value, at);
    };
    if (typeInto(element, text, from, to)) {
      if (caretStart !== undefined) {
        requestAnimationFrame(() => {
          element?.setSelectionRange(caretStart, caretEnd ?? caretStart);
          recomplete(caretStart);
        });
      }
      return;
    }
    // The edit still has to happen; only its undo step is lost.
    const caret = caretStart ?? from + text.length;
    commit(shown.slice(0, from) + text + shown.slice(to));
    requestAnimationFrame(() => {
      element?.setSelectionRange(caret, caretEnd ?? caret);
      recomplete(caret);
    });
  }

  /** Bracket/quote pairing and indentation, active when a language is set. */
  function handleEditingKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (language === "none") return false;
    const target = e.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const nextChar = shown[start] ?? "";
    const prevChar = shown[start - 1] ?? "";

    // Typing a closer that is already there just moves over it.
    if (start === end && CLOSERS.has(e.key) && nextChar === e.key) {
      e.preventDefault();
      target.setSelectionRange(start + 1, start + 1);
      refresh(shown, start + 1);
      return true;
    }

    const closer = PAIRS[e.key];
    if (closer) {
      e.preventDefault();
      const inner = shown.slice(start, end);
      // The caret goes inside the pair, keeping any wrapped text selected.
      splice(e.key + inner + closer, start, end, start + 1, start + 1 + inner.length);
      return true;
    }

    if (e.key === "Backspace" && start === end && start > 0) {
      // Deleting an opener also removes the empty pair it opened.
      if (PAIRS[prevChar] === nextChar && nextChar !== "") {
        e.preventDefault();
        splice("", start - 1, start + 1, start - 1);
        return true;
      }
      return false;
    }

    if (e.key === "Enter" && start === end && !completion) {
      const lineStart = shown.lastIndexOf("\n", start - 1) + 1;
      const indent = /^[ \t]*/.exec(shown.slice(lineStart, start))?.[0] ?? "";
      const opensBlock = prevChar === "{" || prevChar === "[" || prevChar === "(";
      if (opensBlock && PAIRS[prevChar] === nextChar) {
        // Caret between an empty pair: put the closer on its own line.
        e.preventDefault();
        splice(`\n${indent}  \n${indent}`, start, end, start + indent.length + 3);
        return true;
      }
      if (opensBlock || indent !== "") {
        e.preventDefault();
        splice(`\n${indent}${opensBlock ? "  " : ""}`, start, end);
        return true;
      }
    }

    return false;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Before everything else: undo has to reach the field's own history rather
    // than being interpreted as an edit.
    if (history.handleKey(e)) return;

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
        choose(completion.items[highlighted].name);
        return;
      }
      if (e.key === "Escape") {
        setCompletion(null);
        return;
      }
    }

    if (handleEditingKeys(e)) return;

    if (e.key !== "Tab") return;
    // Tab indents instead of leaving the editor, as in any code editor.
    e.preventDefault();
    const { selectionStart, selectionEnd } = e.currentTarget;
    splice("  ", selectionStart, selectionEnd);
  }

  return (
    <div
      className={`flex min-h-0 overflow-hidden rounded-md border border-edge bg-panel ${
        className ?? ""
      }`}
    >
      <div
        ref={gutterRef}
        aria-hidden={!foldable}
        className={`flex-none select-none overflow-hidden border-r border-edge bg-elevated/40 py-2.5 text-right font-mono text-[12.5px] leading-relaxed text-muted ${
          foldable ? "pr-2 pl-4" : "px-2"
        }`}
      >
        {/* The numbers are the flow: they set each row's height, and the
            textarea's rows are aligned to them by sharing a font and a line
            height. The arrow is taken out of the flow so that it cannot move a
            row by so much as a pixel. Folded, the numbers skip — which is what
            says something is hidden there. */}
        {foldable
          ? visible.map((line) => (
              <div key={line} className="relative">
                {ranges.has(line) && (
                  <button
                    type="button"
                    /* A fold is a view of the text, not an edit to it, so it
                       does not take the caret out of the field. */
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleFold(line)}
                    aria-label={`${folds.has(line) ? "Unfold" : "Fold"} the block on line ${line + 1}`}
                    className="absolute inset-y-0 -left-3 flex items-center text-[9px] text-muted hover:text-ink"
                  >
                    {folds.has(line) ? "▸" : "▾"}
                  </button>
                )}
                <span aria-hidden>{line + 1}</span>
              </div>
            ))
          : Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
      </div>
      <div className="relative min-h-0 min-w-0 flex-1" {...hoverProps}>
        {overlay !== null && (
          <pre
            ref={overlayRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 m-0 overflow-hidden p-2.5 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink"
          >
            {overlay}
            {"\n"}
          </pre>
        )}
        <textarea
          ref={textareaRef}
          value={shown}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => {
            commit(e.target.value);
            refresh(e.target.value, e.target.selectionStart ?? 0);
          }}
          onClick={(e) => refresh(shown, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTimeout(() => setCompletion(null), 120)}
          onKeyDown={handleKeyDown}
          onScroll={(e) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }
            if (overlayRef.current) {
              overlayRef.current.scrollTop = e.currentTarget.scrollTop;
              overlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
            setCompletion(null);
          }}
          className={`relative h-full w-full resize-none bg-transparent p-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted ${
            overlay !== null
              ? "text-transparent caret-[var(--color-ink)]"
              : "text-ink"
          }`}
        />
      </div>

      {tooltip}

      {completion &&
        createPortal(
          <ul
            ref={listRef}
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
            {completion.items.map((item, index) => (
              <li key={item.name} data-index={index}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item.name)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                    index === highlighted ? "wrk-option-active" : ""
                  }`}
                >
                  <span className="font-mono text-brand">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-muted">
                    {item.detail ?? ""}
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
