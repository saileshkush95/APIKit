// Theme mode (system / light / dark). The resolved theme is written to
// `data-theme` on <html>, which the token overrides in App.css key off.

import { create } from "zustand";
import { setSetting } from "../lib/api";
import { GLOBAL_SCOPE, SETTINGS } from "../lib/storage";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function isMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function stored(): ThemeMode {
  // The theme is global and needed before any workspace loads, so it is
  // mirrored in localStorage and written through to SQLite on change.
  try {
    const value = localStorage.getItem(SETTINGS.theme);
    return value && isMode(value) ? value : "system";
  } catch {
    return "system";
  }
}

function apply(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

interface ThemeStore {
  mode: ThemeMode;
  system: ResolvedTheme;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Applies the stored theme and follows the OS. Called once. */
  init: () => () => void;
}

function resolve(mode: ThemeMode, system: ResolvedTheme): ResolvedTheme {
  return mode === "system" ? system : mode;
}

export const useTheme = create<ThemeStore>()((set, get) => ({
  mode: stored(),
  system: systemTheme(),
  resolved: resolve(stored(), systemTheme()),

  setMode: (mode) => {
    const resolved = resolve(mode, get().system);
    set({ mode, resolved });
    apply(resolved);
    localStorage.setItem(SETTINGS.theme, mode);
    setSetting(GLOBAL_SCOPE, SETTINGS.theme, mode).catch(() => {});
  },

  init: () => {
    apply(get().resolved);
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const system: ResolvedTheme = media.matches ? "dark" : "light";
      const resolved = resolve(get().mode, system);
      set({ system, resolved });
      apply(resolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  },
}));
