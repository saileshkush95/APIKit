// LAN sync: sharing this workspace, and syncing with any number of peers.
//
// Peers are stored per workspace (a peer only makes sense for the workspace it
// was paired against). Each keeps its own watermarks so a round trip only moves
// what changed since last time.

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
  localChangeStamp,
  notifyLocalChange,
  secretGet,
  secretSet,
  onPeerChanged,
  onSyncApplied,
  onWatchState,
  pingPeer,
  setSetting,
  startSyncServer,
  stopSyncServer,
  syncServerStatus,
  syncUnwatchPeer,
  syncWatchPeer,
  syncWithPeer,
} from "../lib/api";
import { notifyError } from "../lib/notify";
import {
  GLOBAL_SCOPE,
  invalidateWorkspace,
  newId,
  workspaceDataOnce,
} from "../lib/storage";
import { useWorkspaceId } from "./workspaces";
import type { SyncPeer, SyncServerStatus } from "../types";

/** Beyond this, last-write-wins starts picking the wrong side. */
export const SKEW_WARNING_MS = 30_000;

interface SyncValue {
  peers: SyncPeer[];
  server: SyncServerStatus;
  token: string;
  port: number;
  busy: Set<string>;
  autoSyncSecs: number;
  /** Live mode: push local edits at once and follow each peer's change stream. */
  live: boolean;
  /** Peers whose event stream is currently connected. */
  connected: Set<string>;
  /** Why a peer's stream is not connected, keyed by host. */
  watchErrors: Record<string, string>;
  /** Bumped when a sync changed the database, to prompt a reload. */
  revision: number;
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
}

const SyncContext = createContext<SyncValue | null>(null);

