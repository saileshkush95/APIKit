// GitHub sync: shared config/state for the sync panel and the header badge.
//
// The collection lives elsewhere; this store owns only the repository wiring
// and the last-known commit, so both surfaces agree on what is configured and
// stay reactive to each other's pushes and pulls.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  githubPush,
  secretGet,
  secretSet,
  setSetting,
} from "../lib/api";
import { notifyError } from "../lib/notify";
import {
  invalidateWorkspace,
  workspaceDataOnce,
} from "../lib/storage";
import type { GithubConfig, GithubPushResult } from "../types";

const CONFIG_KEY = "githubConfig";
const STATE_KEY = "githubState";

export interface GithubStored extends GithubConfig {
  autoPush: boolean;
}

interface GithubSyncStore {
  workspaceId: string;
  config: GithubStored;
  sha: string | null;
  lastSync: string | null;
  ready: boolean;
  busy: string | null;
  status: string | null;
  error: string | null;

  load: (workspaceId: string, workspaceName: string) => Promise<void>;
  setConfig: (patch: Partial<GithubStored>) => void;
  setStatus: (status: string | null) => void;
  setError: (error: string | null) => void;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  remember: (sha: string | null) => void;
  pushDocument: (
    content: string,
    message: string,
  ) => Promise<GithubPushResult | null>;
}

function emptyConfig(workspace: string): GithubStored {
  return {
    repo: "",
    branch: "main",
    path: `webrequestkit/${workspace
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workspace"}.json`,
    token: "",
    autoPush: false,
  };
}

export const useGithubSyncStore = create<GithubSyncStore>()((set, get) => ({
  workspaceId: "",
  config: emptyConfig("workspace"),
  sha: null,
  lastSync: null,
  ready: false,
  busy: null,
  status: null,
  error: null,

  load: async (workspaceId, workspaceName) => {
    set({ workspaceId, ready: false });
    try {
      const workspace = await workspaceDataOnce(workspaceId);
      try {
        const stored = JSON.parse(
          workspace.settings[CONFIG_KEY] ?? "{}",
        ) as GithubStored;
        set({
          config: { ...emptyConfig(workspaceName), ...stored, token: "" },
        });
      } catch {
        set({ config: emptyConfig(workspaceName) });
      }
      try {
        const state = JSON.parse(workspace.settings[STATE_KEY] ?? "{}");
        set({ sha: state.sha ?? null, lastSync: state.lastSync ?? null });
      } catch {
        /* keep the defaults */
      }
    } catch {
      /* a missing workspace simply has no sync configured yet */
    }

    try {
      const stored = await secretGet(`github.token.${workspaceId}`);
      if (stored) {
        set((state) => ({ config: { ...state.config, token: stored } }));
      }
    } catch {
      /* no token in the keychain is fine */
    }

    set({ ready: true });
  },

  setConfig: (patch) => {
    set((state) => ({ config: { ...state.config, ...patch } }));
    const { token, ...rest } = get().config;
    setSetting(get().workspaceId, CONFIG_KEY, JSON.stringify(rest)).catch((e) =>
      notifyError("Could not save the GitHub settings", e),
    );
    secretSet(`github.token.${get().workspaceId}`, token).catch((e) =>
      notifyError("Could not store the GitHub token in the keychain", e),
    );
    // Drop the module-level workspace cache so the next mount re-reads these
    // settings from the database instead of a pre-save snapshot.
    invalidateWorkspace(get().workspaceId);
  },

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),

  run: async (label, action) => {
    set({ busy: label, error: null, status: null });
    try {
      await action();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: null });
    }
  },

  remember: (sha) => {
    set({ sha, lastSync: new Date().toISOString() });
    setSetting(
      get().workspaceId,
      STATE_KEY,
      JSON.stringify({ sha, lastSync: get().lastSync }),
    ).catch(() => {});
  },

  pushDocument: async (content, message) => {
    const { config, sha } = get();
    const result = await githubPush(config, content, sha, message);
    get().remember(result.sha);
    return result;
  },
}));

/** Same shape the panel and header both consume. */
export function useGithubSync() {
  return useGithubSyncStore(
    useShallow((s) => ({
      config: s.config,
      sha: s.sha,
      lastSync: s.lastSync,
      ready: s.ready,
      busy: s.busy,
      status: s.status,
      error: s.error,
      load: s.load,
      setConfig: s.setConfig,
      setStatus: s.setStatus,
      setError: s.setError,
      run: s.run,
      remember: s.remember,
      pushDocument: s.pushDocument,
    })),
  );
}
