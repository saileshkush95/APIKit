// Markdown <-> the rich editor's document, in both directions.
//
// Docs stay Markdown on disk. They are exported as an OpenAPI/Postman
// `description`, imported from the same fields, synced to peers and committed
// to Git, and every one of those speaks Markdown — storing the editor's own
// JSON would make the format private to this app.
//
// The subset handled here is the same one `lib/markdown` renders: headings,
// bullet and numbered lists, quotes, fenced code, rules, tables, images, and
// inline code/bold/italic/strike/highlight/link.
//
// Two things Markdown has no syntax for — text alignment and colour — are kept
// the way people already write them in Markdown files and GitHub renders them:
// `<p align="center">` and `<span style="color:#rrggbb">`. `lib/markdown` lets
// exactly those two through its escaping and nothing else, so a doc from a peer
// still cannot smuggle markup in.
//
// Nested lists are the one thing still flattened on the way in.

export interface RichMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A ProseMirror node, as the editor serializes it to JSON. */
export interface RichNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: RichMark[];
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
/** `<p align="center">…</p>` and `<h2 align="center">…</h2>`, as written by hand
    in Markdown files everywhere GitHub renders them. */
const ALIGNED_P = /^\s*<p align="(left|center|right|justify)">([\s\S]*)<\/p>\s*$/;
const ALIGNED_H = /^\s*<h([1-6]) align="(left|center|right|justify)">([\s\S]*)<\/h\1>\s*$/;
/** A GFM table's alignment row: `|:---|:--:|---:|`. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```(\S*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>/;

/**
 * Link targets are limited to http(s), as in the Markdown renderer: docs can
 * arrive from a peer over LAN sync, and `javascript:` in a doc someone else
 * wrote must never become a live link in this webview.
 */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    ALIGNED_P.test(line) ||
    ALIGNED_H.test(line) ||
    line.trimStart().startsWith("|")
  );
}

/**
 * Image and link targets are limited the same way: http(s), plus `data:image`
 * for a picture pasted straight into the editor. Anything else — `javascript:`
 * above all — is kept as text so a doc from a peer cannot become a live target.
 */
function safeSrc(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|data:image\/[a-z+]+;base64,)/i.test(trimmed) ? trimmed : null;
}

/** Splits a table row on unescaped pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignmentsOf(rule: string): (string | null)[] {
  return cells(rule).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

// ---------------------------------------------------------------- Markdown in

const INLINE = new RegExp(
  [
    "`([^`]+)`", // 1 code
    "!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)", // 2 alt, 3 src
    "\\[([^\\]]*)\\]\\(([^)\\s]+)\\)", // 4 label, 5 href
    "<span style=\"color:\\s*(#[0-9a-fA-F]{3,8})\">([\\s\\S]*?)</span>", // 6 colour, 7 body
    "\\*\\*([\\s\\S]+?)\\*\\*", // 8 bold
    "==([\\s\\S]+?)==", // 9 highlight
    "~~([\\s\\S]+?)~~", // 10 strike
    "\\*([\\s\\S]+?)\\*", // 11 italic
  ].join("|"),
  "g",
);

function text(value: string, marks: RichMark[]): RichNode {
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function inline(source: string, marks: RichMark[] = []): RichNode[] {
  const out: RichNode[] = [];
  let at = 0;
  for (const match of source.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > at) out.push(text(source.slice(at, start), marks));
    if (match[1] !== undefined) {
      // Code is literal: no marks are parsed inside it.
      out.push(text(match[1], [...marks, { type: "code" }]));
    } else if (match[3] !== undefined) {
      const src = safeSrc(match[3]);
      if (src) out.push({ type: "image", attrs: { src, alt: match[2] || null } });
      else out.push(text(match[0], marks));
    } else if (match[5] !== undefined) {
      const href = safeHref(match[5]);
      if (href) {
        out.push(...inline(match[4], [...marks, { type: "link", attrs: { href } }]));
      } else {
        // Not a link this app will follow, so it stays as the text it was.
        out.push(text(match[0], marks));
      }
    } else if (match[6] !== undefined) {
      out.push(
        ...inline(match[7], [
          ...marks,
          { type: "textStyle", attrs: { color: match[6] } },
        ]),
      );
    } else if (match[8] !== undefined) {
      out.push(...inline(match[8], [...marks, { type: "bold" }]));
    } else if (match[9] !== undefined) {
      out.push(...inline(match[9], [...marks, { type: "highlight" }]));
    } else if (match[10] !== undefined) {
      out.push(...inline(match[10], [...marks, { type: "strike" }]));
    } else if (match[11] !== undefined) {
      out.push(...inline(match[11], [...marks, { type: "italic" }]));
    }
    at = start + match[0].length;
  }
  if (at < source.length) out.push(text(source.slice(at), marks));
  return out;
}

/**
 * One paragraph from consecutive lines, joined by hard breaks.
 *
 * Real Markdown folds them into one wrapped line; `lib/markdown` renders each
 * as its own paragraph. Hard breaks match what is on screen *and* round-trip
 * exactly — the alternative turns every single newline into a blank line the
 * first time a doc is opened.
 */
