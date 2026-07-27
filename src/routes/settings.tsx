import { createFileRoute } from "@tanstack/react-router";
import { SettingsPanel } from "../features/settings/SettingsPanel";

export const Route = createFileRoute("/settings")({ component: SettingsPanel });
