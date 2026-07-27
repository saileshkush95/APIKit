import { createFileRoute } from "@tanstack/react-router";
import { ApiClient } from "../features/client/ApiClient";

/** The welcome screen asks the client to do something on arrival. */
export interface ClientSearch {
  intent?: "new" | "import";
  /** Changes each time, so the same intent can be requested twice. */
  at?: number;
}

export const Route = createFileRoute("/client")({
  validateSearch: (search: Record<string, unknown>): ClientSearch => ({
    intent:
      search.intent === "new" || search.intent === "import"
        ? search.intent
        : undefined,
    at: typeof search.at === "number" ? search.at : undefined,
  }),
  component: ClientPage,
});

function ClientPage() {
  const { intent, at } = Route.useSearch();
  return <ApiClient intent={intent ? { kind: intent, at: at ?? 0 } : null} />;
}
