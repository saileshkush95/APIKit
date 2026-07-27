import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { isFolder } from "../lib/tree";
import { methodColor } from "../lib/ui";
import { useCollectionStore } from "../state/collection";
import { useEnvironmentsStore } from "../state/environments";
import { useHandoff } from "../state/handoff";
import { useWorkspacesStore } from "../state/workspaces";
import type { TreeNode } from "../types";

interface Command {
  id: string;
  /** What is matched and shown. */
  label: string;
  /** Folder path, environment name — context that disambiguates the label. */
  detail?: string;
  group: string;
  /** Rendered before the label; the HTTP method, for requests. */
  badge?: string;
  badgeClass?: string;
  run: () => void;
}

const ROUTES: { to: string; label: string }[] = [
  { to: "/client", label: "API client" },
  { to: "/proxy", label: "Proxy" },
  { to: "/mock", label: "Mock server" },
  { to: "/runner", label: "Collection runner" },
  { to: "/load", label: "Load testing" },
  { to: "/monitor", label: "Monitors" },
  { to: "/sync", label: "Sync" },
  { to: "/settings", label: "Settings" },
];

/**
 * Subsequence match, the behaviour every command palette has: "clrun" finds
 * "Collection runner". Returns a score so tighter matches sort first — a
 * plain `includes` would rank a stray match in a long path above an exact one.
 */
function score(text: string, query: string): number | null {
  if (query === "") return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const exact = haystack.indexOf(needle);
  if (exact !== -1) return exact === 0 ? 1000 : 500 - exact;

  let at = 0;
  let gaps = 0;
  let previous = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return null;
    if (previous !== -1) gaps += found - previous - 1;
    previous = found;
    at = found + 1;
  }
  return 100 - Math.min(gaps, 99);
}

/** Every request in the tree, with the folder path that leads to it. */
function flattenRequests(
  nodes: TreeNode[],
  trail: string[] = [],
): { id: string; name: string; method: string; url: string; path: string }[] {
  return nodes.flatMap((node) =>
    isFolder(node)
      ? flattenRequests(node.children, [...trail, node.name])
      : [
          {
            id: node.id,
            name: node.name,
            method: node.method,
            url: node.url,
            path: trail.join(" / "),
          },
        ],
  );
}

/**
 * ⌘K: jump to any request, view, environment or workspace.
 *
 * Mounted once at the root so it works from every route. Commands that belong
 * to the client (opening a request) go through the handoff store rather than
 * reaching into it, which is what makes them work from the proxy or monitors.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();

  const tree = useCollectionStore((s) => s.tree);
  const environments = useEnvironmentsStore((s) => s.environments);
  const selectEnvironment = useEnvironmentsStore((s) => s.setActiveId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectWorkspace = useWorkspacesStore((s) => s.switchTo);
  const hand = useHandoff((s) => s.hand);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setHighlighted(0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const route of ROUTES) {
      list.push({
        id: `go:${route.to}`,
        label: route.label,
        group: "Go to",
        run: () => navigate({ to: route.to }),
      });
    }

    list.push(
      {
        id: "action:new",
        label: "New request",
        group: "Actions",
        run: () =>
          navigate({
            to: "/client",
            search: { intent: "new", at: Date.now() },
          }),
      },
      {
        id: "action:import",
        label: "Import a collection",
        group: "Actions",
        run: () =>
          navigate({
            to: "/client",
            search: { intent: "import", at: Date.now() },
          }),
      },
    );

    for (const request of flattenRequests(tree)) {
      list.push({
        id: `request:${request.id}`,
        label: request.name,
        detail: request.path || request.url,
        group: "Requests",
        badge: request.method.toUpperCase(),
        badgeClass: methodColor(request.method),
        run: () => {
          hand({ kind: "saved", requestId: request.id });
          navigate({ to: "/client" });
        },
      });
    }

    for (const environment of environments) {
      list.push({
        id: `env:${environment.id}`,
        label: environment.name,
        detail: `${environment.variables.length} variable${
          environment.variables.length === 1 ? "" : "s"
        }`,
        group: "Environments",
        run: () => selectEnvironment(environment.id),
      });
    }

    for (const workspace of workspaces) {
      list.push({
        id: `ws:${workspace.id}`,
        label: workspace.name,
        group: "Workspaces",
        run: () => selectWorkspace(workspace.id),
      });
    }

    return list;
  }, [
    tree,
    environments,
    workspaces,
    navigate,
    hand,
    selectEnvironment,
    selectWorkspace,
  ]);

  const matches = useMemo(() => {
    const needle = query.trim();
    const scored = commands
      .map((command) => ({
        command,
        rank: score(`${command.label} ${command.detail ?? ""}`, needle),
      }))
      .filter((entry): entry is { command: Command; rank: number } =>
        entry.rank !== null,
      );

    // Ranked, but kept grouped: a group sorts by its best hit, and its members
    // by their own. Sorting purely by rank would interleave groups and repeat
    // their headings all the way down the list.
    const best = new Map<string, number>();
    for (const { command, rank } of scored) {
      best.set(command.group, Math.max(best.get(command.group) ?? -1, rank));
    }

    return scored
      .sort(
        (a, b) =>
          (best.get(b.command.group) ?? 0) - (best.get(a.command.group) ?? 0) ||
          b.rank - a.rank,
      )
      .slice(0, 40)
      .map((entry) => entry.command);
  }, [commands, query]);

  // Keep the highlight on-screen as the arrow keys walk past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  if (!open) return null;

  function choose(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    command.run();
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="Search requests, views and settings…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlighted(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (matches.length === 0) return;
              const step = e.key === "ArrowDown" ? 1 : -1;
              setHighlighted(
                (current) =>
                  (current + step + matches.length) % matches.length,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(matches[highlighted]);
            }
          }}
          className="flex-none border-b border-edge bg-transparent px-4 py-3 text-sm text-ink outline-none"
        />

        <ul ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {matches.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted">
              Nothing matches “{query}”.
            </li>
          )}
          {matches.map((command, index) => {
            const newGroup =
              index === 0 || matches[index - 1].group !== command.group;
            return (
              <li key={command.id}>
                {newGroup && (
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                    {command.group}
                  </div>
                )}
                <button
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => choose(command)}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs ${
                    index === highlighted ? "bg-elevated" : ""
                  }`}
                >
                  {command.badge && (
                    <span
                      className={`w-10 flex-none font-mono text-[10px] font-bold ${
                        command.badgeClass ?? ""
                      }`}
                    >
                      {command.badge}
                    </span>
                  )}
                  <span className="flex-none truncate text-ink">
                    {command.label}
                  </span>
                  {command.detail && (
                    <span className="min-w-0 flex-1 truncate text-right text-muted">
                      {command.detail}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-none items-center gap-3 border-t border-edge px-4 py-1.5 text-[10px] text-muted">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
