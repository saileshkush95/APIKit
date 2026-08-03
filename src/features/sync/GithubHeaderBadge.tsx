import { useEffect, useRef, useState } from "react";
import { githubPull } from "../../shared/lib/api";
import {
  buildExport,
  hydrateTree,
  parseExport,
  serializeExport,
} from "../../shared/lib/exportWorkspace";
import { useCollection } from "../../shared/state/collection";
import { useEnvironments } from "../../shared/state/environments";
import { useGithubSync } from "../../shared/state/githubSync";
import { useConfirm } from "../../shared/state/confirm";
import { useWorkspaceId, useWorkspaces } from "../../shared/state/workspaces";

/**
 * Compact GitHub status for the title bar: a dot showing the workspace is
 * versioned, with a quick Push/Pull menu. Reads the same store as the sync
 * panel, so it stays in step with saves made there.
 */
export function GithubHeaderBadge() {
  const workspaceId = useWorkspaceId();
  const { active } = useWorkspaces();
  const {
    config,
    lastSync,
    busy,
    status,
    error,
    load,
    remember,
    setStatus,
    run,
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

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    load(workspaceId, active?.name ?? "workspace");
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const configured = config.repo.trim() !== "" && config.token.trim() !== "";
  if (!configured) return null;

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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`GitHub sync — ${config.repo}`}
        className="flex h-7 items-center gap-1.5 rounded-md border border-edge px-2 text-xs text-muted hover:bg-elevated hover:text-ink"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            busy ? "animate-pulse bg-warn" : "bg-ok"
          }`}
        />
        <span className="max-w-24 truncate font-mono">{config.repo}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-edge bg-panel shadow-xl">
          <div className="border-b border-edge px-3 py-2">
            <div className="text-[11px] font-semibold text-ink">
              {config.repo}
            </div>
            <div className="text-[10px] text-muted">
              {busy
                ? "Working…"
                : lastSync
                  ? `Last synced ${new Date(lastSync).toLocaleString()}`
                  : "Not pushed yet"}
            </div>
          </div>

          <div className="flex items-center gap-2 px-3 py-2.5">
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
              disabled={busy !== null}
              className="flex-1 rounded border border-edge px-3 py-1 text-[11px] text-muted hover:border-brand hover:text-ink disabled:opacity-50"
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
              disabled={busy !== null}
              className="flex-1 rounded-md bg-brand px-3 py-1 text-[11px] font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
            >
              {busy === "push" ? "Pushing…" : "Push"}
            </button>
          </div>

          {status && (
            <div className="border-t border-edge px-3 py-1.5 text-[10px] text-ok">
              {status}
            </div>
          )}
          {error && (
            <div className="border-t border-edge px-3 py-1.5 text-[10px] text-err">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
