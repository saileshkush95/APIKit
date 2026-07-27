import { useEffect, useState } from "react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { revealMainWindow, useMinimumDuration } from "../features/onboarding/splash";
import { Toaster } from "../shared/components/Toaster";
import { ConfirmProvider } from "../shared/state/confirm";
import { useWorkspacesStore } from "../shared/state/workspaces";
import { routeTree } from "../routeTree.gen";
import { AppEngines } from "./AppEngines";
import "./App.css";

// A desktop window has no address bar, so history lives in memory — but routes
// still earn their keep: each view is addressable, cross-view actions travel as
// typed search params, and back/forward work.
const LAST_ROUTE_KEY = "lastRoute";
const KNOWN_VIEWS = [
  "client",
  "runner",
  "load",
  "monitor",
  "mock",
  "proxy",
  "sync",
  "settings",
];

/**
 * Reloading the webview would otherwise drop you back on the client, because
 * memory history always starts at its initial entry. The last location is
 * remembered instead — validated on the way back in, so a route removed in a
 * later version cannot strand the app on a dead path.
 */
function initialRoute(): string {
  try {
    const stored = localStorage.getItem(LAST_ROUTE_KEY);
    if (!stored?.startsWith("/")) return "/client";
    const view = stored.slice(1).split(/[/?]/)[0];
    return KNOWN_VIEWS.includes(view) ? stored : "/client";
  } catch {
    return "/client";
  }
}

const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [initialRoute()] }),
  defaultPreload: false,
});

router.subscribe("onResolved", ({ toLocation }) => {
  // `intent` asks the client to do something once (open the importer, create a
  // request); replaying it on every reload would be wrong, so it is dropped.
  const url = new URL(toLocation.href, "app://local");
  url.searchParams.delete("intent");
  url.searchParams.delete("at");
  const path = `${url.pathname}${url.search}`;
  try {
    localStorage.setItem(LAST_ROUTE_KEY, path);
  } catch {
    /* private mode; the app simply opens on the client next time */
  }
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function App() {
  const loaded = useWorkspacesStore((s) => s.loaded);
  const error = useWorkspacesStore((s) => s.error);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    useWorkspacesStore
      .getState()
      .init()
      .then((un) => {
        dispose = un;
      })
      .catch((e) => setFailed(String(e)));
    return () => dispose?.();
  }, []);

  // Held briefly even on a fast start, so the splash does not flash past.
  const splashing = useMinimumDuration(!loaded && !failed);

  // The splash is a real window shown by Tauri before this bundle exists, so
  // it only appears when the *process* starts — reloading the webview does not
  // bring it back. Once the workspace is open, this window takes over.
  useEffect(() => {
    if (!splashing) revealMainWindow();
  }, [splashing]);

  if (splashing) return null;

  if ((error || failed) && workspaces.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-8 text-center text-err">
        Could not open the workspace database: {error ?? failed}
      </div>
    );
  }

  return (
    <ConfirmProvider>
      <AppEngines />
      <RouterProvider router={router} />
      <Toaster />
    </ConfirmProvider>
  );
}

export default App;
