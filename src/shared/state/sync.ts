// LAN sync: sharing this workspace, and syncing with any number of peers.
//
// State lives here; the loops that keep it live — peer event streams and the
// local change watcher — run in `SyncEngine`, mounted once in the shell.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  localChangeStamp,
  notifyLocalChange,
  secretGet,
  secretSet,
  setSetting,
  startSyncServer,
  stopSyncServer,
  syncServerStatus,
  syncUnwatchPeer,
  syncWatchPeer,
  syncWithPeer,
} from "../lib/api";
import { notifyError } from "../lib/notify";
import { GLOBAL_SCOPE, invalidateWorkspace, newId, workspaceDataOnce } from "../lib/storage";
import type { SyncPeer, SyncServerStatus } from "../types";

/** Beyond this, last-write-wins starts picking the wrong side. */
export const SKEW_WARNING_MS = 30_000;

const PEERS_KEY = "syncPeers";
const CONFIG_KEY = "syncConfig";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

interface SyncStore {
  workspaceId: string;
  peers: SyncPeer[];
  server: SyncServerStatus;
  token: string;
  port: number;
  autoSyncSecs: number;
  live: boolean;
  busy: Set<string>;
  connected: Set<string>;
  watchErrors: Record<string, string>;
  /** Bumped when a sync changed the database, to prompt a reload. */
  revision: number;
  ready: boolean;
  /** Newest local timestamp already pushed, so a change is noticed once. */
  lastStamp: number;

  load: (workspaceId: string) => Promise<void>;
  setToken: (token: string) => void;
  setPort: (port: number) => void;
  setAutoSyncSecs: (seconds: number) => void;
  setLive: (live: boolean) => void;
  share: () => Promise<void>;
  unshare: () => Promise<void>;
  addPeer: () => void;
  updatePeer: (id: string, patch: Partial<SyncPeer>) => void;
  removePeer: (id: string) => void;
  syncPeer: (id: string) => Promise<void>;
  syncAll: () => Promise<void>;
  /** Called by the engine when a peer or the database reports a change. */
  noteApplied: () => void;
  setWatchState: (host: string, connected: boolean, reason: string) => void;
  pushLocalChanges: () => Promise<void>;
  watchedPeers: () => SyncPeer[];
}

