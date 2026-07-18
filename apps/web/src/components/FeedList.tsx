/** Pure timeline list used by ActivityFeed (record pages) and the Activity page. */
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Bot,
  CalendarClock,
  CheckSquare,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Phone,
  StickyNote,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Activity, User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { daysUntil, formatDateTime, relativeTime } from "~/lib/format.ts";
import { chipClass } from "~/lib/colors.ts";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export const ACTIVITY_KIND_ICON: Record<string, ReactNode> = {
  note: <StickyNote className="size-3.5" />,
  call: <Phone className="size-3.5" />,
  email: <Mail className="size-3.5" />,
  meeting: <Users className="size-3.5" />,
  task: <CheckSquare className="size-3.5" />,
  status_change: <ArrowRightLeft className="size-3.5" />,
  agent_action: <Bot className="size-3.5" />,
  default: <MessageSquare className="size-3.5" />,
};

export function FeedList({
  items,
  showLinks = false,
}: {
  items: Activity[];
  showLinks?: boolean;
}) {
  const users = useQuery(opQuery<User[]>("user.list"));
  const userName = (id: string | null) =>
    id ? (users.data?.find((u) => u.id === id)?.name ?? null) : null;

  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No activity yet.
      </p>
    );
  }
  return (
    <ol className="relative space-y-3 before:absolute before:inset-y-2 before:left-[13px] before:w-px before:bg-border">
      {items.map((a) => (
        <FeedRow
          key={a.id}
          activity={a}
          actorName={userName(a.actorUserId)}
          showLinks={showLinks}
        />
      ))}
    </ol>
  );
}

function FeedRow({
  activity: a,
  actorName,
  showLinks,
}: {
  activity: Activity;
  actorName: string | null;
  showLinks: boolean;
}) {
  const complete = useOp("task.complete");
  const reopen = useOp("task.reopen");
  const del = useOp("activity.delete", { successToast: "Activity deleted" });
  const isTask = a.kind === "task";
  const done = isTask && a.completedAt != null;
  const due = isTask ? daysUntil(a.dueAt) : null;
  const system = a.kind === "status_change" || a.kind === "agent_action";

  const links = showLinks
    ? ([
        a.engagementId
          ? { to: "/app/leads/$id" as const, id: a.engagementId, label: "lead" }
          : null,
        a.dealId
          ? { to: "/app/deals/$id" as const, id: a.dealId, label: "deal" }
          : null,
        a.companyId
          ? {
              to: "/app/companies/$id" as const,
              id: a.companyId,
              label: "company",
            }
          : null,
        a.personId
          ? { to: "/app/people/$id" as const, id: a.personId, label: "person" }
          : null,
      ].filter(Boolean) as Array<{
        to:
          | "/app/leads/$id"
          | "/app/deals/$id"
          | "/app/companies/$id"
          | "/app/people/$id";
        id: string;
        label: string;
      }>)
    : [];

  return (
    <li className="relative flex gap-3 pl-0">
      <span
        className={`z-[1] mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border ${
          a.actorType === "agent"
            ? "bg-violet/12 text-violet"
            : system
              ? "bg-muted text-muted-foreground/70"
              : "bg-muted text-muted-foreground"
        }`}
        title={a.kind}
      >
        {ACTIVITY_KIND_ICON[a.kind] ?? ACTIVITY_KIND_ICON.default}
      </span>
      <div className="min-w-0 flex-1 rounded-xl border border-border/70 bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70 capitalize">
            {a.kind.replace("_", " ")}
          </span>
          {a.actorType === "agent" ? (
            <span className={chipClass("secondary", "xs")}>agent</span>
          ) : null}
          {actorName ? <span>{actorName}</span> : null}
          <span title={formatDateTime(a.createdAt)}>
            {relativeTime(a.createdAt)}
          </span>
          {isTask && a.dueAt ? (
            <span
              className={chipClass(
                done ? "ghost" : due != null && due < 0 ? "error" : "ghost",
                "xs",
              )}
            >
              <CalendarClock className="size-2.5" /> {a.dueAt.slice(0, 10)}
            </span>
          ) : null}
          {links.map((l) => (
            <Link
              key={l.label + l.id}
              to={l.to}
              params={{ id: l.id }}
              className={`${chipClass("ghost", "xs")} hover:text-foreground`}
            >
              {l.label}
            </Link>
          ))}
          <span className="grow" />
          {!system ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-40 hover:opacity-100"
                    aria-label="Activity actions"
                  />
                }
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => del.mutate({ id: a.id })}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="mt-1 flex items-start gap-2">
          {isTask ? (
            <Checkbox
              className="mt-0.5"
              checked={done}
              onCheckedChange={() =>
                done
                  ? reopen.mutate({ id: a.id })
                  : complete.mutate({ id: a.id })
              }
              aria-label="Toggle task"
            />
          ) : null}
          <div className="min-w-0">
            {a.title ? (
              <p
                className={`text-sm font-medium ${done ? "line-through opacity-50" : ""}`}
              >
                {a.title}
              </p>
            ) : null}
            {a.body ? (
              <p className="text-sm break-words whitespace-pre-wrap text-foreground/70">
                {a.body}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
