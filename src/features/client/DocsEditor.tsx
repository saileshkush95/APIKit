import { useRef, useState } from "react";
import { CodeEditor } from "../../shared/components/CodeEditor";
import { typeInto } from "../../shared/lib/textEdit";
import { renderMarkdown } from "../../shared/lib/markdown";
import type { RequestConfig } from "../../shared/types";

interface Props {
  config: RequestConfig;
  onChange: (patch: Partial<RequestConfig>) => void;
  /** Shown as a starting point when the request has no docs yet. */
  requestName: string;
}

type Mode = "write" | "split" | "preview";

interface Tool {
  label: string;
  title: string;
  /** Wraps the selection, or inserts at the caret when nothing is selected. */
  before: string;
  after?: string;
  /** Prefixes each selected line instead of wrapping. */
  linePrefix?: string;
  placeholder?: string;
}

const TOOLS: Tool[] = [
  { label: "H", title: "Heading", before: "", linePrefix: "## ", placeholder: "Heading" },
  { label: "B", title: "Bold", before: "**", after: "**", placeholder: "bold" },
  { label: "I", title: "Italic", before: "*", after: "*", placeholder: "italic" },
  { label: "</>", title: "Inline code", before: "`", after: "`", placeholder: "code" },
  {
    label: "{ }",
    title: "Code block",
    before: "```json\n",
    after: "\n```",
    placeholder: "{ }",
  },
  { label: "•", title: "Bullet list", before: "", linePrefix: "- ", placeholder: "item" },
  { label: "❝", title: "Quote", before: "", linePrefix: "> ", placeholder: "note" },
  {
    label: "🔗",
    title: "Link",
    before: "[",
    after: "](https://)",
    placeholder: "label",
  },
];

function template(name: string): string {
  return `# ${name}

What this endpoint does.

## Parameters

- \`id\` — which record to fetch

## Response

\`\`\`json
{ "ok": true }
\`\`\`
`;
}

/** Markdown documentation for a request: toolbar, editor and live preview. */
export function DocsEditor({ config, onChange, requestName }: Props) {
  const [mode, setMode] = useState<Mode>(
    config.docs.trim() === "" ? "write" : "split",
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function applyTool(tool: Tool) {
    const textarea = inputRef.current;
    const source = config.docs;
    // Without focus there is no selection to work with, so append instead.
    const start = textarea?.selectionStart ?? source.length;
    const end = textarea?.selectionEnd ?? source.length;
    const selected = source.slice(start, end);

    let inserted: string;
    if (tool.linePrefix) {
      const target = selected || tool.placeholder || "";
      inserted = target
        .split("\n")
        .map((line) => `${tool.linePrefix}${line}`)
        .join("\n");
    } else {
      const target = selected || tool.placeholder || "";
      inserted = `${tool.before}${target}${tool.after ?? ""}`;
    }

    // Through the field, so a toolbar insert is one Cmd+Z like a typed one.
    if (!typeInto(textarea, inserted, start, end)) {
      onChange({ docs: source.slice(0, start) + inserted + source.slice(end) });
    }

    // Put the caret after what was inserted so typing continues naturally.
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      const caret = start + inserted.length;
      textarea.setSelectionRange(caret, caret);
    });
  }

  const editor = (
    <CodeEditor
      value={config.docs}
      onChange={(docs) => onChange({ docs })}
      placeholder={"# Endpoint\n\nDescribe what this request does…"}
      className="min-h-[10rem] flex-1"
      inputRef={inputRef}
      historyKey="docs"
      completeVariables={false}
    />
  );

  const preview =
    config.docs.trim() === "" ? (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-edge bg-panel p-3 text-xs text-muted">
        Nothing to preview yet.
      </div>
    ) : (
      <div
        className="wrk-markdown min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-panel p-3 text-xs leading-relaxed"
        // `renderMarkdown` escapes the source before formatting, so docs that
        // arrived from a peer cannot inject markup.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(config.docs) }}
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-none flex-wrap items-center gap-1">
        {mode !== "preview" &&
          TOOLS.map((tool) => (
            <button
              key={tool.title}
              onClick={() => applyTool(tool)}
              title={tool.title}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
            >
              {tool.label}
            </button>
          ))}

        <div className="ml-auto flex items-center gap-1">
          {config.docs.trim() === "" && (
            <button
              onClick={() => onChange({ docs: template(requestName) })}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
            >
              Template
            </button>
          )}
          {(
            [
              ["write", "Write"],
              ["split", "Split"],
              ["preview", "Preview"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`rounded-md px-2.5 py-0.5 text-[11px] ${
                mode === key
                  ? "bg-elevated font-medium text-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "write" && editor}
      {mode === "preview" && preview}
      {mode === "split" && (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{editor}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
        </div>
      )}
    </div>
  );
}