export const useSyncStore = create<SyncStore>()((set, get) => {
  function persistPeers(peers: SyncPeer[]) {
    set({ peers });
    // Peers live in global settings: a peer is a machine, not a workspace.
    setSetting(GLOBAL_SCOPE, PEERS_KEY, JSON.stringify(peers)).catch((e) =>
      notifyError("Could not save the peer list", e),
    );
  }

  function persistConfig(patch: Partial<SyncStore>) {
    set(patch as never);
    const { port, autoSyncSecs, live, workspaceId } = get();
    setSetting(
      workspaceId,
      CONFIG_KEY,
      JSON.stringify({ port, autoSyncSecs, live }),
    ).catch(() => {});
  }

  return {
    workspaceId: "",
    peers: [],
    server: { running: false, port: null, addresses: [] },
    token: "",
    port: 7420,
    autoSyncSecs: 0,
    live: false,
    busy: new Set<string>(),
    connected: new Set<string>(),
    watchErrors: {},
    revision: 0,
    ready: false,
    lastStamp: 0,

    load: async (workspaceId) => {
      set({ ready: false, workspaceId, lastStamp: 0 });
      try {
        const workspace = await workspaceDataOnce(workspaceId);
        try {
          const stored = JSON.parse(
            workspace.settings[PEERS_KEY] ?? "[]",
          ) as SyncPeer[];
          set({
            peers: stored.map((peer) => ({
              ...peer,
              // Older peers had no target, which is exactly why they synced
              // nothing — default them to the workspace they were added under.
              workspaceId: peer.workspaceId || workspaceId,
              workspaceName: peer.workspaceName || "",
              lastPushed: peer.lastPushed ?? null,
              lastPulled: peer.lastPulled ?? null,
            })),
          });
        } catch {
          set({ peers: [] });
        }
        try {
          const config = JSON.parse(workspace.settings[CONFIG_KEY] ?? "{}");
          set({
            port: config.port ?? 7420,
            autoSyncSecs: config.autoSyncSecs ?? 0,
            live: config.live ?? false,
          });
        } catch {
          /* defaults are fine */
        }
      } catch {
        /* a missing workspace simply has no peers yet */
      } finally {
        set({ ready: true });
      }

      // The pairing token is a credential, so it lives in the OS keychain
      // rather than beside the collection.
      try {
        const stored = await secretGet(`sync.token.${workspaceId}`);
        set({ token: stored || randomToken() });
      } catch {
        set({ token: randomToken() });
      }

      syncServerStatus()
        .then((server) => set({ server }))
        .catch(() => {});
    },

    setToken: (token) => {
      set({ token });
      if (token === "") return;
      secretSet(`sync.token.${get().workspaceId}`, token).catch((e) =>
        notifyError("Could not store the pairing token in the keychain", e),
      );
    },
    setPort: (port) => persistConfig({ port }),
    setAutoSyncSecs: (autoSyncSecs) => persistConfig({ autoSyncSecs }),
    setLive: (live) => persistConfig({ live }),

    share: async () => {
      const bound = await startSyncServer(get().port, get().token);
      set({ port: bound, server: await syncServerStatus() });
    },

    unshare: async () => {
      await stopSyncServer();
      set({ server: await syncServerStatus() });
    },

    addPeer: () =>
      persistPeers([
        ...get().peers,
        {
          id: newId(),
          name: `Peer ${get().peers.length + 1}`,
          host: "",
          token: "",
          enabled: true,
          // Defaults to the workspace open right now; the panel lets the user
          // pick one of the peer's instead.
          workspaceId: get().workspaceId,
          workspaceName: "",
          pulledWatermark: 0,
          pushedWatermark: 0,
          lastSyncMs: null,
          lastError: null,
          lastSkewMs: null,
          lastPushed: null,
          lastPulled: null,
        },
      ]),

    updatePeer: (id, patch) =>
      persistPeers(
        get().peers.map((peer) => {
          if (peer.id !== id) return peer;
          const next = { ...peer, ...patch };
          // A different workspace means the old watermarks describe nothing.
          if (patch.workspaceId && patch.workspaceId !== peer.workspaceId) {
            next.pulledWatermark = 0;
            next.pushedWatermark = 0;
            next.lastPushed = null;
            next.lastPulled = null;
          }
          return next;
        }),
      ),

    removePeer: (id) =>
      persistPeers(get().peers.filter((peer) => peer.id !== id)),

    syncPeer: async (id) => {
      const peer = get().peers.find((candidate) => candidate.id === id);
      if (!peer || peer.host.trim() === "") return;

      set({ busy: new Set(get().busy).add(id) });
      try {
        const target = peer.workspaceId || get().workspaceId;
        const outcome = await syncWithPeer(
          peer.host,
          peer.token,
          target,
          peer.pulledWatermark,
          peer.pushedWatermark,
        );
        persistPeers(
          get().peers.map((candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  pulledWatermark: outcome.pulledWatermark,
                  pushedWatermark: outcome.pushedWatermark,
                  lastSyncMs: Date.now(),
                  lastError: null,
                  lastSkewMs: outcome.peerNow - outcome.localNow,
                  lastPushed: outcome.pushed,
                  lastPulled: outcome.pulled,
                }
              : candidate,
          ),
        );
        if (outcome.pulled > 0) get().noteApplied();
      } catch (e) {
        persistPeers(
          get().peers.map((candidate) =>
            candidate.id === id
              ? { ...candidate, lastError: String(e), lastSyncMs: Date.now() }
              : candidate,
          ),
        );
      } finally {
        const busy = new Set(get().busy);
        busy.delete(id);
        set({ busy });
      }
    },

    syncAll: async () => {
      for (const peer of get().peers) {
        if (peer.enabled) await get().syncPeer(peer.id);
      }
    },

    noteApplied: () => {
      invalidateWorkspace(get().workspaceId);
      set({ revision: get().revision + 1 });
    },

    setWatchState: (host, connected, reason) => {
      const next = new Set(get().connected);
      if (connected) next.add(host);
      else next.delete(host);
      set({
        connected: next,
        watchErrors: { ...get().watchErrors, [host]: connected ? "" : reason },
      });
    },

    pushLocalChanges: async () => {
      const stamp = await localChangeStamp(get().workspaceId);
      if (stamp <= get().lastStamp) return;
      const first = get().lastStamp === 0;
      set({ lastStamp: stamp });
      // Skip the first reading: it reflects existing data, not a new edit.
      if (first) return;
      await notifyLocalChange();
      await get().syncAll();
    },

    watchedPeers: () =>
      get().live
        ? get().peers.filter(
            (peer) => peer.enabled && peer.host.trim() !== "",
          )
        : [],
  };
});

export async function watchPeers(peers: SyncPeer[]): Promise<void> {
  for (const peer of peers) {
    await syncWatchPeer(peer.host, peer.token).catch(() => {});
  }
}

export async function unwatchPeers(peers: SyncPeer[]): Promise<void> {
  for (const peer of peers) {
    await syncUnwatchPeer(peer.host).catch(() => {});
  }
}

/** Same shape the provider exposed, so consumers are unchanged. */
export function useSync() {
  return useSyncStore(
    useShallow((s) => ({
      peers: s.peers,
      server: s.server,
      token: s.token,
      port: s.port,
      busy: s.busy,
      autoSyncSecs: s.autoSyncSecs,
      live: s.live,
      connected: s.connected,
      watchErrors: s.watchErrors,
      revision: s.revision,
      setToken: s.setToken,
      setPort: s.setPort,
      setAutoSyncSecs: s.setAutoSyncSecs,
      setLive: s.setLive,
      share: s.share,
      unshare: s.unshare,
      addPeer: s.addPeer,
      updatePeer: s.updatePeer,
      removePeer: s.removePeer,
      syncPeer: s.syncPeer,
      syncAll: s.syncAll,
    })),
  );
}
