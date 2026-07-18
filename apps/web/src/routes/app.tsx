import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    if (!auth) throw redirect({ to: "/login" });
    return { auth };
  },
  component: AppLayout,
});

function AppLayout() {
  const { auth: loadedAuth } = Route.useRouteContext();
  const auth = useQuery(whoamiQuery).data ?? loadedAuth;
  // Hosted access gate: a locked workspace renders only the notice — no
  // sidebar, no routes, no CRM data (the server refuses operations anyway).
  if (auth?.access?.mode === "locked") return <WorkspaceLocked />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function WorkspaceLocked() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">
        This workspace is locked
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Access is currently paused by your hosting provider. Your CRM data is
        safe and unchanged, and everything will be right where you left it once
        access is restored.
      </p>
      <a
        href="/account"
        className="mt-2 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85"
      >
        Manage your account
      </a>
    </main>
  );
}
