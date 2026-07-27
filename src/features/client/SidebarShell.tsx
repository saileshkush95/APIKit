import { useEffect, useRef, useState } from "react";

interface Props {
  width: number;
  onWidthChange: (width: number) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Tab header shown above the panel; hidden while collapsed. */
  header: React.ReactNode;
  children: React.ReactNode;
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 240;

/**
 * The collection/history sidebar: collapsible, and resizable by its edge.
 *
 * Collapsing keeps a narrow rail rather than removing the sidebar outright, so
 * there is always something to click to get it back — a sidebar that vanishes
 * completely is one people cannot find again.
 */
export function SidebarShell({
  width,
  onWidthChange,
  collapsed,
  onCollapsedChange,
  header,
  children,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;

    // A drag is a pointer gesture, not a text gesture: without this the
    // mousemove selects every row it sweeps over.
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    function onMove(e: MouseEvent) {
      const box = asideRef.current?.getBoundingClientRect();
      if (!box) return;
      const next = e.clientX - box.left;
      // Dragging well past the minimum collapses, the way an editor does.
      if (next < SIDEBAR_MIN - 50) {
        onCollapsedChange(true);
        setDragging(false);
        return;
      }
      onWidthChange(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
    }
    function onUp() {
      setDragging(false);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
    };
  }, [dragging, onWidthChange, onCollapsedChange]);

  if (collapsed) {
    return (
      <div className="flex w-8 flex-none flex-col items-center border-r border-edge bg-panel py-2">
        <button
          onClick={() => onCollapsedChange(false)}
          className="rounded px-1.5 py-1 text-muted hover:bg-elevated hover:text-ink"
          title="Show the sidebar (⌘B)"
        >
          »
        </button>
        <span
          className="mt-3 text-[10px] tracking-wide text-muted uppercase"
          style={{ writingMode: "vertical-rl" }}
        >
          Collection
        </span>
      </div>
    );
  }

  return (
    <div
      ref={asideRef}
      className="relative flex min-h-0 flex-none flex-col"
      style={{ width }}
    >
      <div className="flex flex-none items-stretch border-r border-b border-edge bg-panel">
        {header}
        <button
          onClick={() => onCollapsedChange(true)}
          className="flex-none px-2 text-muted hover:bg-elevated hover:text-ink"
          title="Hide the sidebar (⌘B)"
        >
          «
        </button>
      </div>

      {children}

      {/* Sits over the border so the whole 6px is grabbable, but only a 1px
          line is ever drawn — see the request/response splitter. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT)}
        className="group absolute top-0 -right-[3px] bottom-0 z-10 w-1.5 cursor-col-resize select-none"
        title="Drag to resize, double-click to reset"
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
            dragging ? "bg-brand" : "bg-transparent group-hover:bg-brand"
          }`}
        />
      </div>
    </div>
  );
}
