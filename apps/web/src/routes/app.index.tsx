import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
  CalendarClock,
  Layers,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type {
  ContactListWithCounts,
  HomeStats,
  SemanticColor,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { formatMoneyMinor, relativeTime, truncate } from "~/lib/format.ts";
import { SectionCard, Spinner } from "~/components/ui.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";

export const Route = createFileRoute("/app/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(opQuery<HomeStats>("stats.home"));
  },
  component: HomePage,
});

interface FunnelStats {
  pipeline: { id: string; name: string };
  stages: Array<{
    stageId: string;
    stageName: string;
    color: SemanticColor;
    count: number;
  }>;
}

interface DealStats {
  pipeline: { id: string; name: string };
  stages: Array<{
    stageId: string;
    stageName: string;
    color: SemanticColor;
    outcome: string | null;
    count: number;
    amountMinorByCurrency: Record<string, number>;
    weightedMinorByCurrency: Record<string, number>;
  }>;
}

function HomePage() {
  const auth = useQuery(whoamiQuery).data;
  const stats = useQuery(opQuery<HomeStats>("stats.home"));
  const funnel = useQuery(opQuery<FunnelStats>("stats.engagements"));
  const dealStats = useQuery(opQuery<DealStats>("stats.deals"));
  const lists = useQuery(opQuery<ContactListWithCounts[]>("list.list"));

  if (stats.isLoading) return <Spinner label="Loading dashboard…" />;
  const s = stats.data;
  if (!s) return null;

  const attention = [...s.overdueTasks, ...s.todayTasks];
  const firstName = auth?.user.name.split(" ")[0] ?? "there";
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {greeting}, {firstName}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Here's what needs your attention.
          </p>
        </div>
        {s.pendingApprovals > 0 ? (
          <Link
            to="/app/approvals"
            className="inline-flex h-7 items-center gap-2 rounded-lg bg-warning/15 px-2.5 text-sm font-medium text-warning transition-colors hover:bg-warning/25"
          >
            <ShieldCheck className="size-4" />
            {s.pendingApprovals} approval{s.pendingApprovals === 1 ? "" : "s"}{" "}
            waiting
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Leads" value={s.counts.engagements} to="/app/leads" />
        <StatCard
          label="Companies"
          value={s.counts.companies}
          to="/app/companies"
        />
        <StatCard label="People" value={s.counts.people} to="/app/people" />
        <StatCard
          label="Open deals"
          value={s.counts.openDeals}
          to="/app/deals"
          sub={Object.entries(s.openDealValueByCurrency)
            .map(([ccy, minor]) => formatMoneyMinor(minor, ccy))
            .join(" + ")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <span className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5" /> Tasks due
            </span>
          }
          actions={
            <Link
              to="/app/tasks"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              all tasks <ArrowRight className="inline size-3" />
            </Link>
          }
        >
          {attention.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nothing due. Clean slate.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {attention.slice(0, 8).map((t) => (
                <TaskRow
                  key={t.id}
                  id={t.id}
                  title={t.title ?? "Untitled task"}
                  dueAt={t.dueAt}
                  overdue={s.overdueTasks.some((o) => o.id === t.id)}
                />
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" /> Going stale
            </span>
          }
        >
          {s.staleEngagements.count === 0 && s.staleDeals.count === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Everything has recent activity.
            </p>
          ) : (
            <div className="space-y-3">
              {s.staleEngagements.count > 0 ? (
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">
                    {s.staleEngagements.count} lead
                    {s.staleEngagements.count === 1 ? "" : "s"} without recent
                    touch
                  </p>
                  <ul className="space-y-1">
                    {s.staleEngagements.sample.slice(0, 4).map((e) => (
                      <li key={e.id}>
                        <Link
                          to="/app/leads/$id"
                          params={{ id: e.id }}
                          className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/60"
                        >
                          <span className="truncate">{e.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground/70">
                            {relativeTime(e.lastActivityAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {s.staleDeals.count > 0 ? (
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">
                    {s.staleDeals.count} open deal
                    {s.staleDeals.count === 1 ? "" : "s"} going cold
                  </p>
                  <ul className="space-y-1">
                    {s.staleDeals.sample.slice(0, 4).map((d) => (
                      <li key={d.id}>
                        <Link
                          to="/app/deals/$id"
                          params={{ id: d.id }}
                          className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/60"
                        >
                          <span className="truncate">{d.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground/70">
                            {formatMoneyMinor(d.amountMinor, d.currency)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Lead funnel"
          actions={
            funnel.data ? (
              <span className="text-xs text-muted-foreground/70">
                {funnel.data.pipeline.name}
              </span>
            ) : null
          }
        >
          {funnel.data ? <Funnel stages={funnel.data.stages} /> : <Spinner />}
        </SectionCard>

        <SectionCard
          title="Deal pipeline"
          actions={
            dealStats.data ? (
              <span className="text-xs text-muted-foreground/70">
                {dealStats.data.pipeline.name}
              </span>
            ) : null
          }
        >
          {dealStats.data ? (
            <DealBoardMini stages={dealStats.data.stages} />
          ) : (
            <Spinner />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title={
          <span className="flex items-center gap-1.5">
            <Layers className="size-3.5" /> Contact lists
          </span>
        }
        actions={
          <Link
            to="/app/lists"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            all lists <ArrowRight className="inline size-3" />
          </Link>
        }
      >
        {!lists.data || lists.data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No lists yet. Lists split your contacts into audiences — job search,
            product prospects, client work.{" "}
            <Link to="/app/lists" className="text-foreground underline">
              Create one
            </Link>{" "}
            or ask your agent to organize contacts for you.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {lists.data.map((l) => (
              <Link
                key={l.id}
                to="/app/lists/$id"
                params={{ id: l.id }}
                className="block rounded-xl border border-border/70 p-3 transition-colors hover:border-foreground/20"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`size-2 shrink-0 rounded-full ${dotClass(l.color)}`}
                  />
                  <p className="truncate text-sm font-medium">{l.name}</p>
                </div>
                {l.description ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                    {l.description}
                  </p>
                ) : null}
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UsersRound className="size-3" />
                    <span className="tnum font-mono">{l.people}</span> people
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="size-3" />
                    <span className="tnum font-mono">{l.companies}</span>{" "}
                    companies
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-1.5">
            <Bot className="size-3.5" /> Recent agent activity
          </span>
        }
      >
        {s.recentAgentEvents.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No agent actions yet.{" "}
            <Link to="/app/agents" className="text-foreground underline">
              Connect an agent
            </Link>{" "}
            via MCP.
          </p>
        ) : (
          <ul className="space-y-1">
            {s.recentAgentEvents.map((ev) => (
              <li
                key={ev.id}
                className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-sm"
              >
                <span
                  className={`${chipClass("secondary", "xs")} shrink-0 font-mono`}
                >
                  {ev.operation}
                </span>
                <span className="min-w-0 truncate text-foreground/70">
                  {truncate(ev.summary, 90)}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
                  {relativeTime(ev.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  to,
}: {
  label: string;
  value: number;
  sub?: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tnum mt-1 font-mono text-2xl font-semibold tracking-tight group-hover:text-primary">
        {value}
      </p>
      {sub ? (
        <p className="tnum mt-0.5 truncate text-xs text-muted-foreground/80">
          {sub}
        </p>
      ) : null}
    </Link>
  );
}

function TaskRow({
  id,
  title,
  dueAt,
  overdue,
}: {
  id: string;
  title: string;
  dueAt: string | null;
  overdue: boolean;
}) {
  const complete = useOp("task.complete", { successToast: "Task done" });
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-accent/50">
      <Checkbox
        checked={false}
        onCheckedChange={() => complete.mutate({ id })}
        aria-label="Complete task"
      />
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {dueAt ? (
        <span
          className={`shrink-0 ${chipClass(overdue ? "error" : "ghost", "xs")}`}
        >
          {dueAt.slice(0, 10)}
        </span>
      ) : null}
    </li>
  );
}

function Funnel({ stages }: { stages: FunnelStats["stages"] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <div className="space-y-1.5">
      {stages.map((s) => (
        <Link
          key={s.stageId}
          to="/app/leads"
          search={{ stageId: s.stageId }}
          className="group flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-accent/50"
        >
          <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
            {s.stageName}
          </span>
          <span className="relative h-4 flex-1 overflow-hidden rounded-sm bg-muted">
            <span
              className={`absolute inset-y-0 left-0 rounded-sm ${dotClass(s.color)} opacity-70 transition-all group-hover:opacity-100`}
              style={{ width: `${Math.max(2, (s.count / max) * 100)}%` }}
            />
          </span>
          <span className="tnum w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">
            {s.count}
          </span>
        </Link>
      ))}
    </div>
  );
}

function DealBoardMini({ stages }: { stages: DealStats["stages"] }) {
  const open = stages.filter((s) => !s.outcome);
  return (
    <div className="space-y-1.5">
      {open.map((s) => {
        const amounts = Object.entries(s.amountMinorByCurrency)
          .map(([ccy, minor]) => formatMoneyMinor(minor, ccy))
          .join(" + ");
        return (
          <Link
            key={s.stageId}
            to="/app/deals"
            search={{ stageId: s.stageId }}
            className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/50"
          >
            <span
              className={`size-2 shrink-0 rounded-full ${dotClass(s.color)}`}
            />
            <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">
              {s.stageName}
            </span>
            <span className="tnum font-mono text-xs text-foreground/70">
              {s.count}
            </span>
            <span className="tnum ml-auto truncate font-mono text-xs text-muted-foreground/80">
              {amounts || "—"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
