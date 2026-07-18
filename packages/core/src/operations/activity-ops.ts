import { z } from "zod";
import { OpError } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { zActivityFilter, zActivityLog, zActivityUpdate, zId, zTaskCreate } from "../domain.ts";
import { actorStamp } from "../context.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit, definedOnly, found } from "./helpers.ts";

const zGet = z.object({ id: zId });

function validateLinks(
  op: OpCtx,
  input: { companyId?: string | null; personId?: string | null; engagementId?: string | null; dealId?: string | null },
) {
  if (input.companyId) found(op.ports.companies.get(input.companyId), "company", input.companyId);
  if (input.personId) found(op.ports.people.get(input.personId), "person", input.personId);
  if (input.engagementId) found(op.ports.engagements.get(input.engagementId), "engagement", input.engagementId);
  if (input.dealId) found(op.ports.deals.get(input.dealId), "deal", input.dealId);
}

export const activityOps = [
  defineOperation({
    name: "activity.list",
    title: "List activities",
    description:
      "List timeline activities with filters (kind, linked record, actor type, task status). Sorted newest first.",
    input: zActivityFilter,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, input) => ports.activities.list(input),
  }),

  defineOperation({
    name: "activity.log",
    title: "Log activity",
    description:
      "Log a note, call, email, meeting or task against companies/people/engagements/deals. Tasks accept dueAt + assigneeUserId.",
    input: zActivityLog,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      validateLinks(op, input);
      const at = input.occurredAt ?? nowIso();
      const activity = op.ports.activities.create(
        {
          kind: input.kind,
          title: input.title ?? null,
          body: input.body ?? null,
          companyId: input.companyId ?? null,
          personId: input.personId ?? null,
          engagementId: input.engagementId ?? null,
          dealId: input.dealId ?? null,
          dueAt: input.kind === "task" ? (input.dueAt ?? null) : null,
          assigneeUserId: input.kind === "task" ? (input.assigneeUserId ?? op.ctx.userId) : null,
          createdAt: at,
        },
        actorStamp(op.ctx),
      );
      op.ports.activities.touchLinked(activity, at);
      audit(op, {
        operation: "activity.log",
        entityType: "activity",
        entityId: activity.id,
        summary: `Logged ${input.kind}${input.title ? `: ${input.title}` : ""}`,
      });
      return activity;
    },
  }),

  defineOperation({
    name: "activity.update",
    title: "Update activity",
    description: "Edit an activity's title/body, or a task's due date and assignee.",
    input: zActivityUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, ...patch }) => {
      const existing = found(op.ports.activities.get(id), "activity", id);
      if (existing.kind === "status_change" || existing.kind === "agent_action") {
        throw OpError.validation("System-emitted activities cannot be edited");
      }
      const updated = op.ports.activities.update(id, definedOnly(patch));
      audit(op, { operation: "activity.update", entityType: "activity", entityId: id, summary: "Updated activity" });
      return updated;
    },
  }),

  defineOperation({
    name: "activity.delete",
    title: "Delete activity",
    description: "Permanently delete a single activity entry. Irreversible.",
    input: zGet,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const a = ports.activities.get(id);
      return { activity: a ? { id: a.id, kind: a.kind, title: a.title } : null };
    },
    handler: (op, { id }) => {
      found(op.ports.activities.get(id), "activity", id);
      op.ports.activities.hardDelete(id);
      audit(op, { operation: "activity.delete", entityType: "activity", entityId: id, summary: "Deleted activity" });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "task.create",
    title: "Create task",
    description: "Create a task (an activity of kind task) with title, optional due date and assignee.",
    input: zTaskCreate,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      validateLinks(op, input);
      const activity = op.ports.activities.create(
        {
          kind: "task",
          title: input.title,
          body: input.body ?? null,
          companyId: input.companyId ?? null,
          personId: input.personId ?? null,
          engagementId: input.engagementId ?? null,
          dealId: input.dealId ?? null,
          dueAt: input.dueAt ?? null,
          assigneeUserId: input.assigneeUserId ?? op.ctx.userId,
        },
        actorStamp(op.ctx),
      );
      op.ports.activities.touchLinked(activity, activity.createdAt);
      audit(op, { operation: "task.create", entityType: "activity", entityId: activity.id, summary: `Created task "${input.title}"` });
      return activity;
    },
  }),

  defineOperation({
    name: "task.complete",
    title: "Complete task",
    description: "Mark a task as completed.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      const task = found(op.ports.activities.get(id), "task", id);
      if (task.kind !== "task") throw OpError.validation("Activity is not a task");
      const updated = op.ports.activities.update(id, { completedAt: nowIso() });
      audit(op, { operation: "task.complete", entityType: "activity", entityId: id, summary: `Completed task "${task.title ?? id}"` });
      return updated;
    },
  }),

  defineOperation({
    name: "task.reopen",
    title: "Reopen task",
    description: "Reopen a completed task.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      const task = found(op.ports.activities.get(id), "task", id);
      if (task.kind !== "task") throw OpError.validation("Activity is not a task");
      const updated = op.ports.activities.update(id, { completedAt: null });
      audit(op, { operation: "task.reopen", entityType: "activity", entityId: id, summary: `Reopened task "${task.title ?? id}"` });
      return updated;
    },
  }),
];
