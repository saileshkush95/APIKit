// Debounced write-through for stores.
//
// Replaces the `usePersist` hook now that state lives outside React: the same
// contract — coalesce rapid edits, and never fail silently, because a failed
// write means the user's work is not on disk.

import { notifyError } from "./notify";

export function createSaver<T>(
  persist: (value: T) => Promise<unknown>,
  delay = 300,
): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T;

  return (value: T) => {
    latest = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist(latest).catch((e) =>
        notifyError("Could not save your changes", e),
      );
    }, delay);
  };
}
