import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Database, GitBranch, ScrollText, Settings2, SlidersHorizontal, Tags, Users } from "lucide-react";
import { whoamiQuery } from "~/routes/__root.tsx";
import { PageHeader } from "~/components/ui.tsx";

export const Route = createFileRoute("/app/admin")({
  beforeLoad: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(whoamiQuery);
    if (!auth || (auth.role !== "owner" && auth.role !== "admin")) throw redirect({ to: "/app" });
  },
  component: AdminLayout,
});

const TABS = [
  { to: "/app/admin", label: "Workspace", icon: Settings2, exact: true },
  { to: "/app/admin/pipelines", label: "Pipelines", icon: GitBranch },
  { to: "/app/admin/fields", label: "Custom fields", icon: SlidersHorizontal },
  { to: "/app/admin/tags", label: "Tags", icon: Tags },
  { to: "/app/admin/users", label: "Users", icon: Users },
  { to: "/app/admin/audit", label: "Audit log", icon: ScrollText },
  { to: "/app/admin/data", label: "Data", icon: Database },
] as const;

function AdminLayout() {
  return (
    <div>
      <PageHeader title="Admin" subtitle="Workspace configuration, team, and data tooling." />
      <div className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            activeOptions={{ exact: "exact" in t && t.exact }}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            activeProps={{ className: "bg-accent text-accent-foreground" }}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </Link>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
