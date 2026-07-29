// Scheduled health checks over saved requests.
//
// State lives in the store; the ticking lives in `MonitorEngine`, mounted once
// in the shell. Checks therefore keep running while you work in other views —
// it is a desktop app, so they run for as long as the process does.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { clearMonitorRuns, recordMonitorRun, saveMonitors } from "../lib/api";
import {
  monitorRecipients,
  sendMonitorEmail,
  smtpConfigured,
} from "../lib/email";
import { executeRequest, isHealthy } from "../lib/execute";
import { notifyError } from "../lib/notify";
import { logConsole } from "./console";
import { createSaver } from "../lib/save";
import { newId, workspaceDataOnce } from "../lib/storage";
import { findNode, isFolder } from "../lib/tree";
import { environmentVars } from "../lib/vars";
import { useCollectionStore } from "./collection";
import { useEnvironmentsStore } from "./environments";
import { useSettings } from "./settings";
import {
  defaultConfig,
  type Monitor,
  type MonitorRun,
  type SavedRequest,
  type TreeNode,
} from "../types";

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

interface MonitorsStore {
  workspaceId: string;
  monitors: Monitor[];
  runs: MonitorRun[];
  busy: Set<string>;
  ready: boolean;
  /** When each monitor last ran, so a restart does not fire everything. */
  lastRunAt: Map<string, number>;
  load: (workspaceId: string) => Promise<void>;
  create: () => void;
  update: (id: string, patch: Partial<Monitor>) => void;
  remove: (id: string) => void;
  check: (monitor: Monitor) => Promise<void>;
  runNow: (id: string) => void;
  clearHistory: (id: string) => void;
  /** Runs every monitor whose interval has elapsed. Driven by the engine. */
  tick: () => void;
}

