import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    if (!auth) throw redirect({ to: "/login" });
    return { auth };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
