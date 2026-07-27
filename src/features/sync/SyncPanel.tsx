import { Toggle } from "../../shared/components/Toggle";
import { Input, Select } from "../../shared/components/Field";
import { useState } from "react";
import { GithubPanel } from "./GithubPanel";
import { diagnosePeer, listPeerWorkspaces } from "../../shared/lib/api";
import { SKEW_WARNING_MS, useSync } from "../../shared/state/sync";
import { useWorkspaces } from "../../shared/state/workspaces";
import type { WorkspaceMeta } from "../../shared/types";


function ago(ms: number | null): string {
  if (ms === null) return "never";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function SyncPanel() {
  const {
    peers,
    server,
    token,
    port,
    busy,
    autoSyncSecs,
    live,
    connected,
    watchErrors,
    setLive,
    setToken,
    setPort,
    setAutoSyncSecs,
    share,
    unshare,
    addPeer,
    updatePeer,
    removePeer,
    syncPeer,
    syncAll,
  } = useSync();
  const { active } = useWorkspaces();

  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<Record<string, string>>({});
  // Workspaces each peer is offering, once fetched.
  const [offered, setOffered] = useState<Record<string, WorkspaceMeta[]>>({});
  const [loadingList, setLoadingList] = useState<string | null>(null);

  async function guard(action: Promise<unknown>) {
    setError(null);
    try {
      await action;
    } catch (e) {
      setError(String(e));
    }
  }

  /** Reads the peer's workspaces so one can be paired with. */
  async function loadWorkspaces(id: string, host: string, token: string) {
    setLoadingList(id);
    setError(null);
    try {
      const list = await listPeerWorkspaces(host, token);
      setOffered((prev) => ({ ...prev, [id]: list }));
      if (list.length === 0) {
        setError("That peer has no workspaces to share yet.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingList(null);
    }
  }

  /** Full check: reachable, token accepted, live stream available. */
  async function probe(id: string, host: string, token: string) {
    setProbing(id);
    try {
      const result = await diagnosePeer(host, token);
      setProbeResult((prev) => ({ ...prev, [id]: result.summary }));
    } catch (e) {
      setProbeResult((prev) => ({ ...prev, [id]: String(e) }));
    } finally {
      setProbing(null);
    }
  }

  return (
    <div className="min-h-0 w-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
        <div>
          <h1 className="text-base font-semibold">Local network sync</h1>
          <p className="text-xs text-muted">
            Each machine keeps its own database and works offline. Syncing
            exchanges only what changed, and the newer edit of a given request
            wins. Syncing “{active?.name ?? "this workspace"}”.
          </p>
        </div>

        {error && (
          <div className="rounded border border-err bg-err/10 px-3 py-2 text-xs text-err">
            {error}
          </div>
        )}

        {/* Share this machine */}
        <section className="rounded-lg border border-edge bg-panel">
          <div className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
            <h2 className="text-sm font-semibold">Share this workspace</h2>
            <span
              className={`flex items-center gap-1.5 text-xs ${
                server.running ? "text-ok" : "text-muted"
              }`}
            >
              <span className="text-base leading-none">●</span>
              {server.running ? "Sharing" : "Not sharing"}
            </span>
            <button
              onClick={() =>
                guard(server.running ? unshare() : share())
              }
              className={`ml-auto rounded-md px-4 py-1.5 text-xs font-semibold text-white ${
                server.running
                  ? "bg-err hover:opacity-90"
                  : "bg-brand hover:bg-brand-bright"
              }`}
            >
              {server.running ? "Stop sharing" : "Start sharing"}
            </button>
          </div>

          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Port
                <Input
                  type="number"
                  value={port}
                  disabled={server.running}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className={"wrk-field w-24 font-mono disabled:opacity-50"}
                />
              </label>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
                Pairing token
                <Input
                  value={token}
                  spellCheck={false}
                  disabled={server.running}
                  onChange={(e) => setToken(e.target.value)}
                  className={"wrk-field min-w-0 flex-1 font-mono disabled:opacity-50"}
                />
              </label>
            </div>

            {server.running && (
              <div className="rounded border border-edge bg-canvas px-3 py-2">
                <div className="text-[11px] text-muted">
                  On the other machine, add a peer with:
                </div>
                {server.addresses.map((address) => (
                  <div key={address} className="font-mono text-xs text-ink">
                    {address}:{server.port}
                  </div>
                ))}
                <div className="mt-1 font-mono text-xs text-ink">
                  token: {token}
                </div>
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-warn">
              Traffic is plain HTTP on your local network, protected only by the
              pairing token. Share on networks you trust, and stop sharing when
              you are done.
            </p>
          </div>
        </section>

        {/* Peers */}
        <section className="rounded-lg border border-edge bg-panel">
          <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
            <h2 className="text-sm font-semibold">Peers</h2>
            <Toggle
              checked={live}
              onChange={setLive}
              label="Live"
              title="Push local edits immediately and follow each peer's change stream"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Auto-sync
              <Select
                value={autoSyncSecs}
                onChange={(e) => setAutoSyncSecs(Number(e.target.value))}
                className={"wrk-field cursor-pointer"}
              >
                <option value={0}>Manual only</option>
                <option value={30}>Every 30 seconds</option>
                <option value={60}>Every minute</option>
                <option value={300}>Every 5 minutes</option>
              </Select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => guard(syncAll())}
                disabled={peers.length === 0}
                className="rounded border border-edge px-3 py-1.5 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
              >
                Sync all
              </button>
              <button
                onClick={addPeer}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright"
              >
                + Add peer
              </button>
            </div>
          </div>

          {peers.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted">
              No peers yet. Add the address and token shown on another machine
              that is sharing, then choose which workspace to sync.
            </p>
          ) : (
            peers.map((peer) => {
              const syncing = busy.has(peer.id);
              const skewed =
                peer.lastSkewMs !== null &&
                Math.abs(peer.lastSkewMs) > SKEW_WARNING_MS;
              return (
                <div key={peer.id} className="border-b border-edge px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={peer.name}
                      spellCheck={false}
                      onChange={(e) =>
                        updatePeer(peer.id, { name: e.target.value })
                      }
                      className="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-ink outline-none hover:border-edge focus:border-brand"
                    />
                    <Input
                      value={peer.host}
                      spellCheck={false}
                      placeholder="192.168.1.20:7420"
                      onChange={(e) =>
                        updatePeer(peer.id, { host: e.target.value })
                      }
                      className={"wrk-field w-48 font-mono"}
                    />
                    <Input
                      value={peer.token}
                      spellCheck={false}
                      placeholder="pairing token"
                      onChange={(e) =>
                        updatePeer(peer.id, { token: e.target.value })
                      }
                      className={"wrk-field w-40 font-mono"}
                    />
                    <Toggle
                      checked={peer.enabled}
                      onChange={(enabled) => updatePeer(peer.id, { enabled })}
                      label="Auto"
                      title="Include in auto-sync and Sync all"
                    />

                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={() => probe(peer.id, peer.host, peer.token)}
                        disabled={probing === peer.id || peer.host === ""}
                        className="rounded border border-edge px-2 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                      >
                        {probing === peer.id ? "…" : "Test"}
                      </button>
                      <button
                        onClick={() => guard(syncPeer(peer.id))}
                        disabled={syncing || peer.host === ""}
                        className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
                      >
                        {syncing ? "Syncing…" : "Sync"}
                      </button>
                      <button
                        onClick={() => removePeer(peer.id)}
                        className="rounded px-1.5 py-1 text-xs text-muted hover:text-err"
                        title="Remove peer"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted">Workspace</span>
                    <Select
                      value={peer.workspaceId}
                      onChange={(e) => {
                        const chosen = (offered[peer.id] ?? []).find(
                          (workspace) => workspace.id === e.target.value,
                        );
                        updatePeer(peer.id, {
                          workspaceId: e.target.value,
                          workspaceName: chosen?.name ?? "",
                        });
                      }}
                      className={"wrk-field min-w-56 cursor-pointer"}
                    >
                      {/* Pushing your own workspace creates it on the peer. */}
                      <option value={active?.id ?? ""}>
                        Mine — {active?.name ?? "current workspace"}
                      </option>
                      {(offered[peer.id] ?? [])
                        .filter((workspace) => workspace.id !== active?.id)
                        .map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            Theirs — {workspace.name}
                          </option>
                        ))}
                      {peer.workspaceId !== active?.id &&
                        !(offered[peer.id] ?? []).some(
                          (workspace) => workspace.id === peer.workspaceId,
                        ) && (
                          <option value={peer.workspaceId}>
                            {peer.workspaceName || "Paired workspace"}
                          </option>
                        )}
                    </Select>
                    <button
                      onClick={() =>
                        loadWorkspaces(peer.id, peer.host, peer.token)
                      }
                      disabled={loadingList === peer.id || peer.host === ""}
                      className="rounded border border-edge px-2 py-1 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                    >
                      {loadingList === peer.id ? "Loading…" : "Load theirs"}
                    </button>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
                    {live && peer.enabled && (
                      <span
                        className={
                          connected.has(peer.host.trim())
                            ? "text-ok"
                            : watchErrors[peer.host.trim()]
                              ? "text-warn"
                              : "text-muted"
                        }
                      >
                        ●{" "}
                        {connected.has(peer.host.trim())
                          ? "live"
                          : (watchErrors[peer.host.trim()] ?? "connecting…")}
                      </span>
                    )}
                    <span className="text-muted">
                      Last sync {ago(peer.lastSyncMs)}
                      {peer.lastSyncMs !== null && peer.lastError === null
                        ? ` · sent ${peer.lastPushed ?? 0}, received ${peer.lastPulled ?? 0}`
                        : ""}
                    </span>
                    {probeResult[peer.id] && (
                      <span className="text-muted">{probeResult[peer.id]}</span>
                    )}
                    {skewed && (
                      <span className="text-warn">
                        Clock differs by{" "}
                        {Math.round((peer.lastSkewMs ?? 0) / 1000)}s — the machine
                        running fast will win conflicts. Sync the clocks.
                      </span>
                    )}
                    {peer.lastError && (
                      <span className="text-err">{peer.lastError}</span>
                    )}
                    {peer.lastError === null &&
                      peer.lastPulled === 0 &&
                      (peer.lastPushed ?? 0) > 0 &&
                      peer.workspaceId === active?.id && (
                        <span className="text-warn">
                          Sent yours, received nothing — that peer has a
                          different workspace. Use “Load theirs” to adopt it.
                        </span>
                      )}
                  </div>
                </div>
              );
            })
          )}
        </section>

        <GithubPanel />

        <div className="rounded-lg border border-edge bg-panel p-4">
          <h3 className="text-xs font-semibold text-ink">How it works</h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-relaxed text-muted">
            <li>
              Shared: folders, requests, environments, mock routes, monitors,
              comments and docs.
            </li>
            <li>
              Kept local: open tabs, responses, monitor history, proxy flows and
              appearance settings.
            </li>
            <li>
              Conflicts resolve per request — if you and a colleague edit
              different requests, both survive; if you edit the same one, the
              newer edit wins.
            </li>
            <li>
              Deletions propagate, so removing a folder here removes it on every
              peer at their next sync.
            </li>
            <li>
              With <strong>Live</strong> on, edits reach peers in about a
              second: local changes push straight away, and each peer's change
              stream triggers a pull.
            </li>
            <li>
              Each peer syncs <strong>one workspace</strong>, and both machines
              must agree on which. Choose “Mine” to push yours over, or “Load
              theirs” to adopt one of theirs — it then appears in your workspace
              switcher.
            </li>
            <li>
              Full guide in <span className="font-mono">docs/lan-sync.md</span>.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
