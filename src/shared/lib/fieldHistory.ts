// Per-field undo history that outlives the field.
//
// The browser already keeps an undo stack per input, and for plain typing it is
// the right one to use — see `lib/textEdit`, which exists to keep it intact.
// But it is tied to the DOM element: switching request tabs, changing body mode
// or any React re-render that assigns a new `value` throws it away. So undo
// worked until you looked away and came back, which is when you need it.
//
// This keeps a history per *field identity* rather than per element, in a module
// registry, so it survives unmount. It is deliberately scoped to the focused
// field: the handler lives on the field itself, so Cmd+Z there can never touch
// anything else.

import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import { typeInto } from "./textEdit";

type TextField = HTMLInputElement | HTMLTextAreaElement;

export interface Snapshot {
  value: string;
  /** Where the caret was while this value was the current one. */
  caret: number;
}

/** What the last edit did, so like can be grouped with like. */
export type EditKind = "insert" | "delete" | "replace" | "none";

export interface FieldHistory {
  past: Snapshot[];
  future: Snapshot[];
  current: Snapshot;
  /** When `current` was recorded, for grouping. */
  at: number;
  kind: EditKind;
  /**
   * Whether the current step can still absorb the next edit.
   *
   * Closed by anything that reads as the end of something: whitespace, a paste,
   * a replacement, or a restored snapshot. Undo then steps back a word at a
   * time and never mixes a paste in with what was typed after it.
   */
  open: boolean;
  /** Characters merged into the current step, so a run cannot grow unbounded. */
  run: number;
}

/** Keystrokes closer together than this are one undo step. */
const COALESCE_MS = 600;
/**
 * Characters one step may absorb before a new one starts.
 *
 * Without this, fast typing with no spaces in it — a long token, a base64
 * string — becomes a single step, and one Cmd+Z takes the lot. Whitespace
 * already breaks runs; this bounds the case where there is none.
 */
const MAX_RUN = 80;
/** Undo steps kept per field. */
const LIMIT = 200;
/** Fields whose history is kept, oldest evicted first. */
const KEEP_FIELDS = 400;

/**
 * The prefix every key under this part of the tree is scoped by — the active
 * workspace, then the tab, then the list a row belongs to. Composed rather than
 * stored: a field's identity is *where it is*, and putting an id in the data to
 * describe that would change what gets persisted and exported for the sake of
 * an undo stack.
 *
 * Nested by `HistoryScope`, so `workspace:tab:headers:#2:value` is built from
 * four places that each only know their own part.
 */
export const HistoryScopeContext = createContext("");

const histories = new Map<string, FieldHistory>();

/**
 * When the newest structural step was taken, anywhere — a removed row, a
 * cleared list. See `lib/valueHistory`, which maintains it.
 *
 * Undo has to reverse *the last thing that happened*. Field histories and
 * structural ones are separate stacks by design, so without a shared sense of
 * recency deleting a row and pressing Cmd+Z in a cell would undo that cell's
 * typing from minutes ago and leave the row deleted. This is the one number
 * that lets the two stacks agree on whose turn it is.
 */
let newestStructural = 0;

export function markStructuralStep(at: number): void {
  newestStructural = at;
}

export function newestStructuralStep(): number {
  return newestStructural;
}

/**
 * Set while a structural change is being applied to the fields it contains.
 *
 * Restoring a removed row rewrites the cells around it, and one of them may be
 * the focused field. Without this, that field reads its own rewrite as typing,
 * claims to hold the most recent edit, and swallows the next undo — so the
 * chord never reaches the list it belongs to.
 */
let applyingStructural = 0;

export function markStructuralApply(): void {
  applyingStructural++;
  const release = () => {
    applyingStructural = Math.max(0, applyingStructural - 1);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
  else setTimeout(release, 0);
}

export function structuralApplyInFlight(): boolean {
  return applyingStructural > 0;
}

function fresh(value: string): FieldHistory {
  return {
    past: [],
    future: [],
    current: { value, caret: value.length },
    at: 0,
    kind: "none",
    open: false,
    run: 0,
  };
}

export function historyFor(key: string, value: string): FieldHistory {
  const found = histories.get(key);
  if (found) return found;
  const created = fresh(value);
  histories.set(key, created);
  // Bounded so a long session cannot grow this without limit. Map iterates in
  // insertion order, so the front is the least recently created.
  while (histories.size > KEEP_FIELDS) {
    const oldest = histories.keys().next();
    if (oldest.done) break;
    histories.delete(oldest.value);
  }
  return created;
}

export function setFieldHistory(key: string, history: FieldHistory): void {
  histories.set(key, history);
}

/** For tests, and for a workspace switch, where the old keys mean nothing. */
export function clearFieldHistories(): void {
  histories.clear();
}

/** What changed between two values: one edit, located. */
export function classify(
  before: string,
  after: string,
): { kind: EditKind; at: number; added: string; removed: string } {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }

  const removed = before.slice(start, endBefore);
  const added = after.slice(start, endAfter);
  const kind: EditKind =
    added !== "" && removed !== ""
      ? "replace"
      : added !== ""
        ? "insert"
        : removed !== ""
          ? "delete"
          : "none";
  return { kind, at: start, added, removed };
}

/**
 * Whether a change of this shape can be grouped at all.
 *
 * One typed or deleted character, and not whitespace — whitespace ends a word,
 * and a step that ended a word should not continue into the next one.
 */
function groupable(kind: EditKind, added: string, removed: string): boolean {
  if (kind !== "insert" && kind !== "delete") return false;
  if (added.length + removed.length !== 1) return false;
  return !/\s/.test(added + removed);
}

