// First-run experience: the welcome screen and the guided tour.
//
// The "seen" flag is global rather than per workspace — it is about the person,
// not their data — and is mirrored in localStorage so the welcome screen does
// not flash on every start while the database opens.

import { create } from "zustand";
import { setSetting } from "../lib/api";
import { GLOBAL_SCOPE } from "../lib/storage";

const SEEN_KEY = "onboardingSeen";

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

function remember(seen: boolean): void {
  try {
    localStorage.setItem(SEEN_KEY, String(seen));
  } catch {
    /* private mode; the welcome screen simply returns next start */
  }
  setSetting(GLOBAL_SCOPE, SEEN_KEY, String(seen)).catch(() => {});
}

interface OnboardingStore {
  /** True until the welcome screen has been dismissed once. */
  showWelcome: boolean;
  tourRunning: boolean;
  dismissWelcome: () => void;
  startTour: () => void;
  stopTour: () => void;
  /** Brings the welcome screen back, from Settings. */
  replay: () => void;
}

export const useOnboarding = create<OnboardingStore>()((set) => ({
  showWelcome: !hasSeen(),
  tourRunning: false,

  dismissWelcome: () => {
    set({ showWelcome: false });
    remember(true);
  },

  startTour: () => {
    // The tour points at the main window, so the welcome overlay closes first.
    set({ showWelcome: false, tourRunning: true });
    remember(true);
  },

  stopTour: () => set({ tourRunning: false }),
  replay: () => set({ showWelcome: true }),
}));
