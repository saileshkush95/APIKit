import { createFileRoute } from "@tanstack/react-router";
import { LoadTestPanel } from "../features/load/LoadTestPanel";

export const Route = createFileRoute("/load")({ component: LoadTestPanel });
