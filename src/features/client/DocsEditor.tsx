import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor, type Range } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Image } from "@tiptap/extension-image";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";
import { Input } from "../../shared/components/Field";
import { Modal } from "../../shared/components/Modal";
import { useSlashMenu, type SlashItem } from "../../shared/components/SlashMenu";
import { docToMarkdown, markdownToDoc } from "../../shared/lib/richText";

interface Props {
  /** Markdown; the rich editor is a view onto it, not the storage format. */
  value: string;
  onChange: (docs: string) => void;
  /** Names the starting template offered while the docs are empty. */
  subject: string;
  /** Opens the print dialog, where the PDF is saved from. */
  onPrint?: () => void;
}

function template(name: string): string {
  return `# ${name}

What this covers.

## Parameters

- \`id\` — which record to fetch

## Response

\`\`\`json
{ "ok": true }
\`\`\`
`;
}

/** Replaces the `/query` that opened the menu, then runs the command. */
function at(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range);
}

const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Heading 1",
    hint: "#",
    keywords: ["title", "h1"],
    run: (editor, range) => at(editor, range).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    hint: "##",
    keywords: ["section", "h2"],
    run: (editor, range) => at(editor, range).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    hint: "###",
    keywords: ["h3"],
    run: (editor, range) => at(editor, range).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Bullet list",
    hint: "-",
    keywords: ["ul", "unordered", "point"],
    run: (editor, range) => at(editor, range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "1.",
    keywords: ["ol", "ordered", "steps"],
    run: (editor, range) => at(editor, range).toggleOrderedList().run(),
  },
  {
    title: "Quote",
    hint: ">",
    keywords: ["note", "callout"],
    run: (editor, range) => at(editor, range).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    hint: "```",
    keywords: ["pre", "snippet"],
    run: (editor, range) => at(editor, range).setCodeBlock().run(),
  },
  {
    title: "JSON example",
    hint: "```json",
    keywords: ["body", "payload", "response"],
    run: (editor, range) =>
      at(editor, range).setCodeBlock({ language: "json" }).insertContent('{\n  "ok": true\n}').run(),
  },
  {
    title: "Table",
    hint: "3 × 3",
    keywords: ["grid", "rows", "columns"],
    run: (editor, range) =>
      at(editor, range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: "Divider",
    hint: "---",
    keywords: ["rule", "hr", "separator"],
    run: (editor, range) => at(editor, range).setHorizontalRule().run(),
  },
  {
    title: "Parameters section",
    hint: "heading + list",
    keywords: ["params", "query", "arguments"],
    run: (editor, range) =>
      at(editor, range)
        .insertContent([
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Parameters" }] },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", marks: [{ type: "code" }], text: "id" },
                      { type: "text", text: " — what it selects" },
                    ],
                  },
                ],
              },
            ],
          },
        ])
        .run(),
  },
  {
    title: "Response section",
    hint: "heading + JSON",
    keywords: ["returns", "example"],
    run: (editor, range) =>
      at(editor, range)
        .insertContent([
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Response" }] },
          {
            type: "codeBlock",
            attrs: { language: "json" },
            content: [{ type: "text", text: '{\n  "ok": true\n}' }],
          },
        ])
        .run(),
  },
];

