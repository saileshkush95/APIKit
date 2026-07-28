import { useState } from "react";

export interface Sample {
  /** Seconds since the run started. */
  atSecs: number;
  value: number;
  /** Which phase produced it, so boundaries can be drawn. */
  phaseIndex: number;
  phaseLabel: string;
}

interface Props {
  title: string;
  samples: Sample[];
  /** Renders a value for the axis and the tooltip. */
  format: (value: number) => string;
  /** Height of the plot area in user units; the SVG scales to its container. */
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 10, right: 8, bottom: 16, left: 44 };

/**
 * One measure over time. Deliberately one series per chart — latency and
 * throughput share no scale, and a second y-axis would make both unreadable.
 */
export function LoadChart({ title, samples, format, height = 96 }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;

  if (samples.length < 2) {
    return (
      <div className="rounded border border-edge bg-panel p-3">
        <div className="text-[11px] font-semibold text-ink">{title}</div>
        <div
          className="flex items-center justify-center text-[11px] text-muted"
          style={{ height: plotHeight }}
        >
          Collecting samples…
        </div>
      </div>
    );
  }

  const maxAt = samples[samples.length - 1].atSecs || 1;
  const maxValue = Math.max(...samples.map((sample) => sample.value)) || 1;
  // A little headroom keeps the peak off the top edge.
  const top = maxValue * 1.15;

  const x = (atSecs: number) => PAD.left + (atSecs / maxAt) * plotWidth;
  const y = (value: number) =>
    PAD.top + plotHeight - (value / top) * plotHeight;

  const line = samples
    .map((sample, i) => `${i === 0 ? "M" : "L"}${x(sample.atSecs).toFixed(1)} ${y(sample.value).toFixed(1)}`)
    .join(" ");

  // Where the phase changes, so a spike can be read against the load applied.
  const boundaries = samples.filter(
    (sample, i) => i > 0 && sample.phaseIndex !== samples[i - 1].phaseIndex,
  );

  const last = samples[samples.length - 1];
  const active = hover === null ? null : samples[hover];

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    // The viewBox scales uniformly, so a proportional mapping is exact.
    const ratio = (event.clientX - box.left) / box.width;
    const atSecs = ((ratio * WIDTH - PAD.left) / plotWidth) * maxAt;
    let nearest = 0;
    for (let i = 1; i < samples.length; i++) {
      if (
        Math.abs(samples[i].atSecs - atSecs) <
        Math.abs(samples[nearest].atSecs - atSecs)
      ) {
        nearest = i;
      }
    }
    setHover(nearest);
  }

  return (
    <div className="rounded border border-edge bg-panel p-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-ink">{title}</span>
        <span className="text-[11px] text-muted">
          now {format(last.value)} · peak {format(maxValue)}
        </span>
        {active && (
          <span className="ml-auto font-mono text-[11px] text-ink">
            {active.atSecs}s · {format(active.value)}
            <span className="ml-1.5 text-muted">{active.phaseLabel}</span>
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive gridlines and their labels */}
        {[0, 0.5, 1].map((fraction) => {
          const value = top * (1 - fraction);
          const gy = PAD.top + plotHeight * fraction;
          return (
            <g key={fraction}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={gy}
                y2={gy}
                stroke="var(--color-edge)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={gy + 3}
                textAnchor="end"
                fill="var(--color-muted)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {format(value)}
              </text>
            </g>
          );
        })}

        {boundaries.map((sample) => (
          <g key={`${sample.phaseIndex}-${sample.atSecs}`}>
            <line
              x1={x(sample.atSecs)}
              x2={x(sample.atSecs)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke="var(--color-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text
              x={x(sample.atSecs) + 3}
              y={PAD.top + 8}
              fill="var(--color-muted)"
              fontSize={9}
            >
              {sample.phaseLabel}
            </text>
          </g>
        ))}

        <path
          d={line}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {active && (
          <>
            <line
              x1={x(active.atSecs)}
              x2={x(active.atSecs)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke="var(--color-brand)"
              strokeWidth={1}
            />
            <circle
              cx={x(active.atSecs)}
              cy={y(active.value)}
              r={4}
              fill="var(--color-brand)"
              stroke="var(--color-panel)"
              strokeWidth={2}
            />
          </>
        )}

        {/* Elapsed axis: first and last only, so nothing collides. */}
        <text
          x={PAD.left}
          y={height - 4}
          fill="var(--color-muted)"
          fontSize={9}
          fontFamily="var(--font-mono)"
        >
          0s
        </text>
        <text
          x={WIDTH - PAD.right}
          y={height - 4}
          textAnchor="end"
          fill="var(--color-muted)"
          fontSize={9}
          fontFamily="var(--font-mono)"
        >
          {maxAt}s
        </text>
      </svg>
    </div>
  );
}
