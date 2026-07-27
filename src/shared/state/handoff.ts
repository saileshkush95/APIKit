// A request handed to the client from somewhere else in the app.
//
// The proxy captures traffic in its own route, and the command palette can be
// opened from any route — in both cases the useful next step is "now open that
// in the client". A search param cannot carry a whole draft, so the request is
// parked here: the sender fills it and navigates, the client takes it exactly
// once and opens it.

import { create } from "zustand";
import type { RequestDraft } from "../types";

export type Handoff =
  /** An ad-hoc request: opened as a scratch tab, or written to the collection. */
  | { kind: "draft"; name: string; draft: RequestDraft; save: boolean }
  /** A request already in the collection, so the tab stays bound to it. */
  | { kind: "saved"; requestId: string };

interface HandoffStore {
  pending: Handoff | null;
  hand: (handoff: Handoff) => void;
  /** Returns the pending handoff and clears it, so it is never applied twice. */
  take: () => Handoff | null;
}

export const useHandoff = create<HandoffStore>()((set, get) => ({
  pending: null,
  hand: (pending) => set({ pending }),
  take: () => {
    const { pending } = get();
    if (pending) set({ pending: null });
    return pending;
  },
}));
