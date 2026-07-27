// Preset shapes for the load-testing panel.

import type { LoadPhase, LoadTestKind } from "../types";

export interface Preset {
  kind: LoadTestKind;
  label: string;
  icon: string;
  accent: string;
  blurb: string;
  phases: LoadPhase[];
}

export const PRESETS: Preset[] = [
  {
    kind: "load",
    label: "Load Test",
    icon: "⚡",
    accent: "text-method-post",
    blurb: "Steady traffic at a fixed number of virtual users.",
    phases: [{ label: "steady", vus: 10, durationSecs: 30 }],
  },
  {
    kind: "stress",
    label: "Stress Test",
    icon: "↗",
    accent: "text-err",
    blurb: "Ramps users up in stages until the service degrades.",
    phases: [
      { label: "ramp 5", vus: 5, durationSecs: 15 },
      { label: "ramp 15", vus: 15, durationSecs: 15 },
      { label: "ramp 30", vus: 30, durationSecs: 15 },
      { label: "ramp 50", vus: 50, durationSecs: 15 },
    ],
  },
  {
    kind: "spike",
    label: "Spike Test",
    icon: "⚡",
    accent: "text-warn",
    blurb: "Sudden burst, then back down — shows recovery behaviour.",
    phases: [
      { label: "pre-spike", vus: 5, durationSecs: 10 },
      { label: "spike", vus: 50, durationSecs: 5 },
      { label: "recovery", vus: 5, durationSecs: 15 },
    ],
  },
  {
    kind: "soak",
    label: "Soak Test",
    icon: "◷",
    accent: "text-method-patch",
    blurb: "Modest load held for a long time to surface leaks.",
    phases: [{ label: "soak", vus: 5, durationSecs: 300 }],
  },
  {
    kind: "assertions",
    label: "Assertions",
    icon: "✓",
    accent: "text-ok",
    blurb: "Runs the request repeatedly and checks its assertions.",
    phases: [],
  },
  {
    kind: "chain",
    label: "Chain Test",
    icon: "🔗",
    accent: "text-method-put",
    blurb: "Runs a folder in order, passing variables between requests.",
    phases: [],
  },
];

export function presetFor(kind: LoadTestKind): Preset {
  return PRESETS.find((preset) => preset.kind === kind) ?? PRESETS[0];
}

/** Total wall-clock seconds a phase list will take. */
export function totalDuration(phases: LoadPhase[]): number {
  return phases.reduce((sum, phase) => sum + phase.durationSecs, 0);
}
