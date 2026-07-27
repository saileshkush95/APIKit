// Application settings: appearance and request defaults.
//
// Settings are global (not per workspace) and are applied by writing CSS
// variables onto the document root, so every Tailwind token follows them.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setBackgroundMode, setSetting } from "../lib/api";
import { GLOBAL_SCOPE } from "../lib/storage";
import { defaultSettings, type AppSettings } from "../types";

interface SettingsValue {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

const STORAGE_KEY = "appSettings";

/** Darkens or lightens a hex colour for the accent's hover state. */
function shade(hex: string, amount: number): string {
  const parsed = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!parsed) return hex;
  const value = parseInt(parsed[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => Math.max(0, Math.min(255, Math.round(channel + amount))),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--color-brand", settings.accentColor);
  root.style.setProperty(
    "--color-brand-bright",
    shade(settings.accentColor, 22),
  );
  root.style.setProperty("--font-mono", settings.monoFont);
  document.body.style.fontFamily = settings.uiFont;
  document.body.style.fontSize = `${settings.fontSize}px`;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    // Mirrored in localStorage so the first paint already uses the user's
    // appearance, before the database is open.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw
        ? { ...defaultSettings(), ...(JSON.parse(raw) as Partial<AppSettings>) }
        : defaultSettings();
    } catch {
      return defaultSettings();
    }
  });

  useEffect(() => applySettings(settings), [settings]);

  // The window-close behaviour lives in Rust, so mirror the preference there.
  useEffect(() => {
    setBackgroundMode(settings.runInBackground).catch(() => {});
  }, [settings.runInBackground]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { enable, disable, isEnabled } = await import(
          "@tauri-apps/plugin-autostart"
        );
        const active = await isEnabled();
        if (cancelled || active === settings.startAtLogin) return;
        await (settings.startAtLogin ? enable() : disable());
      } catch {
        // Autostart is unavailable on some platforms; the toggle simply has no
        // effect there.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.startAtLogin]);

  const persist = useCallback((next: AppSettings) => {
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSetting(GLOBAL_SCOPE, STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const value = useMemo<SettingsValue>(
    () => ({
      settings,
      update: (patch) => persist({ ...settings, ...patch }),
      reset: () => persist(defaultSettings()),
    }),
    [settings, persist],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error("useSettings must be used inside <SettingsProvider>");
  }
  return value;
}
