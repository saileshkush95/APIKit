import { createFileRoute } from "@tanstack/react-router";
import { SyncPanel } from "../features/sync/SyncPanel";

export const Route = createFileRoute("/sync")({ component: SyncPanel });