function paragraph(lines: string[]): RichNode {
  const content: RichNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...inline(line));
  });
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

function listItem(body: string): RichNode {
  return { type: "listItem", content: [paragraph([body])] };
}

function blocks(lines: string[]): RichNode[] {
  const out: RichNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i += 1; // the closing fence, or the end of the input
      const code = body.join("\n");
      out.push({
        type: "codeBlock",
        attrs: { language: fence[1] || null },
        ...(code === "" ? {} : { content: [{ type: "text", text: code }] }),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inline(heading[2]),
      });
      i += 1;
      continue;
    }

    // Alignment, which Markdown itself cannot express.
    const alignedHeading = ALIGNED_H.exec(line);
    if (alignedHeading) {
      out.push({
        type: "heading",
        attrs: { level: Number(alignedHeading[1]), textAlign: alignedHeading[2] },
        content: inline(alignedHeading[3]),
      });
      i += 1;
      continue;
    }

    const alignedParagraph = ALIGNED_P.exec(line);
    if (alignedParagraph) {
      out.push({
        ...paragraph([alignedParagraph[2]]),
        attrs: { textAlign: alignedParagraph[1] },
      });
      i += 1;
      continue;
    }

    // A GFM table: a header row, an alignment rule, then the body.
    if (
      line.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_RULE.test(lines[i + 1])
    ) {
      const align = alignmentsOf(lines[i + 1]);
      const header = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        body.push(cells(lines[i++]));
      }
      const row = (values: string[], kind: "tableHeader" | "tableCell") => ({
        type: "tableRow",
        content: header.map((_, column) => ({
          type: kind,
          attrs: { colspan: 1, rowspan: 1, colwidth: null },
          content: [
            {
              ...paragraph([values[column] ?? ""]),
              ...(align[column] ? { attrs: { textAlign: align[column] } } : {}),
            },
          ],
        })),
      });
      out.push({
        type: "table",
        content: [
          row(header, "tableHeader"),
          ...body.map((values) => row(values, "tableCell")),
        ],
      });
      continue;
    }

    // Before the bullet rule: `---` is a rule, `- x` is an item.
    if (RULE.test(line)) {
      out.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      const content = blocks(inner);
      out.push({
        type: "blockquote",
        content: content.length > 0 ? content : [{ type: "paragraph" }],
      });
      continue;
    }

    if (BULLET.test(line)) {
      const items: RichNode[] = [];
      let match: RegExpExecArray | null;
      while (i < lines.length && (match = BULLET.exec(lines[i]))) {
        items.push(listItem(match[1]));
        i += 1;
      }
      out.push({ type: "bulletList", content: items });
      continue;
    }

    if (ORDERED.test(line)) {
      const first = Number(ORDERED.exec(line)?.[1] ?? 1);
      const items: RichNode[] = [];
      let match: RegExpExecArray | null;
      while (i < lines.length && (match = ORDERED.exec(lines[i]))) {
        items.push(listItem(match[2]));
        i += 1;
      }
      out.push({ type: "orderedList", attrs: { start: first }, content: items });
      continue;
    }

    const chunk: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      chunk.push(lines[i++]);
    }
    out.push(paragraph(chunk));
  }

  return out;
}

/** Markdown as an editor document. Never empty: ProseMirror needs a block. */
export function markdownToDoc(source: string): RichNode {
  const content = blocks(source.replace(/\r\n?/g, "\n").split("\n"));
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

// --------------------------------------------------------------- Markdown out

function has(marks: RichMark[] | undefined, type: string): boolean {
  return marks?.some((mark) => mark.type === type) ?? false;
}

function sameMarks(a: RichMark[] = [], b: RichMark[] = []): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Innermost first, so a bold link reads `[**x**](url)` and not `**[x](url)**`. */
function wrap(value: string, marks: RichMark[] = []): string {
  let out = value;
  if (has(marks, "code")) out = `\`${out}\``;
  if (has(marks, "bold")) out = `**${out}**`;
  if (has(marks, "italic")) out = `*${out}*`;
  if (has(marks, "strike")) out = `~~${out}~~`;
  if (has(marks, "highlight")) out = `==${out}==`;
  const color = marks.find((mark) => mark.type === "textStyle")?.attrs?.color;
  if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
    out = `<span style="color:${color}">${out}</span>`;
  }
  const href = marks.find((mark) => mark.type === "link")?.attrs?.href;
  if (typeof href === "string" && href !== "") out = `[${out}](${href})`;
  return out;
}

