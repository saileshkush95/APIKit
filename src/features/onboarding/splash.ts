// Handing over from the splash window to the main one.
//
// The splash is declared in `tauri.conf.json`, so it is on screen before any
// JavaScript of ours runs — which is what makes it a real application splash
// rather than a first render. The main window starts hidden and reveals itself
// here, once the workspace database is actually open.

import { useEffect, useState } from "react";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";

let revealed = false;

export async function revealMainWindow(): Promise<void> {
  // A React effect can run twice under StrictMode, and the user may reload the
  // webview; neither should re-show a window that is already up.
  if (revealed) return;
  revealed = true;

  try {
    const current = getCurrentWindow();
    await current.show();
    await current.setFocus();

    // Closed rather than hidden: nothing reopens it, and a lingering
    // always-on-top window would sit over the app forever.
    const splash = (await getAllWindows()).find((w) => w.label === "splash");
    await splash?.destroy();
  } catch {
    // In a browser (`bun run dev` without Tauri) there is no window to show.
  }
}

/** Keeps `active` true for at least `minimumMs`, to avoid a flicker. */
export function useMinimumDuration(active: boolean, minimumMs = 550): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), minimumMs);
    return () => clearTimeout(timer);
  }, [minimumMs]);

  return active || !elapsed;
}
