import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarClock, Plus } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import type { Activity, Page, User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { daysUntil, formatDateTime, relativeTime } from "~/lib/format.ts";
import { OwnerSelect } from "~/components/pickers.tsx";
import { EmptyState, PageHeader, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";

const searchSchema = z.object({
  show: z.enum(["open", "done", "all"]).catch("open"),
  assigneeUserId: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/app/tasks")({
  validateSearch: searchSchema,
  component: TasksPage,
});

function TasksPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);

  const tasks = useQuery(
    opQuery<Page<Activity>>("activity.list", {
      kind: "task",
      open: search.show === "open" ? true : undefined,
      assigneeUserId: search.assigneeUserId,
      limit: 200,
      offset: 0,
    }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const createTask = useOp("task.create", {
    successToast: "Task created",
    onSuccess: () => {
      setTitle("");
      setDueAt("");
    },
  });

  const patch = (p: Partial<z.infer<typeof searchSchema>>) =>
    navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });

  const items = (tasks.data?.items ?? []).filter((t) =>
    search.show === "done" ? t.completedAt : true,
  );
  const overdue = items.filter(
    (t) =>
      !t.completedAt && daysUntil(t.dueAt) != null && daysUntil(t.dueAt)! < 0,
  );
  const today = items.filter((t) => !t.completedAt && daysUntil(t.dueAt) === 0);
  const upcoming = items.filter(
    (t) =>
      !t.completedAt && (daysUntil(t.dueAt) == null || daysUntil(t.dueAt)! > 0),
  );
  const done = items.filter((t) => t.completedAt);

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle={
          tasks.data
            ? `${tasks.data.items.filter((t) => !t.completedAt).length} open`
            : "…"
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <Input
          className="min-w-48 flex-1"
          placeholder="Add a task… (press Enter)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim()) {
              createTask.mutate({
                title: title.trim(),
                dueAt: dueAt || undefined,
                assigneeUserId: assignee ?? undefined,
              });
            }
          }}
        />
        <Input
          type="date"
          className="w-40"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />
        <div className="w-44">
          <OwnerSelect value={assignee} onChange={setAssignee} />
        </div>
        <Button
          size="sm"
          disabled={!title.trim() || createTask.isPending}
          onClick={() =>
            createTask.mutate({
              title: title.trim(),
              dueAt: dueAt || undefined,
              assigneeUserId: assignee ?? undefined,
            })
          }
        >
          <Plus className="size-4" /> Add
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {(["open", "done", "all"] as const).map((s) => (
            <Button
              key={s}
              variant={search.show === s ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => patch({ show: s })}
            >
              {s}
            </Button>
          ))}
        </div>
        <Select
          className="w-auto"
          value={search.assigneeUserId ?? ""}
          onChange={(e) =>
            patch({ assigneeUserId: e.target.value || undefined })
          }
        >
          <option value="">Any assignee</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </div>

      {tasks.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No tasks"
          hint="Add one above, or ask your agent to create follow-ups."
        />
      ) : (
        <div className="space-y-5">
          {search.show !== "done" ? (
            <>
              <TaskGroup
                label={`Overdue (${overdue.length})`}
                tone="error"
                tasks={overdue}
                users={users.data ?? []}
              />
              <TaskGroup
                label={`Today (${today.length})`}
                tone="warning"
                tasks={today}
                users={users.data ?? []}
              />
              <TaskGroup
                label={`Upcoming (${upcoming.length})`}
                tasks={upcoming}
                users={users.data ?? []}
              />
            </>
          ) : null}
          {search.show !== "open" ? (
            <TaskGroup
              label={`Done (${done.length})`}
              tasks={done}
              users={users.data ?? []}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskGroup({
  label,
  tasks,
  users,
  tone,
}: {
  label: string;
  tasks: Activity[];
  users: User[];
  tone?: "error" | "warning";
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h2
        className={`mb-1.5 text-xs font-semibold tracking-wider uppercase ${
          tone === "error"
            ? "text-destructive"
            : tone === "warning"
              ? "text-warning"
              : "text-muted-foreground"
        }`}
      >
        {label}
      </h2>
      <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border bg-card">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} users={users} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({ task: t, users }: { task: Activity; users: User[] }) {
  const complete = useOp("task.complete");
  const reopenTask = useOp("task.reopen");
  const done = t.completedAt != null;
  const assignee = users.find((u) => u.id === t.assigneeUserId);
  const link = t.engagementId
    ? {
        to: "/app/leads/$id" as const,
        params: { id: t.engagementId },
        label: "lead",
      }
    : t.dealId
      ? {
          to: "/app/deals/$id" as const,
          params: { id: t.dealId },
          label: "deal",
        }
      : t.companyId
        ? {
            to: "/app/companies/$id" as const,
            params: { id: t.companyId },
            label: "company",
          }
        : t.personId
          ? {
              to: "/app/people/$id" as const,
              params: { id: t.personId },
              label: "person",
            }
          : null;

  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-accent/40">
      <Checkbox
        checked={done}
        onCheckedChange={() =>
          done ? reopenTask.mutate({ id: t.id }) : complete.mutate({ id: t.id })
        }
        aria-label="Toggle task"
      />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-sm font-medium ${done ? "line-through opacity-50" : ""}`}
        >
          {t.displayId != null ? (
            <span className="tnum mr-1.5 font-mono text-xs text-muted-foreground/70">
              TASK-{t.displayId}
            </span>
          ) : null}
          {t.title ?? "Untitled"}
        </p>
        {t.body ? (
          <p className="truncate text-xs text-muted-foreground">{t.body}</p>
        ) : null}
      </div>
      {link ? (
        <Link
          to={link.to}
          params={link.params}
          className={`shrink-0 ${chipClass("ghost")}`}
        >
          {link.label}
        </Link>
      ) : null}
      {t.actorType === "agent" ? (
        <span className={`shrink-0 ${chipClass("secondary", "xs")}`}>
          agent
        </span>
      ) : null}
      {assignee ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {assignee.name.split(" ")[0]}
        </span>
      ) : null}
      {t.dueAt ? (
        <span
          className={`shrink-0 ${chipClass(!done && daysUntil(t.dueAt) != null && daysUntil(t.dueAt)! < 0 ? "error" : "ghost")}`}
          title={formatDateTime(t.dueAt)}
        >
          <CalendarClock className="size-3" /> {t.dueAt.slice(0, 10)}
        </span>
      ) : null}
      <span className="hidden shrink-0 text-xs text-muted-foreground/60 sm:inline">
        {relativeTime(t.createdAt)}
      </span>
    </li>
  );
}
