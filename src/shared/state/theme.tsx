// Theme mode (system / light / dark). The resolved theme is written to
// `data-theme` on <html>, which the token overrides in App.css key off.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setSetting } from "../lib/api";
import { GLOBAL_SCOPE, SETTINGS } from "../lib/storage";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function isMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // The theme is global, and needed before any workspace loads — so it is
  // mirrored in localStorage and written through to SQLite on change.
  useEffect(() => {
    const saved = localStorage.getItem(SETTINGS.theme);
    if (saved && isMode(saved)) setModeState(saved);
    setReady(true);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? system : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }, [resolved]);

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      resolved,
      setMode: (next) => {
        setModeState(next);
        localStorage.setItem(SETTINGS.theme, next);
        if (ready) {
          setSetting(GLOBAL_SCOPE, SETTINGS.theme, next).catch(() => {});
        }
      },
    }),
    [mode, resolved, ready],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
