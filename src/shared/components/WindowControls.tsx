import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop, drawsWindowControls } from "../lib/platform";

/**
 * Minimise / maximise / close, drawn only where the window is undecorated.
 * macOS keeps its native traffic lights over the overlay title bar, so this
 * renders nothing there.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!drawsWindowControls) return;
    const window = getCurrentWindow();
    window.isMaximized().then(setMaximized).catch(() => {});
    // Dragging a window between monitors or snapping it changes the state
    // without going through our buttons.
    const unlisten = window.onResized(() => {
      window.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  if (!drawsWindowControls) return null;

  const window = getCurrentWindow();
  // Windows puts a red close button last; the same order reads fine on Linux.
  const buttons = [
    {
      label: "Minimise",
      run: () => window.minimize(),
      icon: <rect x="3" y="7.5" width="10" height="1.2" rx="0.6" />,
      danger: false,
    },
    {
      label: maximized ? "Restore" : "Maximise",
      run: () => window.toggleMaximize(),
      icon: maximized ? (
        <>
          <rect x="3" y="5.5" width="7" height="7" rx="1" fill="none" strokeWidth="1.2" stroke="currentColor" />
          <path d="M5.6 5.4V4.4a1 1 0 0 1 1-1h5.2a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-1" fill="none" strokeWidth="1.2" stroke="currentColor" />
        </>
      ) : (
        <rect x="3.5" y="4" width="9" height="8" rx="1" fill="none" strokeWidth="1.2" stroke="currentColor" />
      ),
      danger: false,
    },
    {
      label: "Close",
      run: () => window.close(),
      icon: (
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
        />
      ),
      danger: true,
    },
  ];

  return (
    <div
      className="flex h-full items-stretch"
      // Buttons must not drag the window out from under the pointer.
      data-tauri-drag-region={false}
      style={{ marginRight: desktop === "windows" ? -16 : 0 }}
    >
      {buttons.map((button) => (
        <button
          key={button.label}
          onClick={button.run}
          title={button.label}
          className={`flex w-11 items-center justify-center text-muted transition-colors hover:text-ink ${
            button.danger ? "hover:bg-err hover:text-white" : "hover:bg-elevated"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            {button.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
