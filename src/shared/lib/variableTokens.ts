// Splitting text around {{variables}}, for highlighting and completion.

export interface Token {
  text: string;
  /** Variable name when this token is a `{{…}}`, otherwise undefined. */
  name?: string;
  /** Whether the active environment defines it. */
  known?: boolean;
}

const VARIABLE = /\{\{\s*([\w.\-$]+)\s*\}\}/g;

export function tokenize(input: string, vars: Record<string, string>): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  for (const match of input.matchAll(VARIABLE)) {
    const start = match.index ?? 0;
    if (start > index) tokens.push({ text: input.slice(index, start) });
    tokens.push({
      text: match[0],
      name: match[1],
      known: match[1] in vars,
    });
    index = start + match[0].length;
  }

  if (index < input.length) tokens.push({ text: input.slice(index) });
  return tokens;
}

/**
 * If the caret sits inside an unclosed `{{`, returns what has been typed so
 * far and where it starts — that is when completions should be offered.
 */
export function openVariable(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open === -1) return null;

  // Already closed, so the caret is past the variable rather than inside it.
  const between = before.slice(open + 2);
  if (between.includes("}}")) return null;
  // A newline means the braces were never meant as a variable.
  if (between.includes("\n")) return null;

  return { query: between.trim(), start: open };
}

/** Replaces the open `{{…` at `start` with a complete `{{name}}`. */
export function completeVariable(
  value: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  // Swallow a closing brace the user already typed, so `{{to}}` does not
  // become `{{token}}}}`.
  let after = caret;
  if (value.slice(after, after + 2) === "}}") after += 2;

  const inserted = `{{${name}}}`;
  return {
    value: value.slice(0, start) + inserted + value.slice(after),
    caret: start + inserted.length,
  };
}
