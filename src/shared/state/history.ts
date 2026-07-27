// What you have sent, most recent first.
//
// History records what *you* did on *this* machine, so it is deliberately
// outside sync, and capped in the database rather than growing without end.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
  recordHistory,
} from "../lib/api";
import { notifyError } from "../lib/notify";
import { newId } from "../lib/storage";
import type { HistoryEntry, HttpResponseData, RequestDraft } from "../types";

interface HistoryStore {
  workspaceId: string;
  entries: HistoryEntry[];
  load: (workspaceId: string) => Promise<void>;
  /** Called after every send, with the response or the failure. */
  record: (
    name: string,
    request: RequestDraft,
    outcome: { response?: HttpResponseData; error?: string },
  ) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryStore>()((set, get) => ({
  workspaceId: "",
  entries: [],

  load: async (workspaceId) => {
    set({ workspaceId });
    try {
      set({ entries: await loadHistory(workspaceId) });
    } catch (e) {
      notifyError("Could not load history", e);
    }
  },

  record: (name, request, { response, error }) => {
    const entry: HistoryEntry = {
      id: newId(),
      atMs: Date.now(),
      name,
      method: request.method,
      url: request.url,
      status: response?.status ?? null,
      statusText: response?.statusText ?? "",
      timeMs: response?.timeMs ?? 0,
      sizeBytes: response?.sizeBytes ?? 0,
      request,
      error: error ?? null,
    };
    set({ entries: [entry, ...get().entries].slice(0, 300) });
    // A lost history row is not worth interrupting the user over; the request
    // itself already succeeded or failed on its own terms.
    recordHistory(get().workspaceId, entry).catch(() => {});
  },

  remove: (id) => {
    set({ entries: get().entries.filter((entry) => entry.id !== id) });
    deleteHistoryEntry(id).catch(() => {});
  },

  clear: () => {
    set({ entries: [] });
    clearHistory(get().workspaceId).catch((e) =>
      notifyError("Could not clear history", e),
    );
  },
}));

export function useHistory() {
  return useHistoryStore(
    useShallow((s) => ({
      entries: s.entries,
      record: s.record,
      remove: s.remove,
      clear: s.clear,
    })),
  );
}
