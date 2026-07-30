// Hovering a `{{variable}}` shows what it resolves to, and lets you change it.
//
// The variables are drawn in an overlay behind a transparent-text field, and
// that overlay is `pointer-events: none` — it has to be, or it would swallow
// the clicks that place the caret. So the pointer never enters a token, and
// there is no `:hover` to hang this on.
//
// Instead the pointer position is hit-tested against the token spans' own
// rects. They are laid out exactly where the text appears, which is the whole
// premise of the overlay, so their geometry is the geometry of the visible
// variable. `getClientRects()` rather than `getBoundingClientRect()` because a
// token in the code editor can wrap across lines, and a wrapped token's
// bounding box covers a rectangle the text does not occupy.
//
// The card itself *is* interactive, which makes the dismissal rules the fiddly
// part: leaving the field has to allow the pointer time to travel into the
// card, and everything that would otherwise close it — scrolling, typing,
// clicking — has to ignore what happens inside it.

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  describeVariable,
  upsertVariable,
  type VariableInfo,
} from "../lib/variableInfo";
import { useEnvironmentsStore } from "../state/environments";

/** Long enough that dragging the pointer across a field stays quiet. */
const OPEN_DELAY_MS = 250;
/** Long enough to cross the gap between the token and the card. */
const CLOSE_DELAY_MS = 260;
const CARD_WIDTH = 300;
/** About what fits the card's five lines, so the ellipsis is visible rather
 *  than the text being clipped by the box with no sign it was cut. */
const MAX_VALUE_CHARS = 200;

export interface VariableHover {
  name: string;
  rect: DOMRect;
}

/** True for anything inside the card, which must never dismiss it. */
function insideCard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".wrk-var-tip") !== null;
}

/** The token span under (x, y), if any. */
function hitTest(
  root: HTMLElement | null,
  x: number,
  y: number,
): VariableHover | null {
  if (!root) return null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-variable]")) {
    const name = element.dataset.variable;
    if (!name) continue;
    for (const rect of element.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { name, rect };
      }
    }
  }
  return null;
}

/**
 * Pointer handlers for a field, and the tooltip to render beside it.
 *
 * `overlayRef` is the element holding the `data-variable` spans; the handlers
 * go on whatever the pointer actually lands on — the wrapper, since the input
 * sits on top and its events bubble.
 */
