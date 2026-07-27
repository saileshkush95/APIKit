import { useState } from "react";
import { ApiClient } from "../features/client/ApiClient";
import { EnvironmentBar } from "../features/environments/EnvironmentBar";
import { MockPanel } from "../features/mock/MockPanel";
import { MonitorPanel } from "../features/monitor/MonitorPanel";
import { NAV_ICONS, NavRail, type NavItem } from "../shared/components/NavRail";
import { ProxyPanel } from "../features/proxy/ProxyPanel";
import { LoadTestPanel } from "../features/load/LoadTestPanel";
import { RunnerPanel } from "../features/runner/RunnerPanel";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { SyncPanel } from "../features/sync/SyncPanel";
import { ThemeToggle } from "../features/settings/ThemeToggle";
import { Tour } from "../features/onboarding/Tour";
import { WelcomeScreen } from "../features/onboarding/WelcomeScreen";
import { Toaster } from "../shared/components/Toaster";
import { WorkspaceSwitcher } from "../features/workspaces/WorkspaceSwitcher";
import { CollectionProvider } from "../shared/state/collection";
import { ActiveRequestProvider } from "../shared/state/activeRequest";
import { ConfirmProvider } from "../shared/state/confirm";
import { OnboardingProvider, useOnboarding } from "../shared/state/onboarding";
import { CommentsProvider } from "../shared/state/comments";
import { MonitorsProvider } from "../shared/state/monitors";
import { SettingsProvider } from "../shared/state/settings";
import { SyncProvider } from "../shared/state/sync";
import { EnvironmentsProvider } from "../shared/state/environments";
import { ThemeProvider } from "../shared/state/theme";
import { useWorkspaces, WorkspacesProvider } from "../shared/state/workspaces";
import "./App.css";

const VIEWS = [
  { key: "client", label: "Client", icon: NAV_ICONS.client },
  { key: "runner", label: "Runner", icon: NAV_ICONS.runner },
  { key: "load", label: "Load", icon: NAV_ICONS.load },
  { key: "monitor", label: "Monitor", icon: NAV_ICONS.monitor },
  { key: "mock", label: "Mock", icon: NAV_ICONS.mock },
  { key: "proxy", label: "Proxy", icon: NAV_ICONS.proxy },
  { key: "sync", label: "Sync", icon: NAV_ICONS.sync },
  { key: "settings", label: "Settings", icon: NAV_ICONS.settings },
] as const satisfies readonly NavItem[];

type View = (typeof VIEWS)[number]["key"];

/** macOS keeps its traffic lights on top of the overlay title bar. */
const isMac =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

function Shell() {
  const [view, setView] = useState<View>("client");
  // Set when the sidebar asks to run a folder, consumed by the runner.
  const [runTarget, setRunTarget] = useState<string | null>(null);
  // Bumped to ask the client to create a request or open the importer.
  const [clientIntent, setClientIntent] = useState<{
    kind: "new" | "import";
    at: number;
  } | null>(null);
  const { showWelcome, startTour } = useOnboarding();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      {/* The window uses an overlay title bar, so this header *is* the title
          bar: it is draggable, and on macOS it leaves room for the traffic
          lights. */}
      <header
        data-tauri-drag-region
        className="flex h-11 flex-none items-center gap-4 border-b border-edge bg-panel px-4"
        style={{ paddingLeft: isMac ? 84 : 16 }}
      >
        <div
          data-tauri-drag-region
          className="font-semibold tracking-tight select-none"
        >
          <span className="text-brand">◆</span> WebRequestKit
        </div>
        <div className="ml-auto flex items-center gap-3">
          <WorkspaceSwitcher />
          <EnvironmentBar />
          <button
            onClick={startTour}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-edge text-xs text-muted hover:bg-elevated hover:text-ink"
            title="Take the tour"
          >
            ?
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <NavRail
          items={VIEWS}
          active={view}
          onSelect={(key) => setView(key as View)}
        />
        <main className="flex min-h-0 min-w-0 flex-1">
          {view === "client" && (
            <ApiClient
              onRun={(folderId) => {
                setRunTarget(folderId);
                setView("runner");
              }}
              intent={clientIntent}
            />
          )}
          {view === "runner" && <RunnerPanel initialTarget={runTarget} />}
          {view === "load" && (
            <LoadTestPanel
              onOpenRunner={(folderId) => {
                setRunTarget(folderId);
                setView("runner");
              }}
            />
          )}
          {view === "monitor" && <MonitorPanel />}
          {view === "mock" && <MockPanel />}
          {view === "proxy" && <ProxyPanel />}
          {view === "sync" && <SyncPanel />}
          {view === "settings" && <SettingsPanel />}
        </main>
      </div>

      {showWelcome && (
        <WelcomeScreen
          onCreateRequest={() => {
            setView("client");
            setClientIntent({ kind: "new", at: Date.now() });
          }}
          onImport={() => {
            setView("client");
            setClientIntent({ kind: "import", at: Date.now() });
          }}
          onOpenSync={() => setView("sync")}
        />
      )}
      <Tour />
    </div>
  );
}

/**
 * Keyed on the active workspace so every provider below re-loads its slice
 * from SQLite when the user switches workspaces.
 */
function WorkspaceScope() {
  const { active } = useWorkspaces();

  // Sync sits above the data providers so they can reload when a peer's
  // changes land in the database.
  return (
    <SyncProvider key={active?.id ?? "none"}>
      <EnvironmentsProvider>
        <CollectionProvider>
          <ActiveRequestProvider>
            <CommentsProvider>
              <MonitorsProvider>
                <Shell />
              </MonitorsProvider>
            </CommentsProvider>
          </ActiveRequestProvider>
        </CollectionProvider>
      </EnvironmentsProvider>
    </SyncProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <ConfirmProvider>
          <OnboardingProvider>
            <WorkspacesProvider>
            <WorkspaceScope />
            </WorkspacesProvider>
          </OnboardingProvider>
          <Toaster />
        </ConfirmProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}

export default App;
