import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/admin/agents")({
  beforeLoad: () => {
    throw redirect({ to: "/app/agents" });
  },
});
