// First-run experience: the splash, the welcome screen and the guided tour.
//
// The "seen" flag is global rather than per workspace — it is about the person,
// not their data — and is mirrored in localStorage so the welcome screen does
// not flash on every start while the database opens.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setSetting } from "../lib/api";
import { GLOBAL_SCOPE } from "../lib/storage";

const SEEN_KEY = "onboardingSeen";

interface OnboardingValue {
  /** True until the welcome screen has been dismissed once. */
  showWelcome: boolean;
  tourRunning: boolean;
  dismissWelcome: () => void;
  startTour: () => void;
  stopTour: () => void;
  /** Brings the welcome screen back, from Settings. */
  replay: () => void;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [showWelcome, setShowWelcome] = useState(() => !hasSeen());
  const [tourRunning, setTourRunning] = useState(false);

  const remember = useCallback((seen: boolean) => {
    try {
      localStorage.setItem(SEEN_KEY, String(seen));
    } catch {
      /* private mode; the welcome screen simply returns next start */
    }
    setSetting(GLOBAL_SCOPE, SEEN_KEY, String(seen)).catch(() => {});
  }, []);

  const value = useMemo<OnboardingValue>(
    () => ({
      showWelcome,
      tourRunning,
      dismissWelcome: () => {
        setShowWelcome(false);
        remember(true);
      },
      startTour: () => {
        // The tour points at the main window, so the welcome overlay closes
        // before it starts.
        setShowWelcome(false);
        remember(true);
        setTourRunning(true);
      },
      stopTour: () => setTourRunning(false),
      replay: () => setShowWelcome(true),
    }),
    [showWelcome, tourRunning, remember],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingValue {
  const value = useContext(OnboardingContext);
  if (!value) {
    throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  }
  return value;
}
