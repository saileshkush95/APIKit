// The request currently open in the client, published so other views (load
// testing) can offer "use active request".

import { create } from "zustand";
import type { RequestDraft } from "../types";

export interface ActiveRequest extends RequestDraft {
  name: string;
}

interface ActiveRequestStore {
  active: ActiveRequest | null;
  setActive: (request: ActiveRequest | null) => void;
}

export const useActiveRequest = create<ActiveRequestStore>()((set) => ({
  active: null,
  setActive: (active) => set({ active }),
}));
