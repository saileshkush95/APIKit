import { createFileRoute } from "@tanstack/react-router";
import { RunnerPanel } from "../features/runner/RunnerPanel";

export interface RunnerSearch {
  /** Folder to run; absent means the whole collection. */
  folder?: string;
}

export const Route = createFileRoute("/runner")({
  validateSearch: (search: Record<string, unknown>): RunnerSearch => ({
    folder: typeof search.folder === "string" ? search.folder : undefined,
  }),
  component: RunnerPage,
});

function RunnerPage() {
  const { folder } = Route.useSearch();
  return <RunnerPanel initialTarget={folder ?? null} />;
}
