// Which desktop we are drawing for.
//
// The title bar differs by platform: macOS keeps its native traffic lights over
// an overlay title bar, while Windows and Linux run undecorated and we draw the
// window controls ourselves.

export type Desktop = "macos" | "windows" | "linux";

function detect(): Desktop {
  if (typeof navigator === "undefined") return "linux";
  const agent = navigator.userAgent;
  if (agent.includes("Mac")) return "macos";
  if (agent.includes("Win")) return "windows";
  return "linux";
}

export const desktop: Desktop = detect();
export const isMac = desktop === "macos";

/** True where the app draws its own minimise / maximise / close buttons. */
export const drawsWindowControls = desktop !== "macos";

/** Space reserved at the left of the title bar for macOS traffic lights. */
export const trafficLightInset = isMac ? 78 : 12;
