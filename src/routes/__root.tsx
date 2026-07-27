import {
  createRootRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { EnvironmentBar } from "../features/environments/EnvironmentBar";
import { Tour } from "../features/onboarding/Tour";
import { WelcomeScreen } from "../features/onboarding/WelcomeScreen";
import { ThemeToggle } from "../features/settings/ThemeToggle";
import { WorkspaceSwitcher } from "../features/workspaces/WorkspaceSwitcher";
import { CommandPalette } from "../shared/components/CommandPalette";
import { Logo } from "../shared/components/Logo";
import { NAV_ICONS, NavRail, type NavItem } from "../shared/components/NavRail";
import { WindowControls } from "../shared/components/WindowControls";
import { drawsWindowControls, trafficLightInset } from "../shared/lib/platform";
import { useOnboarding } from "../shared/state/onboarding";

/** Left rail order; `key` doubles as the route path. */
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

export const Route = createRootRoute({ component: RootLayout });

/** Window chrome and navigation; the routed view renders into the outlet. */
function RootLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { showWelcome, startTour } = useOnboarding();

  const active = pathname.split("/")[1] || "client";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      {/* This header *is* the title bar on every platform: draggable, with room
          for macOS traffic lights on the left, and our own window buttons on
          the right where the window is undecorated. */}
      <header
        data-tauri-drag-region
        className="flex h-11 flex-none items-center gap-4 border-b border-edge bg-panel pr-0 select-none"
        style={{ paddingLeft: trafficLightInset }}
      >
        <div data-tauri-drag-region>
          <Logo size={20} />
        </div>
        <div className="ml-auto flex items-center gap-3 pr-3">
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
          {drawsWindowControls && <div className="w-1" />}
        </div>
        <WindowControls />
      </header>

      <CommandPalette />

      <div className="flex min-h-0 flex-1">
        <NavRail
          items={VIEWS}
          active={active}
          onSelect={(key) => navigate({ to: `/${key}` })}
        />
        <main className="flex min-h-0 min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {showWelcome && (
        <WelcomeScreen
          onCreateRequest={() =>
            navigate({
              to: "/client",
              search: { intent: "new", at: Date.now() },
            })
          }
          onImport={() =>
            navigate({
              to: "/client",
              search: { intent: "import", at: Date.now() },
            })
          }
          onOpenSync={() => navigate({ to: "/sync" })}
        />
      )}
      <Tour />
    </div>
  );
}
