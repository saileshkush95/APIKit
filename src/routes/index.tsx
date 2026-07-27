import { createFileRoute, redirect } from "@tanstack/react-router";

/** The shell always opens on the client. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/client" });
  },
});
