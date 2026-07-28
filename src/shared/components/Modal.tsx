import { useEffect } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Tailwind width class; the default suits a reading-width panel. */
  width?: string;
}

/** Centred dialog over a dimmed backdrop. Escape and a backdrop click close it. */
export function Modal({ title, onClose, children, width = "max-w-3xl" }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-8"
    >
      <div
        // The backdrop closes on click; the panel must not pass that through.
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-full w-full ${width} flex-col overflow-hidden rounded-lg border border-edge bg-canvas shadow-2xl`}
      >
        <div className="flex flex-none items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="rounded px-1.5 text-lg leading-none text-muted hover:text-err"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
