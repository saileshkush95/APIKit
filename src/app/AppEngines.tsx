import { useEffect } from "react";
import {
  onPeerChanged,
  onStreamEvent,
  onStreamStatus,
  onSyncApplied,
  onWatchState,
} from "../shared/lib/api";
import { useCollectionStore } from "../shared/state/collection";
import { useCommentsStore } from "../shared/state/comments";
import { useEnvironmentsStore } from "../shared/state/environments";
import { useHistoryStore } from "../shared/state/history";
import { useMonitorsStore } from "../shared/state/monitors";
import {
  unwatchPeers,
  useSyncStore,
  watchPeers,
} from "../shared/state/sync";
import { useWorkspacesStore } from "../shared/state/workspaces";

/**
 * Everything that has to keep running regardless of which view is open:
 * the monitor scheduler, peer event streams, and the loaders that refill the
 * workspace-scoped stores. Mounted once, renders nothing.
 */
export function AppEngines() {
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  const revision = useSyncStore((s) => s.revision);
  const live = useSyncStore((s) => s.live);
  const autoSyncSecs = useSyncStore((s) => s.autoSyncSecs);
  const peerKey = useSyncStore((s) =>
    s.peers.map((p) => `${p.host}:${p.token}:${p.enabled}`).join("|"),
  );

  // Reload every workspace-scoped store when the workspace changes, and again
  // when a sync has written rows underneath us.
  useEffect(() => {
    if (!workspaceId) return;
    useSyncStore.getState().load(workspaceId);
    useEnvironmentsStore.getState().load(workspaceId);
    useCollectionStore.getState().load(workspaceId);
    useCommentsStore.getState().load(workspaceId);
    useHistoryStore.getState().load(workspaceId);
    useMonitorsStore.getState().load(workspaceId);
  }, [workspaceId, revision]);

  // A peer pushing to us changes the database directly.
  useEffect(() => {
    const unlisten = onSyncApplied(() => useSyncStore.getState().noteApplied());
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  // Live mode: follow each enabled peer's change stream.
  useEffect(() => {
    const peers = useSyncStore.getState().watchedPeers();
    watchPeers(peers);
    return () => {
      unwatchPeers(peers);
    };
  }, [live, peerKey]);

  useEffect(() => {
    const unlistenChanged = onPeerChanged((host) => {
      const peer = useSyncStore
        .getState()
        .peers.find((candidate) => candidate.host.trim() === host);
      if (peer) useSyncStore.getState().syncPeer(peer.id);
    });
    const unlistenState = onWatchState((host, connected, reason) =>
      useSyncStore.getState().setWatchState(host, connected, reason),
    );
    return () => {
      unlistenChanged.then((un) => un());
      unlistenState.then((un) => un());
    };
  }, []);

  // Watch our own data for edits and push them straight out. Polling here is
  // local (a MAX query), so it costs nothing on the network.
  useEffect(() => {
    if (!live || !workspaceId) return;
    const timer = setInterval(() => {
      useSyncStore
        .getState()
        .pushLocalChanges()
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [live, workspaceId]);

  // Auto-sync ticker; 0 means manual only.
  useEffect(() => {
    if (autoSyncSecs <= 0) return;
    const timer = setInterval(() => {
      useSyncStore.getState().syncAll();
    }, autoSyncSecs * 1000);
    return () => clearInterval(timer);
  }, [autoSyncSecs]);

  // The monitor scheduler compares wall-clock timestamps rather than counting
  // ticks, so a throttled timer delays a check but never skips one.
  useEffect(() => {
    const timer = setInterval(() => useMonitorsStore.getState().tick(), 1000);
    return () => clearInterval(timer);
  }, []);

  return null;
}

/** Streaming protocol events are routed to the tab that owns the session. */
export function useStreamRouting(
  onEvent: Parameters<typeof onStreamEvent>[0],
  onStatus: Parameters<typeof onStreamStatus>[0],
) {
  useEffect(() => {
    const unlistenEvent = onStreamEvent(onEvent);
    const unlistenStatus = onStreamStatus(onStatus);
    return () => {
      unlistenEvent.then((un) => un());
      unlistenStatus.then((un) => un());
    };
  }, []);
}
