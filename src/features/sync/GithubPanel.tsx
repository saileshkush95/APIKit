import { Input } from "../../shared/components/Field";
import { useEffect, useState } from "react";
import {
  githubCheck,
  githubCreateRepo,
  githubGhToken,
  githubListRepos,
  githubPull,
} from "../../shared/lib/api";
import {
  buildExport,
  hydrateTree,
  parseExport,
  serializeExport,
} from "../../shared/lib/exportWorkspace";
import { countRequests } from "../../shared/lib/tree";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useConfirm } from "../../shared/state/confirm";
import { useGithubSync } from "../../shared/state/githubSync";
import { useWorkspaceId, useWorkspaces } from "../../shared/state/workspaces";
import type { GithubRepo } from "../../shared/types";

/**
 * Commits the workspace to a Git repository as one JSON document, so it can be
 * reviewed and versioned like code. Complements LAN sync rather than replacing
 * it: this is for history and remote teammates, LAN sync is for the same room.
 */
export function GithubPanel() {
  const workspaceId = useWorkspaceId();
  const { active } = useWorkspaces();
  const {
    config,
    sha,
    lastSync,
    ready,
    busy,
    status,
    error,
    load,
    setConfig,
    setStatus,
    run,
    remember,
    pushDocument,
  } = useGithubSync();
  const { tree, setTree, collectionDefaults, setCollectionDefaults } =
    useCollection();
  const {
    environments,
    collectionVariables,
    setCollectionVariables,
    create: createEnvironment,
    update: updateEnvironment,
  } = useEnvironments();

  const confirm = useConfirm();
  const workspaceName = active?.name ?? "workspace";

  // Load the persisted config/state for the workspace on entry to the panel.
  useEffect(() => {
    load(workspaceId, workspaceName);
  }, [workspaceId]);

  // The repository picker, and the create-a-repo form.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDesc, setNewRepoDesc] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const pickerRef = { current: null as HTMLDivElement | null };
  useEffect(() => {
    if (!repoMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) {
        setRepoMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [repoMenuOpen]);

  const authed = config.token.trim() !== "";

  function documentText(): string {
    return serializeExport(
      buildExport({
        workspace: active?.name ?? "Workspace",
        tree,
        environments,
        collectionVariables,
        collectionDefaults,
      }),
    );
  }

  /** Loads (or reloads) the repos the token can push to. */
  async function loadRepos() {
    setRepoMenuOpen(true);
    setRepoQuery("");
    if (repos !== null) return;
    run("repos", async () => {
      setRepos(await githubListRepos(config));
    });
  }

  const filteredRepos = repoQuery.trim()
    ? (repos ?? []).filter((repo) =>
        repo.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase()),
      )
    : repos;

  function pickRepo(repo: GithubRepo) {
    setConfig({
      ...config,
      repo: repo.fullName,
      // Keep the branch in step with the repository's default.
      branch: repo.defaultBranch || config.branch,
    });
    setRepoMenuOpen(false);
    setStatus(`Selected ${repo.fullName} (default branch ${repo.defaultBranch}).`);
  }

  async function createRepo() {
    run("create", async () => {
      const fullName = await githubCreateRepo(
        config,
        newRepoName,
        newRepoDesc,
        newRepoPrivate,
      );
      setConfig({ ...config, repo: fullName });
      setCreating(false);
      setNewRepoName("");
      setNewRepoDesc("");
      setStatus(`Created ${newRepoPrivate ? "private" : "public"} repository ${fullName}.`);
    });
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
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
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
              <div ref={pickerRef} className="relative">
                <button
                  onClick={loadRepos}
                  disabled={!authed || busy !== null}
                  className="rounded border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-brand hover:text-ink disabled:opacity-50"
                  title={
                    authed
                      ? "Pick a repository from your GitHub account"
                      : "Connect a token or the GitHub CLI first"
                  }
                >
                  {busy === "repos" ? "Loading…" : "Browse…"}
                </button>
                {repoMenuOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-md border border-edge bg-panel shadow-xl">
                    <input
                      value={repoQuery}
                      spellCheck={false}
                      autoFocus
                      placeholder="Search your repositories…"
                      onChange={(e) => setRepoQuery(e.target.value)}
                      className="w-full border-b border-edge bg-canvas px-3 py-1.5 text-[11px] text-ink outline-none focus:border-brand"
                    />
                    <div className="max-h-72 overflow-auto py-1">
                      {repos === null
                        ? (
                          <p className="px-3 py-2 text-[11px] text-muted">
                            Loading repositories…
                          </p>
                        )
                        : filteredRepos!.length === 0
                          ? (
                            <p className="px-3 py-2 text-[11px] text-muted">
                              {repoQuery.trim()
                                ? "No repositories match your search."
                                : "Nothing yet — you can create a repository below."}
                            </p>
                          )
                          : (
                            filteredRepos!.map((repo) => (
                              <button
                                key={repo.fullName}
                                type="button"
                                onClick={() => pickRepo(repo)}
                                className="block w-full px-3 py-1.5 text-left hover:bg-elevated"
                              >
                                <span className="block text-[11px] text-ink">
                                  {repo.fullName}
                                </span>
                                <span className="block text-[10px] text-muted">
                                  {repo.private ? "private" : "public"} · {repo.defaultBranch}
                                </span>
                              </button>
                            ))
                          )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setRepoMenuOpen(false);
                        setCreating(true);
                      }}
                      className="block w-full border-t border-edge px-3 py-1.5 text-left text-[11px] text-brand hover:bg-elevated"
                    >
                      + Create a repository…
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => setCreating((open) => !open)}
                disabled={!authed || busy !== null}
                className="rounded border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-brand hover:text-ink disabled:opacity-50"
              >
                Create…
              </button>
            </div>
            {creating && (
              <div className="flex flex-col gap-2 rounded border border-edge bg-canvas p-2.5">
                <Input
                  value={newRepoName}
                  spellCheck={false}
                  placeholder="New repository name (e.g. api-collection)"
                  onChange={(e) => setNewRepoName(e.target.value)}
                  className={"wrk-field font-mono"}
                />
                <Input
                  value={newRepoDesc}
                  spellCheck={false}
                  placeholder="Description (optional)"
                  onChange={(e) => setNewRepoDesc(e.target.value)}
                  className={"wrk-field"}
                />
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={newRepoPrivate}
                    onChange={(e) => setNewRepoPrivate(e.target.checked)}
                  />
                  Private repository (recommended — it will hold the collection)
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={createRepo}
                    disabled={newRepoName.trim() === "" || busy !== null}
                    className="rounded-md bg-brand px-3 py-1 text-[11px] font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
                  >
                    {busy === "create" ? "Creating…" : "Create & use"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setError(null);
                    }}
                    className="rounded px-2 py-1 text-[11px] text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted">
              Syncing workspace{" "}
              <span className="font-semibold text-ink">
                “{active?.name ?? "this workspace"}”
              </span>{" "}
              · {countRequests(tree)} request{countRequests(tree) === 1 ? "" : "s"}.
              Switch workspaces in the app to back a different one.
            </p>
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

        <div className="flex flex-col gap-2">
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

          <button
            onClick={() =>
              run("gh", async () => {
                const token = await githubGhToken();
                setConfig((prev) => ({ ...prev, token }));
                const status = await githubCheck({ ...config, token });
                setStatus(`Connected with the GitHub CLI (gh) — ${status}`);
              })
            }
            disabled={config.repo.trim() === "" || busy !== null}
            className="self-start rounded border border-brand/50 px-3 py-1.5 text-xs text-brand hover:border-brand hover:bg-brand/5 disabled:opacity-50"
          >
            {busy === "gh" ? "Connecting…" : "Connect with GitHub CLI (gh)"}
          </button>
          <p className="text-[11px] leading-relaxed text-muted">
            Rather than pasting a token, the{" "}
            <span className="font-mono">gh</span> button signs you in with the
            GitHub account you have already authenticated in the terminal —{" "}
            <span className="font-mono">gh auth login</span> — and pulls the
            credential from there, so it never has to be typed into this app.
          </p>
        </div>

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
                if (document.collectionVariables) {
                  setCollectionVariables(document.collectionVariables);
                }
                if (document.collectionDefaults) {
                  setCollectionDefaults(document.collectionDefaults);
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
                const result = await pushDocument(
                  documentText(),
                  `Update ${active?.name ?? "workspace"} from WebRequestKit`,
                );
                if (!result) return;
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