export const useMonitorsStore = create<MonitorsStore>()((set, get) => {
  const saveSoon = createSaver<{ workspaceId: string; list: Monitor[] }>(
    ({ workspaceId, list }) => saveMonitors(workspaceId, list),
  );
  const inFlight = new Set<string>();

  function commit(monitors: Monitor[]) {
    set({ monitors });
    saveSoon({ workspaceId: get().workspaceId, list: monitors });
  }

  return {
    workspaceId: "",
    monitors: [],
    runs: [],
    busy: new Set<string>(),
    ready: false,
    lastRunAt: new Map<string, number>(),

    load: async (workspaceId) => {
      set({ ready: false, workspaceId });
      try {
        const workspace = await workspaceDataOnce(workspaceId);
        const lastRunAt = new Map<string, number>();
        // Seed the schedule from history so a restart does not fire everything
        // at once.
        for (const run of workspace.monitorRuns) {
          const previous = lastRunAt.get(run.monitorId) ?? 0;
          if (run.atMs > previous) lastRunAt.set(run.monitorId, run.atMs);
        }
        set({
          monitors: workspace.monitors,
          runs: workspace.monitorRuns,
          lastRunAt,
        });
      } catch (e) {
        notifyError("Could not load monitors", e);
      } finally {
        set({ ready: true });
      }
    },

    create: () =>
      commit([
        ...get().monitors,
        {
          id: newId(),
          name: `Monitor ${get().monitors.length + 1}`,
          targetKind: "collection",
          targetId: null,
          intervalSecs: 300,
          enabled: false,
          environmentId: useEnvironmentsStore.getState().activeId,
          notify: true,
          emailNotify: false,
          emailTo: "",
          emailAfter: 1,
          emailRecovery: true,
          method: "GET",
          url: "",
          headers: [],
          body: "",
          expectedStatus: 200,
        },
      ]),

    update: (id, patch) =>
      commit(
        get().monitors.map((monitor) =>
          monitor.id === id ? { ...monitor, ...patch } : monitor,
        ),
      ),

    remove: (id) => {
      commit(get().monitors.filter((monitor) => monitor.id !== id));
      set({ runs: get().runs.filter((run) => run.monitorId !== id) });
    },

    check: async (monitor) => {
      if (inFlight.has(monitor.id)) return;
      inFlight.add(monitor.id);
      set({ busy: new Set(get().busy).add(monitor.id) });
      get().lastRunAt.set(monitor.id, Date.now());

      const { tree } = useCollectionStore.getState();
      const environments = useEnvironmentsStore.getState();
      const { settings } = useSettings.getState();

      // A monitor can pin its own environment so it does not follow whatever
      // the user happens to have selected.
      const pinned = monitor.environmentId
        ? environments.environments.find(
            (env) => env.id === monitor.environmentId,
          )
        : null;
      const active =
        environments.environments.find(
          (env) => env.id === environments.activeId,
        ) ?? null;
      const runVars = pinned
        ? environmentVars(pinned)
        : { ...environmentVars(active), ...environments.sessionVars };

      const requests = targetRequests(monitor, tree);
      let failures = 0;
      let totalMs = 0;
      let detail = "";

      for (const request of requests) {
        const result = await executeRequest(request, {
          vars: runVars,
          settings,
          onVariables: environments.setVariables,
          // Without the tree, "inherit from parent" auth silently resolves to
          // none — so a monitor on a folder that carries the credentials
          // reported failures that were not real.
          tree,
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

      // How many checks in a row were failing before this one, read before the
      // new run is inserted.
      let priorFails = 0;
      for (const candidate of get().runs) {
        if (candidate.monitorId !== monitor.id) continue;
        if (candidate.ok) break;
        priorFails += 1;
      }

      logConsole({
        level: run.ok ? "response" : "error",
        source: "Monitor",
        message: `${monitor.name} — ${run.detail}`,
        detail: { timeMs: Math.round(run.avgMs) },
      });

      set({ runs: [run, ...get().runs].slice(0, 500) });
      recordMonitorRun(run).catch((e) =>
        notifyError("Could not record the monitor result", e),
      );
      if (!run.ok && monitor.notify) notifyFailure(monitor, run.detail);

      // Email exactly once per incident: when the failure streak reaches the
      // monitor's threshold, and (optionally) once more on recovery. Repeat
      // failures beyond the threshold stay silent, so a 30-second monitor
      // cannot flood an inbox.
      const threshold = Math.max(1, monitor.emailAfter ?? 1);
      const streak = run.ok ? priorFails : priorFails + 1;
      const shouldEmail = run.ok
        ? priorFails >= threshold && (monitor.emailRecovery ?? true)
        : streak === threshold;
      if (
        monitor.emailNotify &&
        shouldEmail &&
        monitorRecipients(settings, monitor) !== "" &&
        smtpConfigured(settings)
      ) {
        sendMonitorEmail(settings, monitor, run, streak).catch((e) =>
          notifyError(`Could not email about ${monitor.name}`, e),
        );
      }

      inFlight.delete(monitor.id);
      const busy = new Set(get().busy);
      busy.delete(monitor.id);
      set({ busy });
    },

    runNow: (id) => {
      const monitor = get().monitors.find((candidate) => candidate.id === id);
      if (monitor) get().check(monitor);
    },

    clearHistory: (id) => {
      set({ runs: get().runs.filter((run) => run.monitorId !== id) });
      clearMonitorRuns(id).catch(() => {});
    },

    tick: () => {
      if (!get().ready) return;
      const now = Date.now();
      for (const monitor of get().monitors) {
        if (!monitor.enabled) continue;
        const previous = get().lastRunAt.get(monitor.id) ?? 0;
        if (now - previous >= monitor.intervalSecs * 1000) get().check(monitor);
      }
    },
  };
});

/** Same shape the provider exposed, so consumers are unchanged. */
export function useMonitors() {
  return useMonitorsStore(
    useShallow((s) => ({
      monitors: s.monitors,
      runs: s.runs,
      busy: s.busy,
      create: s.create,
      update: s.update,
      remove: s.remove,
      runNow: s.runNow,
      clearHistory: s.clearHistory,
    })),
  );
}
