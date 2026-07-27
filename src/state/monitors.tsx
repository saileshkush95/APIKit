// Scheduled health checks over saved requests.
//
// The scheduler lives in a provider mounted at the app root rather than in the
// Monitor view, so checks keep running while you work in other tabs. It is a
// desktop app: monitoring runs while the app is open, and each run's summary is
// persisted so history survives a restart.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  clearMonitorRuns,
  recordMonitorRun,
  saveMonitors,
} from "../lib/api";
import { executeRequest, isHealthy } from "../lib/execute";
import { usePersist } from "../lib/persist";
import { newId, workspaceDataOnce } from "../lib/storage";
import { findNode, isFolder } from "../lib/tree";
import { environmentVars } from "../lib/vars";
import { useCollection } from "./collection";
import { useEnvironments } from "./environments";
import { useSettings } from "./settings";
import { useSync } from "./sync";
import { useWorkspaceId } from "./workspaces";
import {
  defaultConfig,
  type Monitor,
  type MonitorRun,
  type SavedRequest,
  type TreeNode,
} from "../types";

interface MonitorsValue {
  monitors: Monitor[];
  runs: MonitorRun[];
  /** Monitors currently mid-check. */
  busy: Set<string>;
  create: () => void;
  update: (id: string, patch: Partial<Monitor>) => void;
  remove: (id: string) => void;
  runNow: (id: string) => void;
  clearHistory: (id: string) => void;
}

const MonitorsContext = createContext<MonitorsValue | null>(null);

function flatten(nodes: TreeNode[]): SavedRequest[] {
  return nodes.flatMap((node) =>
    isFolder(node) ? flatten(node.children) : [node],
  );
}

/**
 * A "url" monitor has no saved request behind it, so one is synthesised —
 * including a status assertion — and run through the same pipeline.
 */
function customRequest(monitor: Monitor): SavedRequest {
  const config = defaultConfig();
  config.bodyMode = monitor.body.trim() === "" ? "none" : "raw";
  return {
    kind: "request",
    id: `monitor:${monitor.id}`,
    name: monitor.name,
    method: monitor.method || "GET",
    url: monitor.url,
    headers: monitor.headers ?? [],
    body: monitor.body ?? "",
    tests: [
      {
        id: `monitor-status:${monitor.id}`,
        source: "status",
        target: "",
        op: "equals",
        expected: String(monitor.expectedStatus || 200),
      },
    ],
    config,
  };
}

/** The requests a monitor checks, in sidebar order. */
function targetRequests(monitor: Monitor, tree: TreeNode[]): SavedRequest[] {
  if (monitor.targetKind === "url") {
    return monitor.url.trim() === "" ? [] : [customRequest(monitor)];
  }
  if (monitor.targetKind === "collection") return flatten(tree);
  if (!monitor.targetId) return [];
  const node = findNode(tree, monitor.targetId);
  if (!node) return [];
  return isFolder(node) ? flatten(node.children) : [node];
}

async function notifyFailure(monitor: Monitor, detail: string) {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) {
      sendNotification({ title: `${monitor.name} failed`, body: detail });
    }
  } catch {
    // Notifications are a nicety; a denied permission must not break the run.
  }
}

