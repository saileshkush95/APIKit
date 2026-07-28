import { useEffect, useState } from "react";
import { subscribe, type Notice } from "../lib/notify";

const TONE: Record<Notice["level"], string> = {
  info: "border-edge",
  success: "border-ok/50",
  error: "border-err/60",
};

const ICON: Record<Notice["level"], string> = {
  info: "•",
  success: "✓",
  error: "!",
};

const ICON_TONE: Record<Notice["level"], string> = {
  info: "text-muted",
  success: "text-ok",
  error: "text-err",
};

/** Bottom-right stack of notices. Mounted once, at the app root. */
export function Toaster() {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    return subscribe((notice) => {
      // Newest first, and bounded so a storm of failures cannot fill the screen.
      setNotices((prev) => [notice, ...prev].slice(0, 4));
      if (notice.timeoutMs > 0) {
        setTimeout(() => {
          setNotices((prev) => prev.filter((item) => item.id !== notice.id));
        }, notice.timeoutMs);
      }
    });
  }, []);

  function dismiss(id: string) {
    setNotices((prev) => prev.filter((notice) => notice.id !== id));
  }

  if (notices.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-elevated px-3 py-2 shadow-xl ${
            TONE[notice.level]
          }`}
        >
          <span
            className={`mt-0.5 font-mono text-xs font-bold ${ICON_TONE[notice.level]}`}
          >
            {ICON[notice.level]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink">{notice.message}</div>
            {notice.detail && (
              <div className="mt-0.5 line-clamp-3 font-mono text-[11px] break-words text-muted">
                {notice.detail}
              </div>
            )}
            {[...(notice.action ? [notice.action] : []), ...(notice.actions ?? [])]
              .length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {[
                  ...(notice.action ? [notice.action] : []),
                  ...(notice.actions ?? []),
                ].map((action) => (
                  <button
                    key={action.label}
                    onClick={() => {
                      action.run();
                      dismiss(notice.id);
                    }}
                    className="rounded border border-edge px-2 py-0.5 text-[11px] text-brand hover:border-brand"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => dismiss(notice.id)}
            className="flex-none text-sm leading-none text-muted hover:text-ink"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
