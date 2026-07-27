import { useTheme, type ThemeMode } from "../../shared/state/theme";

const MODES: { value: ThemeMode; icon: string; label: string }[] = [
  { value: "light", icon: "☀", label: "Light" },
  { value: "dark", icon: "☾", label: "Dark" },
  { value: "system", icon: "⌘", label: "System" },
];

/** Segmented light / dark / system switch. */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div className="flex h-7 items-center overflow-hidden rounded-md border border-edge">
      {MODES.map((option) => (
        <button
          key={option.value}
          onClick={() => setMode(option.value)}
          title={`${option.label} theme`}
          className={`flex h-full w-7 items-center justify-center text-xs leading-none ${
            mode === option.value
              ? "bg-elevated text-ink"
              : "text-muted hover:text-ink"
          }`}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