export function MonitorsProvider({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();
  // Bumped when a sync applied rows, so the view reflects the new data.
  const { revision } = useSync();
  const { tree } = useCollection();
  const { environments, active, vars, setVariables } = useEnvironments();
  const { settings } = useSettings();

  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [runs, setRuns] = useState<MonitorRun[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  // The ticker reads live state through refs so it can stay registered once.
  const latest = useRef({ monitors, tree, vars, settings, environments, active });
  latest.current = { monitors, tree, vars, settings, environments, active };
  const lastRunAt = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        setMonitors(workspace.monitors);
        setRuns(workspace.monitorRuns);
        // Seed the schedule from history so a restart does not fire everything
        // at once.
        for (const run of workspace.monitorRuns) {
          const previous = lastRunAt.current.get(run.monitorId) ?? 0;
          if (run.atMs > previous) lastRunAt.current.set(run.monitorId, run.atMs);
        }
      })
      .catch((e) => console.error("failed to load monitors", e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, revision]);

  usePersist(monitors, ready, (value) => saveMonitors(workspaceId, value));

  const check = useCallback(
    async (monitor: Monitor) => {
      if (inFlight.current.has(monitor.id)) return;
      inFlight.current.add(monitor.id);
      setBusy((prev) => new Set(prev).add(monitor.id));
      lastRunAt.current.set(monitor.id, Date.now());

      const { tree, vars, settings, environments } = latest.current;
      // A monitor can pin its own environment so it does not follow whatever
      // the user happens to have selected.
      const pinned = monitor.environmentId
        ? environments.find((env) => env.id === monitor.environmentId)
        : null;
      const runVars = pinned ? environmentVars(pinned) : vars;

      const requests = targetRequests(monitor, tree);
      let failures = 0;
      let totalMs = 0;
      let detail = "";

      for (const request of requests) {
        const result = await executeRequest(request, {
          vars: runVars,
          settings,
          onVariables: setVariables,
        });
        totalMs += result.timeMs;
        if (!isHealthy(result)) {
          failures += 1;
          if (detail === "") {
            detail =
              result.error ??
              result.results.find((assertion) => !assertion.passed)?.message ??
              `${request.name} returned ${result.status}`;
          }
        }
      }

      const run: MonitorRun = {
        id: newId(),
        monitorId: monitor.id,
        atMs: Date.now(),
        ok: requests.length > 0 && failures === 0,
        requests: requests.length,
        failures,
        avgMs: requests.length ? totalMs / requests.length : 0,
        detail:
          requests.length === 0
            ? monitor.targetKind === "url"
              ? "no endpoint set"
              : "monitor has no requests to check"
            : detail || "all checks passed",
      };

      setRuns((prev) => [run, ...prev].slice(0, 500));
      recordMonitorRun(run).catch((e) =>
        console.error("failed to record monitor run", e),
      );
      if (!run.ok && monitor.notify) notifyFailure(monitor, run.detail);

      inFlight.current.delete(monitor.id);
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(monitor.id);
        return next;
      });
    },
    [setVariables],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const monitor of latest.current.monitors) {
        if (!monitor.enabled) continue;
        const previous = lastRunAt.current.get(monitor.id) ?? 0;
        if (now - previous >= monitor.intervalSecs * 1000) check(monitor);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [ready, check]);

  const value = useMemo<MonitorsValue>(
    () => ({
      monitors,
      runs,
      busy,
      create: () => {
        setMonitors((prev) => [
          ...prev,
          {
            id: newId(),
            name: `Monitor ${prev.length + 1}`,
            targetKind: "collection",
            targetId: null,
            intervalSecs: 300,
            enabled: false,
            environmentId: active?.id ?? null,
            notify: true,
            method: "GET",
            url: "",
            headers: [],
            body: "",
            expectedStatus: 200,
          },
        ]);
      },
      update: (id, patch) =>
        setMonitors((prev) =>
          prev.map((monitor) =>
            monitor.id === id ? { ...monitor, ...patch } : monitor,
          ),
        ),
      remove: (id) => {
        setMonitors((prev) => prev.filter((monitor) => monitor.id !== id));
        setRuns((prev) => prev.filter((run) => run.monitorId !== id));
      },
      runNow: (id) => {
        const monitor = monitors.find((m) => m.id === id);
        if (monitor) check(monitor);
      },
      clearHistory: (id) => {
        setRuns((prev) => prev.filter((run) => run.monitorId !== id));
        clearMonitorRuns(id).catch(() => {});
      },
    }),
    [monitors, runs, busy, active, check],
  );

  return (
    <MonitorsContext.Provider value={value}>
      {children}
    </MonitorsContext.Provider>
  );
}

export function useMonitors(): MonitorsValue {
  const value = useContext(MonitorsContext);
  if (!value) {
    throw new Error("useMonitors must be used inside <MonitorsProvider>");
  }
  return value;
}
