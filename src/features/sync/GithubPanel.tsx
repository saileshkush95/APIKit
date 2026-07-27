import { Input } from "../../shared/components/Field";
import { useEffect, useState } from "react";
import {
  githubCheck,
  githubPull,
  githubPush,
  secretGet,
  secretSet,
  setSetting,
} from "../../shared/lib/api";
import {
  buildExport,
  hydrateTree,
  parseExport,
  serializeExport,
} from "../../shared/lib/exportWorkspace";
import { notifyError } from "../../shared/lib/notify";
import { workspaceDataOnce } from "../../shared/lib/storage";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useConfirm } from "../../shared/state/confirm";
import { useWorkspaceId, useWorkspaces } from "../../shared/state/workspaces";
import type { GithubConfig } from "../../shared/types";

const CONFIG_KEY = "githubConfig";
const STATE_KEY = "githubState";


interface Stored extends GithubConfig {
  autoPush: boolean;
}

function emptyConfig(workspace: string): Stored {
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

/**
 * Commits the workspace to a Git repository as one JSON document, so it can be
 * reviewed and versioned like code. Complements LAN sync rather than replacing
 * it: this is for history and remote teammates, LAN sync is for the same room.
 */
export function GithubPanel() {
  const workspaceId = useWorkspaceId();
  const { active } = useWorkspaces();
  const { tree, setTree } = useCollection();
  const { environments, create: createEnvironment, update: updateEnvironment } =
    useEnvironments();

  const [config, setConfig] = useState<Stored>(() =>
    emptyConfig(active?.name ?? "workspace"),
  );
  const [sha, setSha] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        try {
          const stored = workspace.settings[CONFIG_KEY];
          // The token is never in here — see the keychain read below.
          if (stored) setConfig({ ...(JSON.parse(stored) as Stored), token: "" });
        } catch {
          /* keep the defaults */
        }
        try {
          const state = JSON.parse(workspace.settings[STATE_KEY] ?? "{}");
          setSha(state.sha ?? null);
          setLastSync(state.lastSync ?? null);
        } catch {
          /* keep the defaults */
        }
      })
      .finally(() => !cancelled && setReady(true));

    secretGet(`github.token.${workspaceId}`)
      .then((stored) => {
        if (!cancelled && stored) {
          setConfig((prev) => ({ ...prev, token: stored }));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!ready) return;
    // Everything but the token; that goes to the keychain.
    const { token, ...rest } = config;
    setSetting(workspaceId, CONFIG_KEY, JSON.stringify(rest)).catch((e) =>
      notifyError("Could not save the GitHub settings", e),
    );
    secretSet(`github.token.${workspaceId}`, token).catch((e) =>
      notifyError("Could not store the GitHub token in the keychain", e),
    );
  }, [config, ready, workspaceId]);

  function remember(nextSha: string | null) {
    setSha(nextSha);
    const stamp = new Date().toISOString();
    setLastSync(stamp);
    setSetting(
      workspaceId,
      STATE_KEY,
      JSON.stringify({ sha: nextSha, lastSync: stamp }),
    ).catch(() => {});
  }

  function documentText(): string {
    return serializeExport(
      buildExport({
        workspace: active?.name ?? "Workspace",
        tree,
        environments,
      }),
    );
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const configured = config.repo.trim() !== "" && config.token.trim() !== "";

  return (
    <section className="rounded-lg border border-edge bg-panel">
      <div className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
        <h2 className="text-sm font-semibold">GitHub</h2>
        <span className="text-xs text-muted">
          Version the collection in a repository
        </span>
        {lastSync && (
          <span className="ml-auto text-[11px] text-muted">
            Last synced {new Date(lastSync).toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Repository
            <Input
              value={config.repo}
              spellCheck={false}
              placeholder="owner/repo"
              onChange={(e) => setConfig({ ...config, repo: e.target.value })}
              className={"wrk-field w-48 font-mono"}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Branch
            <Input
              value={config.branch}
              spellCheck={false}
              onChange={(e) => setConfig({ ...config, branch: e.target.value })}
              className={"wrk-field w-28 font-mono"}
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
            Path
            <Input
              value={config.path}
              spellCheck={false}
              onChange={(e) => setConfig({ ...config, path: e.target.value })}
              className={"wrk-field min-w-0 flex-1 font-mono"}
            />
          </label>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          Personal access token
          <Input
            value={config.token}
            type="password"
            spellCheck={false}
            placeholder="ghp_… (needs repo scope, stored in your keychain)"
            onChange={(e) => setConfig({ ...config, token: e.target.value })}
            className={"wrk-field min-w-0 flex-1 font-mono"}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              run("check", async () => {
                setStatus(await githubCheck(config));
              })
            }
            disabled={!configured || busy !== null}
            className="rounded border border-edge px-3 py-1.5 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
          >
            {busy === "check" ? "Checking…" : "Check access"}
          </button>

          <button
            onClick={() =>
              run("pull", async () => {
                const file = await githubPull(config);
                if (!file.exists) {
                  setStatus("Nothing in the repository yet — push first.");
                  return;
                }
                const document = parseExport(file.content);
                const ok = await confirm({
                  title: "Replace the local collection?",
                  body: `Pull replaces this workspace's ${tree.length} top-level item${
                    tree.length === 1 ? "" : "s"
                  } with the ${document.tree.length} in ${config.repo}.`,
                  warning:
                    "Local changes that were never pushed are lost. Push first if you want to keep them.",
                  confirmLabel: "Replace",
                  danger: true,
                });
                if (!ok) return;

                // The repository is the source of truth once you confirm.
                setTree(hydrateTree(document.tree));
                for (const environment of document.environments) {
                  const existing = environments.find(
                    (candidate) => candidate.name === environment.name,
                  );
                  if (existing) {
                    updateEnvironment(existing.id, {
                      variables: environment.variables,
                    });
                  } else {
                    const created = createEnvironment(environment.name);
                    updateEnvironment(created.id, {
                      variables: environment.variables,
                    });
                  }
                }
                remember(file.sha);
                setStatus(
                  `Pulled ${document.tree.length} top-level item(s) from ${config.repo}.`,
                );
              })
            }
            disabled={!configured || busy !== null}
            className="rounded border border-edge px-3 py-1.5 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50"
          >
            {busy === "pull" ? "Pulling…" : "Pull"}
          </button>

          <button
            onClick={() =>
              run("push", async () => {
                const result = await githubPush(
                  config,
                  documentText(),
                  sha,
                  `Update ${active?.name ?? "workspace"} from WebRequestKit`,
                );
                remember(result.sha);
                setStatus(
                  result.commitUrl
                    ? `Committed — ${result.commitUrl}`
                    : "Committed.",
                );
              })
            }
            disabled={!configured || busy !== null}
            className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
          >
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
        </div>

        {status && (
          <div className="rounded border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok">
            {status}
          </div>
        )}
        {error && (
          <div className="rounded border border-err bg-err/10 px-3 py-2 text-xs text-err">
            {error}
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-muted">
          Push commits the collection and environments as one JSON file. If the
          file changed on GitHub since your last pull, the push is rejected
          rather than overwriting it — pull, then push again.
        </p>
        <p className="text-[11px] leading-relaxed text-warn">
          Environment values are committed as-is. Keep secrets in variables you
          leave empty in the repository, or use a private repo.
        </p>
      </div>
    </section>
  );
}
