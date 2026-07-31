// A small Markdown renderer for request docs and comments.
//
// Content can arrive from a peer over LAN sync, so this escapes HTML *first*
// and only then applies Markdown structure — raw HTML in the source is shown
// as text and can never execute in the webview. Link targets are restricted to
// http(s) for the same reason.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function safeSrc(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|data:image\/[a-z+]+;base64,)/i.test(trimmed) ? trimmed : null;
}

/**
 * The two things Markdown cannot express, let back through the escaping.
 *
 * Everything else stays escaped. These patterns are matched against the
 * *already-escaped* text and rewritten into a fixed shape with a validated
 * value, so nothing an author writes decides the markup — a colour is a hex
 * literal and an alignment is one of four words, or neither is honoured.
 */
function allowStyling(text: string): string {
  return text
    .replace(
      /&lt;span style=&quot;color:\s*(#[0-9a-fA-F]{3,8})&quot;&gt;/g,
      (_match, color: string) => `<span style="color:${color}">`,
    )
    .replace(/&lt;\/span&gt;/g, "</span>");
}

/** Inline spans: code, bold, italic, highlight, images, links. Input must already be escaped. */
function inline(text: string): string {
  return allowStyling(text)
    .replace(/`([^`]+)`/g, '<code class="wrk-code">$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) => {
      const src = safeSrc(url);
      return src ? `<img src="${src}" alt="${alt}" class="wrk-image">` : match;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/==([^=]+)==/g, '<mark class="wrk-mark">$1</mark>')
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
      const href = safeHref(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : match;
    });
}

/** `|:--|--:|` — the row that makes the one above it a table header. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function columnAlign(rule: string): (string | null)[] {
  return tableCells(rule).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split("\n");
  const out: string[] = [];
  let listOpen = false;
  let inFence = false;
  let fence: string[] = [];

  function closeList() {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  }

  let skipTo = -1;
  for (let index = 0; index < lines.length; index++) {
    if (index < skipTo) continue;
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (inFence) {
        out.push(`<pre class="wrk-pre"><code>${fence.join("\n")}</code></pre>`);
        fence = [];
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // The alignment wrappers the rich editor writes, matched after escaping.
    const alignedHeading =
      /^&lt;h([1-6]) align=&quot;(left|center|right|justify)&quot;&gt;([\s\S]*)&lt;\/h\1&gt;$/.exec(
        line.trim(),
      );
    if (alignedHeading) {
      closeList();
      const level = Math.min(6, Number(alignedHeading[1]) + 1);
      out.push(
        `<h${level} style="text-align:${alignedHeading[2]}">${inline(alignedHeading[3])}</h${level}>`,
      );
      continue;
    }

    const alignedParagraph =
      /^&lt;p align=&quot;(left|center|right|justify)&quot;&gt;([\s\S]*)&lt;\/p&gt;$/.exec(
        line.trim(),
      );
    if (alignedParagraph) {
      closeList();
      out.push(
        `<p style="text-align:${alignedParagraph[1]}">${inline(alignedParagraph[2])}</p>`,
      );
      continue;
    }

    if (line.trimStart().startsWith("|") && TABLE_RULE.test(lines[index + 1] ?? "")) {
      closeList();
      const align = columnAlign(lines[index + 1]);
      const cell = (value: string, tag: "th" | "td", column: number) =>
        `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ""}>${inline(value)}</${tag}>`;
      const rows = [
        `<tr>${tableCells(line)
          .map((value, column) => cell(value, "th", column))
          .join("")}</tr>`,
      ];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trimStart().startsWith("|")) {
        rows.push(
          `<tr>${tableCells(lines[cursor])
            .map((value, column) => cell(value, "td", column))
            .join("")}</tr>`,
        );
        cursor += 1;
      }
      // The rows below have been consumed; skipping them is what `skipTo` does.
      skipTo = cursor;
      out.push(`<table class="wrk-table">${rows.join("")}</table>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        out.push('<ul class="wrk-list">');
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    // `&gt;`, not `>`: the source is escaped before it is parsed, so matching a
    // literal `>` here never fired and a quote came out as ordinary text.
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote class="wrk-quote">${inline(quote[1])}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  if (inFence && fence.length) {
    out.push(`<pre class="wrk-pre"><code>${fence.join("\n")}</code></pre>`);
  }
  closeList();
  return out.join("\n");
}