interface Tool {
  label: string;
  title: string;
  /** Highlighted while the caret sits inside this kind of content. */
  active?: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const TOOLS: Tool[] = [
  {
    label: "H",
    title: "Heading",
    active: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "B",
    title: "Bold",
    active: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    label: "I",
    title: "Italic",
    active: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: "</>",
    title: "Inline code",
    active: (editor) => editor.isActive("code"),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    label: "{ }",
    title: "Code block",
    active: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: "•",
    title: "Bullet list",
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: "1.",
    title: "Numbered list",
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "❝",
    title: "Quote",
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    label: "▤",
    title: "Table",
    active: (editor) => editor.isActive("table"),
    run: (editor) =>
      editor.isActive("table")
        ? editor.chain().focus().deleteTable().run()
        : editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run(),
  },
  {
    label: "▉",
    title: "Highlight",
    active: (editor) => editor.isActive("highlight"),
    run: (editor) => editor.chain().focus().toggleHighlight().run(),
  },
];

/** Alignment, which Markdown cannot express and this app stores as HTML. */
const ALIGNMENTS: { label: string; title: string; value: string }[] = [
  { label: "⇤", title: "Align left", value: "left" },
  { label: "↔", title: "Align centre", value: "center" },
  { label: "⇥", title: "Align right", value: "right" },
];

/** A small fixed palette: any hex round-trips, but a picker beats a colour wheel. */
const COLOURS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Red", value: "#e05252" },
  { label: "Orange", value: "#e08c3a" },
  { label: "Green", value: "#3aa76d" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Purple", value: "#8b5cf6" },
  { label: "Grey", value: "#8a8a8a" },
];

/** Rich-text documentation for a request, folder or collection, kept as Markdown. */
export function DocsEditor({ value, onChange, subject, onPrint }: Props) {
  const [linkTo, setLinkTo] = useState<string | null>(null);
  const [imageTo, setImageTo] = useState<string | null>(null);
  const [colourOpen, setColourOpen] = useState(false);
  const slash = useSlashMenu(SLASH_ITEMS);

  // What this editor last wrote out, so the sync below can tell an edit made
  // here from one that arrived from elsewhere — a template button, an import,
  // a peer — and only rebuild the document for the latter.
  const emitted = useRef(value);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // Markdown has no underline, so offering one would produce a mark
          // that silently disappears on save.
          underline: false,
          link: {
            openOnClick: false,
            autolink: true,
            protocols: ["http", "https"],
            HTMLAttributes: { rel: "noreferrer noopener", target: "_blank" },
          },
        }),
        // Alignment and colour have no Markdown syntax; `lib/richText` stores
        // them as the `<p align>` / `<span style="color">` that people already
        // write in Markdown files, and `lib/markdown` lets exactly those two
        // back through its escaping.
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        TextStyle,
        Color,
        Highlight,
        Image.configure({
          inline: true,
          // Only what `safeSrc` will store: http(s) and a pasted data: image.
          allowBase64: true,
          HTMLAttributes: { class: "wrk-doc-image" },
        }),
        TableKit.configure({ table: { resizable: false } }),
        Placeholder.configure({
          placeholder: "Describe what this request does — press / for blocks",
        }),
        slash.extension,
      ],
      content: markdownToDoc(value),
      editorProps: {
        attributes: { class: "wrk-doc wrk-markdown", spellcheck: "false" },
      },
      onUpdate: ({ editor }) => {
        const docs = docToMarkdown(editor.getJSON());
        emitted.current = docs;
        onChange(docs);
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(markdownToDoc(value), { emitUpdate: false });
  }, [value, editor]);

  // The toolbar's active states follow the caret, which moves without changing
  // the document, so a plain render is not enough to keep them honest.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const redraw = () => bump((n) => n + 1);
    editor.on("selectionUpdate", redraw);
    editor.on("transaction", redraw);
    return () => {
      editor.off("selectionUpdate", redraw);
      editor.off("transaction", redraw);
    };
  }, [editor]);

  const selectedText = useMemo(() => {
    if (!editor) return "";
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, " ");
  }, [editor, editor?.state.selection]);

  /** Only what `richText` will store: anything else would vanish on save. */
  function insertImage(src: string) {
    const url = src.trim();
    setImageTo(null);
    if (!editor || !/^(https?:\/\/|data:image\/[a-z+]+;base64,)/i.test(url)) return;
    editor.chain().focus().setImage({ src: url }).run();
  }

  function applyLink(href: string) {
    if (!editor) return;
    const url = href.trim();
    setLinkTo(null);
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty) {
      chain.insertContent({
        type: "text",
        text: url,
        marks: [{ type: "link", attrs: { href: url } }],
      });
    } else {
      chain.setLink({ href: url });
    }
    chain.run();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-none flex-wrap items-center gap-1">
        {editor &&
          TOOLS.map((tool) => (
            <button
              key={tool.title}
              onClick={() => tool.run(editor)}
              title={tool.title}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                tool.active?.(editor)
                  ? "border-brand text-ink"
                  : "border-edge text-muted hover:border-brand hover:text-ink"
              }`}
            >
              {tool.label}
            </button>
          ))}
        {editor &&
          ALIGNMENTS.map((item) => (
            <button
              key={item.value}
              onClick={() => editor.chain().focus().setTextAlign(item.value).run()}
              title={item.title}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                editor.isActive({ textAlign: item.value })
                  ? "border-brand text-ink"
                  : "border-edge text-muted hover:border-brand hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}

        {editor && (
          <div className="relative">
            <button
              onClick={() => setColourOpen((open) => !open)}
              title="Text colour"
              className="rounded border border-edge px-2 py-0.5 text-[11px] hover:border-brand"
              style={{ color: editor.getAttributes("textStyle").color ?? undefined }}
            >
              A
            </button>
            {colourOpen && (
              <div
                role="menu"
                className="absolute left-0 top-full z-50 mt-1 w-32 overflow-hidden rounded-md border border-edge bg-panel py-1 shadow-lg"
              >
                {COLOURS.map((colour) => (
                  <button
                    key={colour.label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setColourOpen(false);
                      const chain = editor.chain().focus();
                      if (colour.value) chain.setColor(colour.value).run();
                      else chain.unsetColor().run();
                    }}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-elevated"
                  >
                    <span
                      className="h-3 w-3 flex-none rounded-sm border border-edge"
                      style={{ background: colour.value ?? "transparent" }}
                    />
                    <span className="text-ink">{colour.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {editor && (
          <button
            onClick={() => setImageTo("")}
            title="Image"
            className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
          >
            🖼
          </button>
        )}

        {editor && (
          <button
            onClick={() => setLinkTo(editor.getAttributes("link").href ?? "")}
            title="Link"
            className={`rounded border px-2 py-0.5 text-[11px] ${
              editor.isActive("link")
                ? "border-brand text-ink"
                : "border-edge text-muted hover:border-brand hover:text-ink"
            }`}
          >
            🔗
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {onPrint && (
            <button
              onClick={onPrint}
              title="Print, or save as PDF"
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
            >
              PDF
            </button>
          )}
          {value.trim() === "" && (
            <button
              onClick={() => onChange(template(subject))}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
            >
              Template
            </button>
          )}
        </div>
      </div>

      <EditorContent
        editor={editor}
        className="wrk-doc-shell min-h-[10rem] flex-1 overflow-auto rounded-md border border-edge bg-panel"
      />

      {slash.popup}

      {imageTo !== null && (
        <Modal title="Image" onClose={() => setImageTo(null)} width="max-w-md">
          <div className="flex flex-col gap-2 p-4">
            <Input
              value={imageTo}
              onChange={(event) => setImageTo(event.target.value)}
              placeholder="https://…"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") insertImage(imageTo);
              }}
            />
            <p className="text-[11px] text-muted">
              An <span className="font-mono">https://</span> address, or a
              pasted <span className="font-mono">data:image</span> URI. A pasted
              image is stored inside the docs, so it travels with every export
              and sync — a link keeps the file where it is.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setImageTo(null)}
                className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => insertImage(imageTo)}
                className="rounded border border-brand px-2.5 py-1 text-xs text-ink"
              >
                Insert
              </button>
            </div>
          </div>
        </Modal>
      )}

      {linkTo !== null && (
        <Modal title="Link" onClose={() => setLinkTo(null)} width="max-w-md">
          <div className="flex flex-col gap-2 p-4">
            <Input
              value={linkTo}
              onChange={(event) => setLinkTo(event.target.value)}
              placeholder="https://"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") applyLink(linkTo);
              }}
            />
            <p className="text-[11px] text-muted">
              {selectedText === ""
                ? "The address is inserted as the link text."
                : `Links “${selectedText}”. Leave empty to remove the link.`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setLinkTo(null)}
                className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => applyLink(linkTo)}
                className="rounded border border-brand px-2.5 py-1 text-xs text-ink"
              >
                Apply
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
