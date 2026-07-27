import { useEffect, useState } from "react";

interface Props {
  /** What the app is doing, shown under the title. */
  status?: string;
}

/**
 * Shown while the workspace database opens. It holds for a moment even when
 * loading is instant, so a fast start reads as deliberate rather than a flash
 * of unstyled content.
 */
export function SplashScreen({ status = "Opening your workspace…" }: Props) {
  const [dots, setDots] = useState("");

  useEffect(() => {
    const timer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : `${prev}.`));
    }, 400);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col items-center justify-center bg-canvas"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <span className="text-5xl leading-none text-brand">◆</span>
          <span className="absolute inset-0 animate-ping text-5xl leading-none text-brand opacity-20">
            ◆
          </span>
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            WebRequestKit
          </h1>
          <p className="mt-1 text-xs text-muted">
            API client, mock server and proxy in one place
          </p>
        </div>
        <p className="mt-2 font-mono text-[11px] text-muted">
          {status}
          <span className="inline-block w-3 text-left">{dots}</span>
        </p>
      </div>
    </div>
  );
}

/** Keeps `visible` true for at least `minimumMs`, to avoid a flicker. */
export function useMinimumDuration(active: boolean, minimumMs = 550): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), minimumMs);
    return () => clearTimeout(timer);
  }, [minimumMs]);

  return active || !elapsed;
}
