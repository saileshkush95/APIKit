import { createFileRoute } from "@tanstack/react-router";
import { MockPanel } from "../features/mock/MockPanel";

export const Route = createFileRoute("/mock")({ component: MockPanel });
