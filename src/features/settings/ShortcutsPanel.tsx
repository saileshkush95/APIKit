import { desktop } from "../../shared/lib/platform";
import { Section } from "../../shared/components/SettingsSection";

/** ⌘ on macOS, Ctrl elsewhere — both are handled by the same code paths. */
const MOD = desktop === "macos" ? "⌘" : "Ctrl";

interface Shortcut {
  keys: string[];
  label: string;
  /** Where it applies, when that is not obvious. */
  scope?: string;
}

const GLOBAL: Shortcut[] = [
  { keys: [MOD, "K"], label: "Command palette — jump anywhere, run anything" },
  { keys: [MOD, "B"], label: "Show or hide the sidebar" },
];

const CLIENT: Shortcut[] = [
  { keys: [MOD, "T"], label: "New request tab" },
  { keys: [MOD, "S"], label: "Save the open request" },
  { keys: [MOD, "↵"], label: "Send the request", scope: "Connect or disconnect, for streaming protocols" },
];

const COLLECTION: Shortcut[] = [
  { keys: [MOD, "click"], label: "Add or remove one row from the selection" },
  { keys: ["Shift", "click"], label: "Select a range of rows" },
  { keys: ["Right-click"], label: "Actions for the row, or for the whole selection" },
  { keys: ["Drag"], label: "Move into a folder, or reorder" },
];

const EDITORS: Shortcut[] = [
  { keys: ["Tab"], label: "Accept the highlighted completion", scope: "Scripts, GraphQL, and the header fields" },
  { keys: ["↑", "↓"], label: "Move through completions" },
  { keys: ["Esc"], label: "Dismiss completions" },
  { keys: [MOD, "↵"], label: "Post a comment", scope: "Comments tab" },
];

const LISTS: Shortcut[] = [
  { keys: ["Double-click"], label: "Rename in place", scope: "Load tests, mock folders" },
  { keys: ["Middle-click"], label: "Close a tab" },
  { keys: ["Esc"], label: "Close a dialog or menu" },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-none items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded border border-edge bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-ink"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function List({ shortcuts }: { shortcuts: Shortcut[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {shortcuts.map((shortcut) => (
        <div key={shortcut.label} className="flex items-baseline gap-3">
          <span className="w-32 flex-none">
            <Keys keys={shortcut.keys} />
          </span>
          <span className="min-w-0">
            <span className="text-xs text-ink">{shortcut.label}</span>
            {shortcut.scope && (
              <span className="block text-[11px] text-muted">
                {shortcut.scope}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Everything the keyboard does, gathered from the handlers themselves. */
export function ShortcutsPanel() {
  return (
    <>
      <Section title="Anywhere">
        <List shortcuts={GLOBAL} />
      </Section>
      <Section title="Client">
        <List shortcuts={CLIENT} />
      </Section>
      <Section
        title="Collection and lists"
        description="The sidebar, mock routes and saved load tests behave alike."
      >
        <List shortcuts={COLLECTION} />
      </Section>
      <Section title="Editors">
        <List shortcuts={EDITORS} />
      </Section>
      <Section title="Elsewhere">
        <List shortcuts={LISTS} />
      </Section>
    </>
  );
}
