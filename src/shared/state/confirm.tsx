// Promise-based confirmation for destructive actions.
//
// Deletes now propagate: removing a folder tombstones everything inside it and
// the deletion reaches every peer on the next sync. Anything that cannot be
// walked back with a click asks first.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ConfirmRequest {
  title: string;
  /** What exactly is about to happen, in the user's terms. */
  body: string;
  confirmLabel?: string;
  /** Extra line for consequences that are easy to miss, e.g. sync. */
  warning?: string;
  danger?: boolean;
}

type Resolver = (confirmed: boolean) => void;

const ConfirmContext = createContext<
  ((request: ConfirmRequest) => Promise<boolean>) | null
>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<
    (ConfirmRequest & { resolve: Resolver }) | null
  >(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...request, resolve });
      }),
    [],
  );

  function settle(confirmed: boolean) {
    pending?.resolve(confirmed);
    setPending(null);
  }

  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") settle(false);
      if (e.key === "Enter") settle(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8"
          onClick={() => settle(false)}
        >
          <div
            className="w-[26rem] overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4">
              <h2 className="text-sm font-semibold text-ink">
                {pending.title}
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                {pending.body}
              </p>
              {pending.warning && (
                <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
                  {pending.warning}
                </p>
              )}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
              <button
                onClick={() => settle(false)}
                className="rounded px-3 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                autoFocus
                onClick={() => settle(true)}
                className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white ${
                  pending.danger
                    ? "bg-err hover:opacity-90"
                    : "bg-brand hover:bg-brand-bright"
                }`}
              >
                {pending.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return confirm;
}
