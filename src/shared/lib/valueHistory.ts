// Undo for changes a text field cannot hold: a deleted row, a cleared list, a
// list replaced wholesale from bulk text.
//
// Field history (see `lib/fieldHistory`) covers the characters inside a field.
// It cannot cover a field that no longer exists — remove a header row and there
// is nothing left to press Cmd+Z in. This is the other half: a stack of whole
// values, one step per action, scoped the same way.
//
// Steps are committed explicitly by the code performing the action rather than
// inferred by diffing. The grid knows the difference between "a row was
// deleted" and "someone typed a character"; a diff would have to guess, and
// guessing wrong means either a structural change with no way back or an undo
// stack that duplicates every keystroke.

import { useContext, useEffect, useRef } from "react";
import {
  HistoryScopeContext,
  markStructuralApply,
  markStructuralStep,
  undoChord,
} from "./fieldHistory";

interface Step<T> {
  value: T;
  /** When the action was taken, so undo can reverse the most recent one. */
  at: number;
  /**
   * Order in which steps were undone, for the redo side.
   *
   * Redo has to reapply what was undone *last*, which is not the same as the
   * newest by `at`: undoing an old step makes it the next thing to redo.
   */
  undone?: number;
}

interface Stack<T> {
  past: Step<T>[];
  future: Step<T>[];
}

/** Steps kept per list. */
const LIMIT = 100;
/** Lists whose history is kept, oldest evicted first. */
const KEEP = 200;

const stacks = new Map<string, Stack<unknown>>();

/** Monotonic, so undos can be ordered across stacks. */
let undoClock = 0;

function stackFor<T>(key: string): Stack<T> {
  const found = stacks.get(key);
  if (found) return found as Stack<T>;
  const created: Stack<T> = { past: [], future: [] };
  stacks.set(key, created as Stack<unknown>);
  while (stacks.size > KEEP) {
    const oldest = stacks.keys().next();
    if (oldest.done) break;
    stacks.delete(oldest.value);
  }
  return created;
}

/** For tests, and for a workspace switch, where the old keys mean nothing. */
export function clearValueHistories(): void {
  stacks.clear();
  markStructuralStep(0);
}

/**
 * The stack holding the most recent structural step, and when it was taken.
 *
 * There is more than one structural stack in play — every key/value grid has
 * one, and so does the collection tree. Undo has to reverse the last action, so
 * they need to agree on whose turn it is; recomputing from the stacks keeps that
 * answer correct without every mutation having to maintain it.
 */
function newest(): { key: string; at: number } | null {
  let best: { key: string; at: number } | null = null;
  for (const [key, stack] of stacks) {
    const top = stack.past[stack.past.length - 1];
    if (top && (best === null || top.at > best.at)) best = { key, at: top.at };
  }
  return best;
}

export function newestStackKey(): string | null {
  return newest()?.key ?? null;
}

/** The stack whose step was undone most recently — the one a redo belongs to. */
export function newestRedoKey(): string | null {
  let best: { key: string; undone: number } | null = null;
  for (const [key, stack] of stacks) {
    const next = stack.future[0];
    const undone = next?.undone ?? 0;
    if (next && (best === null || undone > best.undone)) best = { key, undone };
  }
  return best?.key ?? null;
}

/** Republishes the watermark the field histories arbitrate against. */
function republish(): void {
  markStructuralStep(newest()?.at ?? 0);
}

export function commitValue<T>(key: string, before: T, now = Date.now()): void {
  const stack = stackFor<T>(key);
  stack.past.push({ value: before, at: now });
  if (stack.past.length > LIMIT) stack.past.shift();
  // A new action abandons the redo branch, as it does in every editor.
  stack.future = [];
  republish();
}

export function undoValue<T>(key: string, current: T): T | null {
  const stack = stackFor<T>(key);
  const previous = stack.past.pop();
  if (!previous) return null;
  stack.future.unshift({ value: current, at: previous.at, undone: ++undoClock });
  if (stack.future.length > LIMIT) stack.future.pop();
  // The step has been reversed, so the next chord belongs to whatever came
  // before it — often a field's own typing.
  republish();
  return previous.value;
}

export function redoValue<T>(key: string, current: T, now = Date.now()): T | null {
  const stack = stackFor<T>(key);
  const next = stack.future.shift();
  if (!next) return null;
  // Reapplying it makes it the most recent action again.
  stack.past.push({ value: current, at: now });
  republish();
  return next.value;
}

/**
 * A structural undo stack for one list, scoped like a field's.
 *
 * `commit(before)` is called immediately before a change that a field history
 * cannot represent. `handleKey` goes on the element containing the list: the
 * focused field gets the chord first and only declines it when its own history
 * is exhausted, so typing undoes text and then, once there is no text left to
 * undo, the structure.
 */
export function useValueHistory<T>(
  id: string | undefined,
  value: T,
  onChange: (value: T) => void,
  options?: {
    /**
     * Listen on the window rather than waiting for the chord to bubble out of
     * this subtree. For a document-wide list — the collection tree — where the
     * focus is usually somewhere else entirely when you reach for undo.
     */
     global?: boolean;
  },
) {
  const scope = useContext(HistoryScopeContext);
  const key = id === undefined ? undefined : scope ? `${scope}:${id}` : id;
  // Read at keypress time, so the handler never works from a stale render.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  function commit(before: T) {
    if (key) commitValue(key, before);
  }

  function handleKey(event: React.KeyboardEvent): boolean {
    if (!key) return false;
    // The focused field got there first and used its own history. Preventing
    // the default does not stop the event bubbling here, so this is the check
    // that keeps one chord from undoing at two levels at once.
    if (event.defaultPrevented) return false;
    const which = undoChord(event);
    if (!which) return false;
    // Another list was changed — or undone — more recently; acting here would
    // skip over what the user actually did last.
    if (which === "undo" ? newestStackKey() !== key : newestRedoKey() !== key) {
      return false;
    }
    const next =
      which === "undo"
        ? undoValue<T>(key, latest.current)
        : redoValue<T>(key, latest.current);
    if (next === null) return false;
    event.preventDefault();
    markStructuralApply();
    onChange(next);
    return true;
  }

  // Kept in a ref so the window listener below is installed once rather than
  // re-added on every render.
  const apply = useRef(onChange);
  useEffect(() => {
    apply.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!options?.global || !key) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A focused field with history of its own has already handled it.
      if (event.defaultPrevented) return;
      const which = undoChord(event);
      if (!which) return;
      if (which === "undo" ? newestStackKey() !== key : newestRedoKey() !== key) {
        return;
      }
      const next =
        which === "undo"
          ? undoValue<T>(key, latest.current)
          : redoValue<T>(key, latest.current);
      if (next === null) return;
      // Also stops the browser undoing the focused field underneath us.
      event.preventDefault();
      markStructuralApply();
      apply.current(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, options?.global]);

  return { commit, handleKey };
}
