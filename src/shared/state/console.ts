// The console: one running log of everything the app sent and every line a
// script printed.
//
// Tabs already carry their own script log, but that only answers "what happened
// in this tab, this time". A chained run, a monitor firing, a script that set a
// variable three requests ago — those need a place where the whole session is
// visible in order.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type ConsoleLevel = "request" | "response" | "log" | "error";

export interface ConsoleEntry {
  id: string;
  atMs: number;
  level: ConsoleLevel;
  /** Where it came from: "Client", "Runner", "Monitor · Health". */
  source: string;
  message: string;
  /** Request/response particulars, shown when the row is expanded. */
  detail?: {
    method?: string;
    url?: string;
    status?: number | null;
    timeMs?: number;
    sizeBytes?: number;
    headers?: { name: string; value: string }[];
    body?: string;
  };
}

/** Bounded: a soak test would otherwise fill memory with its own log. */
const MAX_ENTRIES = 1000;

interface ConsoleStore {
  entries: ConsoleEntry[];
  open: boolean;
  push: (entry: Omit<ConsoleEntry, "id" | "atMs">) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

let counter = 0;

export const useConsoleStore = create<ConsoleStore>()((set) => ({
  entries: [],
  open: false,
  push: (entry) =>
    set((state) => ({
      entries: [
        ...state.entries.slice(-(MAX_ENTRIES - 1)),
        { ...entry, id: `c${(counter += 1)}`, atMs: Date.now() },
      ],
    })),
  clear: () => set({ entries: [] }),
  setOpen: (open) => set({ open }),
}));

/** Logging from outside React — the send path, monitors, the runner. */
export const logConsole = (entry: Omit<ConsoleEntry, "id" | "atMs">) =>
  useConsoleStore.getState().push(entry);

export function useConsole() {
  return useConsoleStore(
    useShallow((s) => ({
      entries: s.entries,
      open: s.open,
      clear: s.clear,
      setOpen: s.setOpen,
    })),
  );
}