export function useVariableHover(overlayRef: RefObject<HTMLElement | null>) {
  const [hover, setHover] = useState<VariableHover | null>(null);
  // Mirrors `hover` so the rAF callback below reads the current value rather
  // than whatever it was when the frame was scheduled.
  const shown = useRef<VariableHover | null>(null);
  const opening = useRef<{ name: string; timer: number } | null>(null);
  const closing = useRef(0);
  const frame = useRef(0);
  const at = useRef({ x: 0, y: 0 });
  /** Held open while the value is being edited, wherever the pointer goes. */
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);

  function show(next: VariableHover | null) {
    shown.current = next;
    setHover(next);
  }

  function cancelOpen() {
    if (opening.current) window.clearTimeout(opening.current.timer);
    opening.current = null;
    if (frame.current) window.cancelAnimationFrame(frame.current);
    frame.current = 0;
  }

  function cancelClose() {
    if (closing.current) window.clearTimeout(closing.current);
    closing.current = 0;
  }

  function close() {
    cancelOpen();
    cancelClose();
    pinnedRef.current = false;
    setPinned(false);
    show(null);
  }

  /** Closes after a grace period, so the pointer can reach the card. */
  function closeSoon() {
    cancelOpen();
    if (pinnedRef.current || closing.current || !shown.current) return;
    closing.current = window.setTimeout(() => {
      closing.current = 0;
      show(null);
    }, CLOSE_DELAY_MS);
  }

  useEffect(() => {
    return () => {
      cancelOpen();
      cancelClose();
    };
  }, []);

  useEffect(() => {
    if (!hover) return;
    // Scrolling and typing move the text out from under the card — unless they
    // happen inside the card, which is its own scrollable, typeable thing.
    const onScroll = (event: Event) => {
      if (insideCard(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (pinnedRef.current) return;
      // Cmd/Ctrl+C over a selection in the card must not tear it down mid-copy.
      if (event.metaKey || event.ctrlKey) return;
      close();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (insideCard(event.target)) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [hover]);

  /**
   * Coalesced to one scan per frame: reading every token's rects is a layout
   * read, a full-page body can hold hundreds of them, and mousemove fires far
   * more often than anything can be shown.
   */
  function onMouseMove(event: React.MouseEvent) {
    if (pinnedRef.current) return;
    // The card is a portal, and React propagates events through its own tree
    // rather than the DOM's — so moving the pointer onto the card fires this
    // handler too. Hit-testing that position finds no token, which would
    // schedule the close the card's own mouseenter had just cancelled.
    if (insideCard(event.target)) return;
    // The latest position wins, so coalescing costs no accuracy.
    at.current = { x: event.clientX, y: event.clientY };
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0;
      look(at.current.x, at.current.y);
    });
  }

  function look(x: number, y: number) {
    const found = hitTest(overlayRef.current, x, y);
    const current = shown.current;
    if (!found) {
      // Not an immediate close: the pointer may be on its way to the card,
      // and the path there crosses ordinary text.
      cancelOpen();
      closeSoon();
      return;
    }
    // Already showing this one, or already waiting to.
    if (current?.name === found.name && current.rect.left === found.rect.left) {
      cancelClose();
      return;
    }
    if (opening.current?.name === found.name) return;

    // A different variable replaces the card at once; no grace period, or the
    // old value would linger under a new token.
    cancelOpen();
    cancelClose();
    if (current) show(null);
    const timer = window.setTimeout(() => {
      opening.current = null;
      show(found);
    }, OPEN_DELAY_MS);
    opening.current = { name: found.name, timer };
  }

  function pin(next: boolean) {
    pinnedRef.current = next;
    setPinned(next);
    if (next) cancelClose();
    else closeSoon();
  }

  return {
    hoverProps: {
      onMouseMove,
      onMouseLeave: (event: React.MouseEvent) => {
        if (insideCard(event.target)) return;
        closeSoon();
      },
    },
    tooltip: hover
      ? createPortal(
          <VariableCard
            hover={hover}
            pinned={pinned}
            onPin={pin}
            onEnter={cancelClose}
            onLeave={closeSoon}
            onClose={close}
          />,
          document.body,
        )
      : null,
  };
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS
    ? `${value.slice(0, MAX_VALUE_CHARS)}…`
    : value;
}

/** The value line: what it resolves to, or why it does not. */
function Value({ info }: { info: VariableInfo }) {
  if (info.scope === "unknown") {
    return <span className="text-warn">not defined — sent as literal text</span>;
  }
  if (info.scope === "disabled") {
    return <span className="text-warn">switched off — sent as literal text</span>;
  }
  if (info.secret) {
    return info.empty ? (
      <span className="text-warn">secret, but empty</span>
    ) : (
      <span className="text-muted">
        <span className="text-ink">••••••••</span> secret, not shown here
      </span>
    );
  }
  if (info.empty) return <span className="text-muted italic">empty</span>;
  return (
    <span className="break-all whitespace-pre-wrap text-ink">
      {truncate(info.value)}
    </span>
  );
}

interface CardProps {
  hover: VariableHover;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}

function VariableCard({
  hover,
  pinned,
  onPin,
  onEnter,
  onLeave,
  onClose,
}: CardProps) {
  const environments = useEnvironmentsStore((s) => s.environments);
  const activeId = useEnvironmentsStore((s) => s.activeId);
  const collectionVariables = useEnvironmentsStore((s) => s.collectionVariables);
  const sessionVars = useEnvironmentsStore((s) => s.sessionVars);
  const update = useEnvironmentsStore((s) => s.update);
  const setVariables = useEnvironmentsStore((s) => s.setVariables);
  const setCollectionVariables = useEnvironmentsStore(
    (s) => s.setCollectionVariables,
  );

  /** Null in read mode; the text being typed while editing. */
  const [draft, setDraft] = useState<string | null>(null);

  const info = describeVariable(hover.name, {
    sessionVars,
    environment: environments.find((env) => env.id === activeId) ?? null,
    collectionVariables,
  });
  const target = info.target;

  /**
   * Saves as it is typed, the way every other field in this app does — the
   * store debounces the write. Nothing to commit means nothing to lose, so
   * Enter and Escape both just close.
   */
  function write(value: string) {
    if (!target) return;
    if (target.kind === "session") {
      // Handles both cases: with an environment active this writes there, and
      // without one it stays in the session, exactly as a script write would.
      setVariables({ [info.name]: value });
      return;
    }
    if (target.kind === "environment") {
      const environment = environments.find((env) => env.id === target.id);
      if (!environment) return;
      update(target.id, {
        variables: upsertVariable(environment.variables, info.name, value),
      });
      return;
    }
    setCollectionVariables(
      upsertVariable(collectionVariables, info.name, value),
    );
  }

  function begin() {
    if (!target) return;
    // A secret starts blank rather than revealing itself; typing replaces it.
    setDraft(info.secret ? "" : info.value);
    onPin(true);
  }

  function done() {
    setDraft(null);
    onPin(false);
    onClose();
  }

  const { rect } = hover;
  const below = window.innerHeight - rect.bottom > 160;
  const editing = draft !== null;

  return (
    <div
      className="wrk-var-tip"
      onMouseEnter={onEnter}
      onMouseLeave={() => {
        if (!pinned) onLeave();
      }}
      style={{
        width: CARD_WIDTH,
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8),
        ),
        ...(below
          ? { top: rect.bottom + 6 }
          : { bottom: window.innerHeight - rect.top + 6 }),
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate font-mono text-[11px] text-brand">
          {info.name}
        </span>
        <span className="ml-auto flex-none text-[10px] text-muted">
          {editing && target?.kind === "environment"
            ? target.name
            : editing && target?.kind === "collection"
              ? "Collection"
              : info.origin}
        </span>
      </div>

      {editing ? (
        <>
          <input
            autoFocus
            value={draft ?? ""}
            spellCheck={false}
            placeholder="value"
            className="wrk-field compact mono mt-1 w-full"
            onChange={(event) => {
              setDraft(event.target.value);
              write(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                done();
              }
              // Everything else must not reach the window handler that would
              // dismiss the card mid-word.
              event.stopPropagation();
            }}
            onBlur={done}
          />
          <div className="mt-1 text-[10px] text-muted">
            {info.secret
              ? "Replaces the secret — its current value is not shown."
              : info.scope === "unknown"
                ? "Saves as you type, creating the variable."
                : info.scope === "disabled"
                  ? "Saves as you type, and switches the variable back on."
                  : "Saves as you type. Enter or Esc to close."}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={!target}
            onClick={begin}
            title={target ? "Click to edit" : undefined}
            className={`mt-1 block max-h-24 w-full overflow-y-auto rounded text-left font-mono text-[11px] leading-relaxed ${
              target ? "wrk-var-edit" : "cursor-default"
            }`}
          >
            <Value info={info} />
          </button>
          {info.scope === "dynamic" && (
            <div className="mt-1 text-[10px] text-muted">
              An example — generated fresh for every request.
            </div>
          )}
        </>
      )}
    </div>
  );
}
