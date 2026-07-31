import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor, type Range } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";

/** One entry in the `/` menu. */
export interface SlashItem {
  title: string;
  /** What it inserts, shown to the right of the title. */
  hint: string;
  /** Extra words the query can match, for names that are not obvious. */
  keywords?: string[];
  /** The range covers `/` and whatever was typed after it — delete it first. */
  run: (editor: Editor, range: Range) => void;
}

const MAX_ITEMS = 9;

function matches(item: SlashItem, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return (
    item.title.toLowerCase().includes(needle) ||
    (item.keywords ?? []).some((word) => word.toLowerCase().includes(needle))
  );
}

interface MenuState {
  items: SlashItem[];
  rect: DOMRect | null;
}

/**
 * A `/` command menu for a Tiptap editor.
 *
 * Returns the extension to register and the popup to render. The extension is
 * built once: handing `useEditor` a new one on every render would tear the
 * editor down and rebuild it mid-keystroke.
 */
export function useSlashMenu(items: SlashItem[]) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  // Read inside the plugin's key handler, which closes over the first render.
  const source = useRef(items);
  source.current = items;
  const shown = useRef<SlashItem[]>([]);
  const index = useRef(0);
  const pick = useRef<((item: SlashItem) => void) | null>(null);
  // Escape hides the menu without ending the suggestion, so typing more of the
  // query must not bring it straight back.
  const dismissed = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);

  function select(next: number) {
    index.current = next;
    setHighlighted(next);
    listRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function show(props: { items: SlashItem[]; clientRect?: (() => DOMRect | null) | null }) {
    shown.current = props.items;
    setMenu({ items: props.items, rect: props.clientRect?.() ?? null });
  }

  const extension = useMemo(
    () =>
      Extension.create({
        name: "slashMenu",
        addProseMirrorPlugins() {
          return [
            Suggestion<SlashItem, SlashItem>({
              editor: this.editor,
              char: "/",
              // Otherwise a URL's `/` inside a paragraph opens the menu.
              allowedPrefixes: [" "],
              startOfLine: false,
              items: ({ query }) =>
                source.current.filter((item) => matches(item, query)).slice(0, MAX_ITEMS),
              command: ({ editor, range, props }) => props.run(editor, range),
              render: () => ({
                onStart: (props) => {
                  dismissed.current = false;
                  pick.current = props.command;
                  select(0);
                  show(props);
                },
                onUpdate: (props) => {
                  pick.current = props.command;
                  if (dismissed.current) return;
                  if (index.current >= props.items.length) select(0);
                  show(props);
                },
                onKeyDown: ({ event }) => {
                  if (dismissed.current || shown.current.length === 0) return false;
                  if (event.key === "Escape") {
                    dismissed.current = true;
                    setMenu(null);
                    return true;
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    const count = shown.current.length;
                    select((index.current + step + count) % count);
                    return true;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    const item = shown.current[index.current];
                    if (item) pick.current?.(item);
                    return true;
                  }
                  return false;
                },
                onExit: () => {
                  dismissed.current = false;
                  shown.current = [];
                  setMenu(null);
                },
              }),
            }),
          ];
        },
      }),
    [],
  );

  const rect = menu?.rect ?? null;
  const popup =
    menu && rect && menu.items.length > 0
      ? createPortal(
          <ul
            ref={listRef}
            role="listbox"
            className="wrk-select-list w-72"
            style={{
              left: Math.min(rect.left, window.innerWidth - 300),
              ...(window.innerHeight - rect.bottom < 240 && rect.top > 240
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }}
          >
            {menu.items.map((item, at) => (
              <li key={item.title} data-index={at}>
                <button
                  type="button"
                  role="option"
                  aria-selected={at === highlighted}
                  onMouseEnter={() => select(at)}
                  // Keeps the caret in the editor, so the insert lands where it should.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick.current?.(item)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                    at === highlighted ? "wrk-option-active" : ""
                  }`}
                >
                  <span className="text-ink">{item.title}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">
                    {item.hint}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )
      : null;

  return { extension, popup };
}
