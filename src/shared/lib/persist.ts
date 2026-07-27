import { useEffect, useRef } from "react";
import { notifyError } from "./notify";

/**
 * Writes `value` through `persist` after edits settle. Nothing is written until
 * `ready` flips true, so the initial load can never be overwritten by the empty
 * state React renders first.
 */
export function usePersist<T>(
  value: T,
  ready: boolean,
  persist: (value: T) => Promise<unknown>,
  delay = 300,
): void {
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      persistRef.current(value).catch((e) => {
        // A failed write means the user's work is not on disk — never silent.
        notifyError("Could not save your changes", e);
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [value, ready, delay]);
}
