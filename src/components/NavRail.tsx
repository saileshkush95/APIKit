import type { ReactNode } from "react";

export interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
}

interface Props {
  items: readonly NavItem[];
  active: string;
  onSelect: (key: string) => void;
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const NAV_ICONS = {
  client: (
    <svg {...iconProps}>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="19" cy="18" r="2" />
    </svg>
  ),
  runner: (
    <svg {...iconProps}>
      <path d="M6 4l12 8-12 8V4z" />
    </svg>
  ),
  mock: (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  ),
  proxy: (
    <svg {...iconProps}>
      <path d="M4 7h9a4 4 0 014 4v6" />
      <path d="M14 4l3 3-3 3" />
      <path d="M20 17l-3 3-3-3" />
    </svg>
  ),
  load: (
    <svg {...iconProps}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6M20 16v-9" />
    </svg>
  ),
  monitor: (
    <svg {...iconProps}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
    </svg>
  ),
  sync: (
    <svg {...iconProps}>
      <path d="M4 9a8 8 0 0113.7-5.6L20 6" />
      <path d="M20 15a8 8 0 01-13.7 5.6L4 18" />
      <path d="M20 3v3h-3M4 21v-3h3" />
    </svg>
  ),
  settings: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </svg>
  ),
} as const;

/** Postman-style vertical rail of workspace sections. */
export function NavRail({ items, active, onSelect }: Props) {
  return (
    <nav className="flex w-16 flex-none flex-col items-stretch border-r border-edge bg-panel py-1.5">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            onClick={() => onSelect(item.key)}
            title={item.label}
            className={`relative flex flex-col items-center gap-1 px-1 py-2.5 text-[10px] leading-tight ${
              selected
                ? "text-brand"
                : "text-muted hover:bg-elevated hover:text-ink"
            }`}
          >
            {selected && (
              <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-brand" />
            )}
            {item.icon}
            <span className="w-full truncate text-center">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
