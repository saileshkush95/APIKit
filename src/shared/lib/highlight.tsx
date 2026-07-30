// Lightweight, line-oriented syntax highlighting.
//
// A full parser is overkill here: both the raw-body editor and the response
// viewer render one line at a time (the viewer is virtualized), so each line
// is tokenized independently against a small ordered rule set. Constructs
// that span lines — block comments, multi-line strings — may lose their
// colour on later lines; that is the accepted trade-off for being able to
// tokenize only the ~60 lines on screen.

import type { ReactNode } from "react";

export type HighlightLanguage =
  | "json"
  | "markup"
  | "yaml"
  | "javascript"
  | "graphql"
  | "none";

interface Rule {
  re: RegExp;
  cls: string;
}

export interface Token {
  text: string;
  cls?: string;
  /** Set on a `{{variable}}`, so hovering one can look its value up. */
  variable?: string;
}

// Semantic colours from the app palette, so highlighting follows the theme.
const KEY = "text-brand";
const STR = "text-ok";
const NUM = "text-warn";
const KWD = "text-redirect";
const COMMENT = "text-muted italic";
const PUNCT = "text-muted";
const TAG = "text-redirect";

const RULES: Record<Exclude<HighlightLanguage, "none">, Rule[]> = {
  json: [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, cls: KEY },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: STR },
    { re: /(?:-|\b)\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: NUM },
    { re: /\b(?:true|false|null)\b/y, cls: KWD },
    { re: /[{}[\],:]+/y, cls: PUNCT },
  ],
  yaml: [
    { re: /#.*/y, cls: COMMENT },
    { re: /[A-Za-z_][\w.-]*(?=\s*:(?:\s|$))/y, cls: KEY },
    { re: /"(?:[^"\\]|\\.)*"|'[^']*'/y, cls: STR },
    { re: /\b(?:true|false|null|yes|no)\b/y, cls: KWD },
    { re: /(?:-|\b)\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: NUM },
    { re: /-(?=\s)/y, cls: PUNCT },
  ],
  javascript: [
    { re: /\/\/.*/y, cls: COMMENT },
    { re: /\/\*.*?(?:\*\/|$)/y, cls: COMMENT },
    {
      re: /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?/y,
      cls: STR,
    },
    {
      re: /\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield)\b/y,
      cls: KWD,
    },
    { re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y, cls: KWD },
    {
      re: /\b0[xX][0-9a-fA-F]+\b|(?:-|\b)\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y,
      cls: NUM,
    },
  ],
  markup: [
    { re: /<!--.*?(?:-->|$)/y, cls: COMMENT },
    { re: /<!\[CDATA\[.*?(?:\]\]>|$)/y, cls: STR },
    { re: /<\/?[A-Za-z][\w.:-]*|<[!?][\w-]*|[?/]?>/y, cls: TAG },
    { re: /[\w.:-]+(?==)/y, cls: KEY },
    { re: /"[^"]*"?|'[^']*'?/y, cls: STR },
  ],
  graphql: [
    { re: /#.*/y, cls: COMMENT },
    { re: /"(?:[^"\\]|\\.)*"?/y, cls: STR },
    { re: /\$[A-Za-z_]\w*/y, cls: NUM },
    { re: /@[A-Za-z_]\w*/y, cls: KWD },
    {
      re: /\b(?:query|mutation|subscription|fragment|on|true|false|null)\b/y,
      cls: KWD,
    },
    { re: /[A-Za-z_]\w*(?=\s*:)/y, cls: KEY },
    { re: /(?:-|\b)\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: NUM },
  ],
};

/** `{{variable}}` tokens, shown in the editor whatever the language. */
const VARIABLE: Rule = { re: /\{\{[^{}\n]*\}\}/y, cls: "text-brand-bright" };
/** The same shape, for finding variables *inside* an already-matched token. */
const VARIABLE_INSIDE = /\{\{[^{}\n]*\}\}/g;

/** The name inside a `{{…}}`, when it is one that could resolve. */
function variableName(text: string): string | undefined {
  // `{{}}` and `{{a b}}` have the shape but resolve to nothing, so they are
  // coloured without being offered as something to look up.
  return /^\{\{\s*([\w.\-$]+)\s*\}\}$/.exec(text)?.[1];
}

