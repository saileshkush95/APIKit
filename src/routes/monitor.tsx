import { createFileRoute } from "@tanstack/react-router";
import { MonitorPanel } from "../features/monitor/MonitorPanel";

export const Route = createFileRoute("/monitor")({ component: MonitorPanel });