/** Whether this change continues the run already recorded. */
function joinsRun(
  history: FieldHistory,
  kind: EditKind,
  groups: boolean,
  now: number,
): boolean {
  if (!history.open || !groups) return false;
  if (now - history.at > COALESCE_MS) return false;
  if (history.run >= MAX_RUN) return false;
  return kind === history.kind;
}

/** Records `value` as the field's current state. */
export function record(
  history: FieldHistory,
  value: string,
  caret: number,
  now: number,
): FieldHistory {
  if (value === history.current.value) return history;
  const { kind, added, removed } = classify(history.current.value, value);
  const groups = groupable(kind, added, removed);
  const joins = joinsRun(history, kind, groups, now);
  const past = joins
    ? history.past
    : [...history.past, history.current].slice(-LIMIT);
  // Any new edit abandons the redo branch, as it does in every editor.
  return {
    past,
    future: [],
    current: { value, caret },
    at: now,
    kind,
    open: groups,
    run: joins ? history.run + 1 : 1,
  };
}

export function undo(
  history: FieldHistory,
): { history: FieldHistory; snapshot: Snapshot } | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return {
    snapshot: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [history.current, ...history.future].slice(0, LIMIT),
      current: previous,
      // Closed, so the next keystroke starts its own step rather than merging
      // into whatever run was interrupted.
      at: 0,
      kind: "none",
      open: false,
      run: 0,
    },
  };
}

export function redo(
  history: FieldHistory,
): { history: FieldHistory; snapshot: Snapshot } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    snapshot: next,
    history: {
      past: [...history.past, history.current].slice(-LIMIT),
      future: history.future.slice(1),
      current: next,
      at: 0,
      kind: "none",
      open: false,
      run: 0,
    },
  };
}

/** True for the platform's undo and redo chords. */
export function undoChord(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): "undo" | "redo" | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  // Windows' other redo chord.
  if (key === "y" && event.ctrlKey && !event.metaKey) return "redo";
  return null;
}

/**
 * Gives a field an undo history of its own, keyed by `key`.
 *
 * Pass no key to leave the browser's own handling alone — which is correct for
 * a field with no stable identity, since a history that attached itself to the
 * wrong field would be worse than none.
 */
export function useFieldHistory(
  key: string | undefined,
  value: string,
  element: RefObject<TextField | null>,
  /** Only needed where `execCommand` cannot be used; the field is the path. */
  onChange?: (value: string) => void,
) {
  const scope = useContext(HistoryScopeContext);
  // A field with no key keeps the browser's own undo, whatever the scope.
  key = key === undefined ? undefined : scope ? `${scope}:${key}` : key;
  const known = useRef(value);
  /**
   * The value this hook itself just applied, so it is not recorded as an edit.
   *
   * The value rather than a flag: a flag left set — because the change it was
   * waiting for never arrived — silently swallows the next real edit, which is
   * a much worse failure than recording one undo step too many.
   */
  const applied = useRef<string | null>(null);

  const caret = () => element.current?.selectionStart ?? value.length;

  // Bind to the stored history. A value that changed while this field was
  // unmounted is recorded, so the first undo does not jump to a stale one.
  useEffect(() => {
    if (!key) return;
    const stored = historyFor(key, value);
    if (stored.current.value !== value) {
      setFieldHistory(key, record(stored, value, caret(), Date.now()));
    }
    known.current = value;
    // Only on identity change: this is about which history to use, not about
    // tracking the value, which the effect below does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Every change is recorded here rather than in the component's onChange, so
  // a write from anywhere — a script, a pull, a paste — is undoable too.
  useEffect(() => {
    if (!key) return;
    if (value === known.current) return;
    known.current = value;
    if (applied.current === value) {
      applied.current = null;
      return;
    }
    // A change that arrives while the field is not focused was not typed here:
    // it is a script write, a pull, or the fallout of a structural change like
    // a removed row. It is recorded so it can be undone, but timestamped zero
    // so it does not claim to be the most recent *action* — otherwise undoing
    // a deleted row would lose to the rewrite that deletion caused.
    const typed =
      !structuralApplyInFlight() && document.activeElement === element.current;
    setFieldHistory(
      key,
      record(historyFor(key, value), value, caret(), typed ? Date.now() : 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, key]);

  function apply(snapshot: Snapshot) {
    applied.current = snapshot.value;
    const field = element.current;
    // Through the field, so the browser's own stack stays in step with ours.
    if (!typeInto(field, snapshot.value, 0, field?.value.length ?? 0)) {
      onChange?.(snapshot.value);
    }
    requestAnimationFrame(() => {
      field?.setSelectionRange(snapshot.caret, snapshot.caret);
      // Whatever happened, stop expecting it: a token left behind would make
      // the next edit that happens to match it invisible to the history.
      applied.current = null;
    });
  }

  /** Returns true when the event was an undo or redo and has been handled. */
  function handleKey(event: React.KeyboardEvent): boolean {
    if (!key) return false;
    const which = undoChord(event);
    if (!which) return false;

    const stored = historyFor(key, value);
    // A structural change made after this field's last edit is the more recent
    // action, so it is the one to reverse — let the chord reach the list.
    if (which === "undo" && newestStructural > stored.at) return false;
    const step = which === "undo" ? undo(stored) : redo(stored);
    // Nothing left in this field's own history: let the chord through so an
    // enclosing structural history can take it — undoing the text first and
    // then, once there is no text left, the row that held it.
    if (!step) return false;
    event.preventDefault();
    setFieldHistory(key, step.history);
    apply(step.snapshot);
    return true;
  }

  return { handleKey };
}