function inlineText(nodes: RichNode[] | undefined): string {
  if (!nodes) return "";
  // Adjacent runs carrying the same marks are merged first: emitting each as
  // its own `**…**` would leave `**a****b**`, which reads back as literal
  // asterisks.
  const runs: { text: string; marks?: RichMark[] }[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      runs.push({ text: "\n" });
      continue;
    }
    if (node.type === "image") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      runs.push({ text: `![${alt}](${src})` });
      continue;
    }
    if (node.text === undefined) {
      runs.push({ text: inlineText(node.content) });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && sameMarks(last.marks, node.marks) && node.text !== "") {
      last.text += node.text;
    } else {
      runs.push({ text: node.text, marks: node.marks });
    }
  }
  return runs.map((run) => (run.marks ? wrap(run.text, run.marks) : run.text)).join("");
}

function prefixLines(value: string, first: string, rest: string): string {
  return value
    .split("\n")
    .map((line, index) => (index === 0 ? first : rest) + line)
    .join("\n");
}

/** The alignment set on a block, when it is one Markdown cannot carry. */
function alignOf(node: RichNode): string | null {
  const align = node.attrs?.textAlign;
  return typeof align === "string" && ["left", "center", "right", "justify"].includes(align)
    ? align
    : null;
}

function serializeTable(node: RichNode): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return "";
  const values = rows.map((row) =>
    (row.content ?? []).map((cell) =>
      // The cell's own blocks, not `serializeBlocks`: a cell paragraph carries
      // the column's alignment, and wrapping it in `<p align>` would restate in
      // every cell what the rule row below the header already says.
      (cell.content ?? [])
        .map((block) => inlineText(block.content))
        .join(" ")
        // A pipe inside a cell would end it, so it is escaped; a newline cannot
        // be represented in a GFM row at all and becomes a space.
        .replace(/\|/g, "\\|")
        .replace(/\n+/g, " ")
        .trim(),
    ),
  );
  const width = Math.max(...values.map((row) => row.length));
  const align = (rows[0]?.content ?? []).map((cell) =>
    alignOf(cell.content?.[0] ?? {}),
  );
  const rule = Array.from({ length: width }, (_, column) => {
    switch (align[column]) {
      case "center":
        return ":---:";
      case "right":
        return "---:";
      case "left":
        return ":---";
      default:
        return "---";
    }
  });
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, column) => row[column] ?? "").join(" | ")} |`;
  return [line(values[0]), `| ${rule.join(" | ")} |`, ...values.slice(1).map(line)].join(
    "\n",
  );
}

function serializeBlock(node: RichNode): string {
  switch (node.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const align = alignOf(node);
      const body = inlineText(node.content);
      return align
        ? `<h${level} align="${align}">${body}</h${level}>`
        : `${"#".repeat(level)} ${body}`;
    }
    case "table":
      return serializeTable(node);
    case "codeBlock": {
      const language = node.attrs?.language;
      return `\`\`\`${typeof language === "string" ? language : ""}\n${inlineText(node.content)}\n\`\`\``;
    }
    case "horizontalRule":
      return "---";
    case "blockquote":
      return prefixLines(serializeBlocks(node.content), "> ", "> ");
    case "bulletList":
      return (node.content ?? [])
        .map((item) => prefixLines(serializeBlocks(item.content), "- ", "  "))
        .join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, index) =>
          prefixLines(serializeBlocks(item.content), `${start + index}. `, "   "),
        )
        .join("\n");
    }
    case "paragraph": {
      const align = alignOf(node);
      const body = inlineText(node.content);
      return align && body !== "" ? `<p align="${align}">${body}</p>` : body;
    }
    default:
      return inlineText(node.content);
  }
}

function serializeBlocks(nodes: RichNode[] | undefined): string {
  return (nodes ?? []).map(serializeBlock).join("\n\n");
}

/** The editor's document as Markdown, ready to store. */
export function docToMarkdown(doc: RichNode | null | undefined): string {
  if (!doc?.content) return "";
  // A trailing empty paragraph is how the editor keeps a place to type after a
  // code block; it is not something the user wrote.
  return serializeBlocks(doc.content)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
