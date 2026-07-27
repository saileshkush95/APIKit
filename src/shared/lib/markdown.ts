// A small Markdown renderer for request docs and comments.
//
// Content can arrive from a peer over LAN sync, so this escapes HTML *first*
// and only then applies Markdown structure — raw HTML in the source is shown
// as text and can never execute in the webview. Link targets are restricted to
// http(s) for the same reason.

function escapeHtml(text: string): string {
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

/** Inline spans: code, bold, italic, links. Input must already be escaped. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="wrk-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
      const href = safeHref(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : match;
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

  for (const line of lines) {
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

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        out.push('<ul class="wrk-list">');
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
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
