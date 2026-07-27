// Application settings: appearance and request defaults.
//
// Settings are global (not per workspace) and are applied by writing CSS
// variables onto the document root, so every Tailwind token follows them.

import { create } from "zustand";
import { setBackgroundMode, setSetting } from "../lib/api";
import { GLOBAL_SCOPE } from "../lib/storage";
import { defaultSettings, type AppSettings } from "../types";

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

function applyAppearance(settings: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--color-brand", settings.accentColor);
  root.style.setProperty("--color-brand-bright", shade(settings.accentColor, 22));
  root.style.setProperty("--font-mono", settings.monoFont);
  document.body.style.fontFamily = settings.uiFont;
  document.body.style.fontSize = `${settings.fontSize}px`;
}

/** Autostart lives in the OS, so it is only touched when the flag changes. */
async function applyAutostart(enabled: boolean): Promise<void> {
  try {
    const { enable, disable, isEnabled } = await import(
      "@tauri-apps/plugin-autostart"
    );
    if ((await isEnabled()) === enabled) return;
    await (enabled ? enable() : disable());
  } catch {
    // Unavailable on some platforms; the toggle simply has no effect there.
  }
}

function load(): AppSettings {
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
}

interface SettingsStore {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
  /** Applies the stored settings to the document and the OS. Called once. */
  init: () => void;
}

export const useSettings = create<SettingsStore>()((set, get) => {
  function persist(next: AppSettings, previous: AppSettings) {
    set({ settings: next });
    applyAppearance(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSetting(GLOBAL_SCOPE, STORAGE_KEY, JSON.stringify(next)).catch(() => {});

    if (next.runInBackground !== previous.runInBackground) {
      setBackgroundMode(next.runInBackground).catch(() => {});
    }
    if (next.startAtLogin !== previous.startAtLogin) {
      applyAutostart(next.startAtLogin);
    }
  }

  return {
    settings: load(),
    update: (patch) => persist({ ...get().settings, ...patch }, get().settings),
    reset: () => persist(defaultSettings(), get().settings),
    init: () => {
      const { settings } = get();
      applyAppearance(settings);
      setBackgroundMode(settings.runInBackground).catch(() => {});
      applyAutostart(settings.startAtLogin);
    },
  };
});