/**
 * Pushes a matched token, splitting any `{{variables}}` out of it first.
 *
 * A rule like JSON's string or JavaScript's comment swallows a whole run, and
 * inside a string is where variables mostly live: `"Bearer {{token}}"`. First
 * match wins per position, so without this split the variable is invisible to
 * the one rule meant to find it — uncoloured, and with nothing to hover.
 */
function pushMatch(tokens: Token[], text: string, cls: string, split: boolean) {
  if (!split || !text.includes("{{")) {
    tokens.push({ text, cls, variable: variableName(text) });
    return;
  }
  let at = 0;
  for (const found of text.matchAll(VARIABLE_INSIDE)) {
    const start = found.index ?? 0;
    if (start > at) tokens.push({ text: text.slice(at, start), cls });
    tokens.push({
      text: found[0],
      cls: VARIABLE.cls,
      variable: variableName(found[0]),
    });
    at = start + found[0].length;
  }
  if (at < text.length) tokens.push({ text: text.slice(at), cls });
}

export function tokenizeLine(
  line: string,
  lang: HighlightLanguage,
  templateVariables = false,
): Token[] {
  const rules = [
    ...(templateVariables ? [VARIABLE] : []),
    ...(lang === "none" ? [] : RULES[lang]),
  ];
  if (rules.length === 0) return [{ text: line }];

  const tokens: Token[] = [];
  let plain = "";
  let i = 0;
  scan: while (i < line.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const match = rule.re.exec(line);
      if (match && match[0].length > 0) {
        if (plain !== "") {
          tokens.push({ text: plain });
          plain = "";
        }
        pushMatch(
          tokens,
          match[0],
          rule.cls,
          templateVariables && rule !== VARIABLE,
        );
        i += match[0].length;
        continue scan;
      }
    }
    plain += line[i];
    i += 1;
  }
  if (plain !== "") tokens.push({ text: plain });
  return tokens;
}

function tokenNode(token: Token, key: React.Key, from = 0, to?: number): ReactNode {
  const text = to === undefined ? token.text.slice(from) : token.text.slice(from, to);
  return token.cls ? (
    <span
      key={key}
      className={token.cls}
      // Marks property names so a click can tell a key from a value — the
      // response viewer copies the path for one and the value for the other.
      data-token={token.cls === KEY ? "key" : undefined}
      data-variable={token.variable}
    >
      {text}
    </span>
  ) : (
    <span key={key}>{text}</span>
  );
}

/**
 * One line, highlighted, with search matches wrapped in `<mark>`.
 * Returns a single space for an empty line so its row keeps its height.
 */
export function renderLine(
  line: string,
  lang: HighlightLanguage,
  needle = "",
): ReactNode {
  if (line === "") return " ";
  const tokens = tokenizeLine(line, lang);

  const ranges: [number, number][] = [];
  if (needle !== "") {
    const lower = line.toLowerCase();
    const target = needle.toLowerCase();
    let from = 0;
    for (;;) {
      const hit = lower.indexOf(target, from);
      if (hit === -1) break;
      ranges.push([hit, hit + target.length]);
      from = hit + target.length;
    }
  }

  if (ranges.length === 0) {
    return tokens.map((token, i) => tokenNode(token, i));
  }

  const parts: ReactNode[] = [];
  let offset = 0;
  let key = 0;
  for (const token of tokens) {
    const start = offset;
    const end = offset + token.text.length;
    let cursor = start;
    for (const [rangeStart, rangeEnd] of ranges) {
      if (rangeStart >= end) break;
      const from = Math.max(rangeStart, cursor);
      const to = Math.min(rangeEnd, end);
      if (to <= from) continue;
      if (from > cursor) parts.push(tokenNode(token, key++, cursor - start, from - start));
      parts.push(
        <mark key={key++} className="rounded bg-warn/40 text-ink">
          {token.text.slice(from - start, to - start)}
        </mark>,
      );
      cursor = to;
    }
    if (cursor < end) parts.push(tokenNode(token, key++, cursor - start));
    offset = end;
  }
  return parts;
}

/** Highlighted copy of an editor's full text, for the backdrop overlay. */
export function renderHighlighted(
  value: string,
  lang: HighlightLanguage,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) nodes.push("\n");
    tokenizeLine(lines[i], lang, true).forEach((token, j) => {
      nodes.push(tokenNode(token, `${i}:${j}`));
    });
  }
  return nodes;
}