const PEERS_KEY = "syncPeers";
/** Peers live in global settings: a peer is a machine, not a workspace. */
const PEERS_SCOPE = GLOBAL_SCOPE;
const CONFIG_KEY = "syncConfig";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();

  const [peers, setPeers] = useState<SyncPeer[]>([]);
  const [server, setServer] = useState<SyncServerStatus>({
    running: false,
    port: null,
    addresses: [],
  });
  const [token, setTokenState] = useState("");
  const [port, setPortState] = useState(7420);
  const [autoSyncSecs, setAutoSyncSecsState] = useState(0);
  const [live, setLiveState] = useState(false);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [watchErrors, setWatchErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);

  const latest = useRef({ peers, autoSyncSecs, workspaceId, live });
  latest.current = { peers, autoSyncSecs, workspaceId, live };
  // Newest local timestamp already pushed, so a change is only noticed once.
  const lastStamp = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        try {
          // Peers used to be stored per workspace; anything found there is
          // adopted once and then kept globally.
          const stored = JSON.parse(
            workspace.settings[PEERS_KEY] ?? "[]",
          ) as SyncPeer[];
          setPeers(
            stored.map((peer) => ({
              ...peer,
              // Older peers had no target, which is exactly why they synced
              // nothing — default them to the workspace they were added under.
              workspaceId: peer.workspaceId || workspaceId,
              workspaceName: peer.workspaceName || "",
              lastPushed: peer.lastPushed ?? null,
              lastPulled: peer.lastPulled ?? null,
            })),
          );
        } catch {
          setPeers([]);
        }
        try {
          const config = JSON.parse(workspace.settings[CONFIG_KEY] ?? "{}");
          setPortState(config.port ?? 7420);
          setAutoSyncSecsState(config.autoSyncSecs ?? 0);
          setLiveState(config.live ?? false);
        } catch {
          /* defaults are fine */
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));

    // The pairing token is a credential, so it lives in the OS keychain
    // rather than beside the collection.
    secretGet(`sync.token.${workspaceId}`)
      .then((stored) => {
        if (!cancelled) setTokenState(stored || randomToken());
      })
      .catch(() => !cancelled && setTokenState(randomToken()));

    syncServerStatus().then(setServer).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Persist peer list and server config per workspace.
  useEffect(() => {
    if (!ready) return;
    setSetting(PEERS_SCOPE, PEERS_KEY, JSON.stringify(peers)).catch((e) =>
      notifyError("Could not save the peer list", e),
    );
  }, [peers, ready, workspaceId]);

  useEffect(() => {
    if (!ready) return;
    setSetting(
      workspaceId,
      CONFIG_KEY,
      JSON.stringify({ port, autoSyncSecs, live }),
    ).catch((e) => notifyError("Could not save sync settings", e));
  }, [port, autoSyncSecs, live, ready, workspaceId]);

  useEffect(() => {
    if (!ready || token === "") return;
    secretSet(`sync.token.${workspaceId}`, token).catch((e) =>
      notifyError("Could not store the pairing token in the keychain", e),
    );
  }, [token, ready, workspaceId]);

  // A peer pushing to us changes the database directly.
  useEffect(() => {
    const unlisten = onSyncApplied(() => {
      invalidateWorkspace(latest.current.workspaceId);
      setRevision((value) => value + 1);
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  const syncPeer = useCallback(
    async (id: string) => {
      const peer = latest.current.peers.find((candidate) => candidate.id === id);
      if (!peer || peer.host.trim() === "") return;

      setBusy((prev) => new Set(prev).add(id));
      try {
        const target = peer.workspaceId || latest.current.workspaceId;
        const outcome = await syncWithPeer(
          peer.host,
          peer.token,
          target,
          peer.pulledWatermark,
          peer.pushedWatermark,
        );
        const skew = outcome.peerNow - outcome.localNow;
        setPeers((prev) =>
          prev.map((candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  pulledWatermark: outcome.pulledWatermark,
                  pushedWatermark: outcome.pushedWatermark,
                  lastSyncMs: Date.now(),
                  lastError: null,
                  lastSkewMs: skew,
                  lastPushed: outcome.pushed,
                  lastPulled: outcome.pulled,
                }
              : candidate,
          ),
        );
        if (outcome.pulled > 0) {
          invalidateWorkspace(latest.current.workspaceId);
          setRevision((value) => value + 1);
        }
      } catch (e) {
        setPeers((prev) =>
          prev.map((candidate) =>
            candidate.id === id
              ? { ...candidate, lastError: String(e), lastSyncMs: Date.now() }
              : candidate,
          ),
        );
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  const syncAll = useCallback(async () => {
    for (const peer of latest.current.peers) {
      if (peer.enabled) await syncPeer(peer.id);
    }
  }, [syncPeer]);

  // Follow each enabled peer's change stream while live mode is on.
  useEffect(() => {
    if (!ready) return;
    const watched = live
      ? peers.filter((peer) => peer.enabled && peer.host.trim() !== "")
      : [];

    for (const peer of watched) {
      syncWatchPeer(peer.host, peer.token).catch(() => {});
    }
    return () => {
      for (const peer of watched) {
        syncUnwatchPeer(peer.host).catch(() => {});
      }
      setConnected(new Set());
    };
    // Re-subscribes when the peer list changes, which is rare.
  }, [ready, live, peers.map((p) => `${p.host}:${p.token}:${p.enabled}`).join("|")]);

  useEffect(() => {
    const unlistenChanged = onPeerChanged((host) => {
      const peer = latest.current.peers.find(
        (candidate) => candidate.host.trim() === host,
      );
      if (peer) syncPeer(peer.id);
    });
    const unlistenState = onWatchState((host, isConnected, reason) => {
      setConnected((prev) => {
        const next = new Set(prev);
        if (isConnected) next.add(host);
        else next.delete(host);
        return next;
      });
      setWatchErrors((prev) => ({ ...prev, [host]: isConnected ? "" : reason }));
    });
    return () => {
      unlistenChanged.then((un) => un());
      unlistenState.then((un) => un());
    };
  }, [syncPeer]);

  // Watch our own data for edits and push them straight out. Polling here is
  // local (a MAX query), so it costs nothing on the network.
  useEffect(() => {
    if (!ready || !live) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const stamp = await localChangeStamp(latest.current.workspaceId);
        if (cancelled || stamp <= lastStamp.current) return;
        const first = lastStamp.current === 0;
        lastStamp.current = stamp;
        // Skip the first reading: it reflects existing data, not a new edit.
        if (first) return;
        await notifyLocalChange();
        await syncAll();
      } catch {
        // A transient failure is retried on the next tick.
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ready, live, syncAll]);

  // Auto-sync ticker; 0 means manual only.
  useEffect(() => {
    if (!ready || autoSyncSecs <= 0) return;
    const timer = setInterval(() => {
      syncAll();
    }, autoSyncSecs * 1000);
    return () => clearInterval(timer);
  }, [ready, autoSyncSecs, syncAll]);

  const value = useMemo<SyncValue>(
    () => ({
      peers,
      server,
      token,
      port,
      busy,
      autoSyncSecs,
      live,
      connected,
      watchErrors,
      revision,
      setToken: setTokenState,
      setPort: setPortState,
      setAutoSyncSecs: setAutoSyncSecsState,
      setLive: setLiveState,
      share: async () => {
        const bound = await startSyncServer(port, token);
        setPortState(bound);
        setServer(await syncServerStatus());
      },
      unshare: async () => {
        await stopSyncServer();
        setServer(await syncServerStatus());
      },
      addPeer: () =>
        setPeers((prev) => [
          ...prev,
          {
            id: newId(),
            name: `Peer ${prev.length + 1}`,
            host: "",
            token: "",
            enabled: true,
            // Defaults to the workspace open right now; the panel lets the user
            // pick one of the peer's instead.
            workspaceId: latest.current.workspaceId,
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
        setPeers((prev) =>
          prev.map((peer) => {
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
      removePeer: (id) => setPeers((prev) => prev.filter((peer) => peer.id !== id)),
      syncPeer,
      syncAll,
    }),
    [
      peers,
      server,
      token,
      port,
      busy,
      autoSyncSecs,
      live,
      connected,
      watchErrors,
      revision,
      syncPeer,
      syncAll,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error("useSync must be used inside <SyncProvider>");
  return value;
}

/** Checks a peer is reachable and reports clock difference in milliseconds. */
export async function probePeer(host: string): Promise<number> {
  const peerNow = await pingPeer(host);
  return peerNow - Date.now();
}
