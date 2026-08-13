// Folding for the editable code editor.
//
// The response viewer can fold freely — it draws its own lines, so hiding one
// is a matter of not drawing it. An editor cannot: a textarea renders exactly
// the string it holds, and there is nowhere to put a line that is present but
// unseen.
//
// So the textarea holds a *projection* — the text minus the folded lines — and
// the full text stays with the parent, unchanged and complete. Everything the
// editor does (typing, pairing, completion, undo) happens against the
// projection, and each edit is mapped back onto the full text here. With
// nothing folded the projection is the text itself and every function below is
// an identity, which is what keeps the editors that never fold anything exactly
// as they were.

import type { HighlightLanguage } from "./highlight";

const OPENERS: Record<string, string> = { "{": "}", "[": "]" };

/**
 * Where each multi-line block starts and ends, as line indices: `{` and `[`
 * matched across the text, ignoring anything inside a string or a comment.
 * Blocks that open and close on one line are left out — there is nothing in
 * them to hide.
 */
export function foldRanges(
  text: string,
  language: HighlightLanguage,
): Map<number, number> {
  const ranges = new Map<number, number>();
  // `#` starts a comment in GraphQL; in JSON a stray `#` is just a character,
  // and treating it as a comment would swallow real braces.
  const comments = language === "graphql";
  const stack: { closer: string; line: number }[] = [];
  let line = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === "\n") {
      line += 1;
      i += 1;
      continue;
    }

    if (comments && char === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    // A GraphQL block string runs over lines, so it has to be skipped whole or
    // a brace inside it would open a block that never closes.
    if (comments && text.startsWith('"""', i)) {
      i += 3;
      while (i < text.length && !text.startsWith('"""', i)) {
        if (text[i] === "\n") line += 1;
        i += 1;
      }
      i += 3;
      continue;
    }

    if (char === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        // A backslash escapes the next character, closing quote included.
        if (text[i] === "\\") i += 1;
        if (text[i] === "\n") line += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    const closer = OPENERS[char];
    if (closer !== undefined) {
      stack.push({ closer, line });
      i += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      const top = stack.pop();
      // A closer with no opener is half-typed text, not a block; the rest of
      // the document still folds.
      if (top && top.closer === char && line > top.line) {
        ranges.set(top.line, line);
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return ranges;
}

/**
 * The lines a set of folds hides: everything strictly between each block's
 * braces. The closing brace stays visible on purpose — a folded query still
 * shows balanced braces, which is most of what makes it readable folded.
 *
 * Folds inside other folds are simply subsumed; the union is what matters.
 */
export function hiddenLines(
  folds: Iterable<number>,
  ranges: Map<number, number>,
): Set<number> {
  const hidden = new Set<number>();
  for (const open of folds) {
    const close = ranges.get(open);
    if (close === undefined) continue;
    for (let line = open + 1; line < close; line += 1) hidden.add(line);
  }
  return hidden;
}

/** Which lines of the full text the projection shows, in order. */
export function visibleLines(count: number, hidden: Set<number>): number[] {
  const visible: number[] = [];
  for (let line = 0; line < count; line += 1) {
    if (!hidden.has(line)) visible.push(line);
  }
  return visible;
}

/** Start offset of every line of `text`. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** The projection: the full text with the hidden lines dropped. */
export function project(lines: string[], visible: number[]): string {
  return visible.map((line) => lines[line]).join("\n");
}

/** A projection offset, as the line it falls on and how far into it. */
function locate(text: string, offset: number): { row: number; column: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    row: lastBreak === -1 ? 0 : before.split("\n").length - 1,
    column: offset - (lastBreak + 1),
  };
}

/** Turns a projection offset into the offset of the same character in the full text. */
export function toFullOffset(
  shown: string,
  offset: number,
  visible: number[],
  starts: number[],
  fullLength: number,
): number {
  const { row, column } = locate(shown, offset);
  const line = visible[row];
  if (line === undefined) return fullLength;
  return Math.min(starts[line] + column, fullLength);
}

/** Length of one line of `text`, without its newline. */
function lineLength(text: string, starts: number[], line: number): number {
  const end = starts[line + 1] ?? text.length + 1;
  return end - starts[line] - 1;
}

/** Turns a full-text offset into the offset of the same character in the projection. */
export function toShownOffset(
  full: string,
  offset: number,
  visible: number[],
  starts: number[],
  shownLength: number,
): number {
  const { row: line, column } = locate(full, offset);
  let row = visible.indexOf(line);
  let column_ = column;
  if (row === -1) {
    // The caret sat on a line that has just been folded away. The nearest
    // place it can still be is the end of the line that swallowed it.
    let above = line;
    while (above >= 0 && !visible.includes(above)) above -= 1;
    if (above < 0) return 0;
    row = visible.indexOf(above);
    column_ = lineLength(full, starts, above);
  }
  return Math.min(
    offsetOfRow(full, visible, starts, row) + column_,
    shownLength,
  );
}

/** Where a projection row begins, in projection offsets. */
function offsetOfRow(
  full: string,
  visible: number[],
  starts: number[],
  row: number,
): number {
  let offset = 0;
  for (let i = 0; i < row; i += 1) {
    const line = visible[i];
    const end = starts[line + 1] ?? full.length + 1;
    offset += end - starts[line];
  }
  return offset;
}

/**
 * The edit that turned `before` into `after`, as a replacement of one span.
 *
 * Taken as the text that is no longer common to both ends, which is what a
 * single edit — a keystroke, a paste, a delete, an undo — always leaves. It is
 * not the *minimal* edit for every possible pair of strings, and it does not
 * need to be: any span that covers the change maps back correctly, because the
 * text on either side of it is identical by construction.
 */
export function diffSpan(
  before: string,
  after: string,
): { from: number; to: number; text: string } {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Maps an edit made in the projection onto the full text.
 *
 * An edit that reaches across a fold takes the hidden lines with it — deleting
 * a folded block deletes the block, which is what every editor does and what
 * anyone selecting over it means.
 */
export function applyShownEdit(
  full: string,
  shown: string,
  nextShown: string,
  visible: number[],
): { text: string; fromLine: number; toLine: number; delta: number } {
  const starts = lineStarts(full);
  const span = diffSpan(shown, nextShown);
  const from = toFullOffset(shown, span.from, visible, starts, full.length);
  const to = toFullOffset(shown, span.to, visible, starts, full.length);
  const text = full.slice(0, from) + span.text + full.slice(Math.max(from, to));
  const countLines = (value: string) => value.split("\n").length;
  return {
    text,
    fromLine: countLines(full.slice(0, from)) - 1,
    toLine: countLines(full.slice(0, Math.max(from, to))) - 1,
    delta: countLines(text) - countLines(full),
  };
}

/**
 * Moves the folds an edit displaced. A fold whose opening line the edit touched
 * is dropped rather than guessed at, and every fold is checked against the
 * blocks the new text actually has — so a fold never outlives its block.
 */
export function shiftFolds(
  folds: Iterable<number>,
  edit: { fromLine: number; toLine: number; delta: number },
  ranges: Map<number, number>,
): Set<number> {
  const next = new Set<number>();
  for (const open of folds) {
    if (open < edit.fromLine) {
      if (ranges.has(open)) next.add(open);
    } else if (open > edit.toLine) {
      const moved = open + edit.delta;
      if (ranges.has(moved)) next.add(moved);
    }
  }
  return next;
}
