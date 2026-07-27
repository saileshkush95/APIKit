import { createFileRoute } from "@tanstack/react-router";
import { ProxyPanel } from "../features/proxy/ProxyPanel";

export const Route = createFileRoute("/proxy")({ component: ProxyPanel });
