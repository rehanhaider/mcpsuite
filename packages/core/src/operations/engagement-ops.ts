import { z } from "zod";
import { OpError } from "../errors.ts";
import { nowIso } from "../ids.ts";
import {
  zEngagementCreate,
  zEngagementFilter,
  zEngagementUpdate,
  zExpectedVersion,
  zId,
  type Engagement,
} from "../domain.ts";
import { actorStamp } from "../context.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit, checkVersion, definedOnly, found } from "./helpers.ts";

const zGet = z.object({ id: zId });

function defaultTitle(op: OpCtx, companyId?: string | null, personId?: string | null): string {
  const company = companyId ? op.ports.companies.get(companyId) : null;
  const person = personId ? op.ports.people.get(personId) : null;
  if (person && company) return `${person.name} @ ${company.name}`;
  if (person) return person.name;
  if (company) return company.name;
  return "Untitled engagement";
}

/** Resolve pipeline + first stage defaults, validating stage∈pipeline. */
function resolvePipelineStage(
  op: OpCtx,
  type: "engagement" | "deal",
  pipelineId?: string | null,
  stageId?: string | null,
): { pipelineId: string; stageId: string } {
  const pipeline = pipelineId ? op.ports.pipelines.get(pipelineId) : op.ports.pipelines.getDefault(type);
  if (!pipeline || pipeline.type !== type) {
    throw OpError.validation(`No ${type} pipeline found${pipelineId ? ` with id ${pipelineId}` : ""}`);
  }
  if (stageId) {
    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) throw OpError.validation(`Stage ${stageId} is not part of pipeline "${pipeline.name}"`);
    return { pipelineId: pipeline.id, stageId };
  }
  const first = pipeline.stages[0];
  if (!first) throw OpError.validation(`Pipeline "${pipeline.name}" has no stages`);
  return { pipelineId: pipeline.id, stageId: first.id };
}

export { resolvePipelineStage };

export const engagementOps = [
  defineOperation({
    name: "engagement.list",
    title: "List leads / engagements",
    description:
      "List engagements (the Leads view) with filters, sorting and pagination. Use stale=true for attention lists.",
    input: zEngagementFilter,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, input) => ports.engagements.list(input),
  }),

  defineOperation({
    name: "engagement.get",
    title: "Get engagement",
    description: "Fetch one engagement with tags, custom fields and linked offerings.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const engagement = found(ports.engagements.get(id), "engagement", id);
      return {
        ...engagement,
        tags: ports.tags.forEntity("engagement", id),
        customFields: ports.customFields.values("engagement", id),
        offerings: ports.offerings.links("engagement", id),
        lists: ports.lists.forEntity("engagement", id),
      };
    },
  }),

  defineOperation({
    name: "engagement.create",
    title: "Create lead / engagement",
    description:
      "Create an engagement (a lead). Link a company and/or person; pipeline/stage default to the default engagement pipeline's first stage.",
    input: zEngagementCreate,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      if (input.companyId) found(op.ports.companies.get(input.companyId), "company", input.companyId);
      if (input.personId) found(op.ports.people.get(input.personId), "person", input.personId);
      if (input.offeringId) found(op.ports.offerings.get(input.offeringId), "offering", input.offeringId);
      const { pipelineId, stageId } = resolvePipelineStage(op, "engagement", input.pipelineId, input.stageId);
      const { offeringId, ...rest } = input;
      const engagement = op.ports.tx(() => {
        const e = op.ports.engagements.create({
          ...definedOnly(rest),
          title: input.title?.trim() || defaultTitle(op, input.companyId, input.personId),
          pipelineId,
          stageId,
          ownerUserId: input.ownerUserId ?? op.ctx.userId,
        } as Partial<Engagement> & { title: string; pipelineId: string; stageId: string });
        if (offeringId) {
          op.ports.offerings.link({ offeringId, entityType: "engagement", entityId: e.id, isPrimary: true });
        }
        return e;
      });
      audit(op, {
        operation: "engagement.create",
        entityType: "engagement",
        entityId: engagement.id,
        summary: `Created engagement "${engagement.title}"`,
        meta: offeringId ? { offeringId } : undefined,
      });
      return engagement;
    },
  }),

  defineOperation({
    name: "engagement.update",
    title: "Update engagement",
    description: "Patch engagement fields (not the stage — use engagement.updateStage).",
    input: zEngagementUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion, ...patch }) => {
      const existing = found(op.ports.engagements.get(id), "engagement", id);
      checkVersion("engagement", id, existing.version, expectedVersion);
      if (patch.companyId) found(op.ports.companies.get(patch.companyId), "company", patch.companyId);
      if (patch.personId) found(op.ports.people.get(patch.personId), "person", patch.personId);
      if (patch.dealId) found(op.ports.deals.get(patch.dealId), "deal", patch.dealId);
      const updated = op.ports.engagements.update(id, definedOnly(patch));
      audit(op, {
        operation: "engagement.update",
        entityType: "engagement",
        entityId: id,
        summary: `Updated engagement "${updated.title}"`,
        meta: { fields: Object.keys(definedOnly(patch)) },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "engagement.updateStage",
    title: "Move engagement stage",
    description: "Move an engagement to another stage of its pipeline. Optionally log a note; emits a status_change activity.",
    input: z.object({ id: zId, stageId: zId, note: z.string().max(5000).nullish(), expectedVersion: zExpectedVersion }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, stageId, note, expectedVersion }) => {
      const engagement = found(op.ports.engagements.get(id), "engagement", id);
      checkVersion("engagement", id, engagement.version, expectedVersion);
      const pipeline = found(op.ports.pipelines.get(engagement.pipelineId), "pipeline", engagement.pipelineId);
      const from = pipeline.stages.find((s) => s.id === engagement.stageId);
      const to = pipeline.stages.find((s) => s.id === stageId);
      if (!to) throw OpError.validation(`Stage ${stageId} is not part of pipeline "${pipeline.name}"`);
      const updated = op.ports.engagements.update(id, { stageId });
      const at = nowIso();
      op.ports.activities.create(
        {
          kind: "status_change",
          engagementId: id,
          companyId: engagement.companyId,
          personId: engagement.personId,
          title: `Stage: ${from?.name ?? "?"} → ${to.name}`,
          body: note ?? null,
          meta: { fromStageId: engagement.stageId, toStageId: stageId, entity: "engagement" },
        },
        actorStamp(op.ctx),
      );
      op.ports.engagements.update(id, { lastActivityAt: at });
      audit(op, {
        operation: "engagement.updateStage",
        entityType: "engagement",
        entityId: id,
        summary: `Moved "${engagement.title}" to stage "${to.name}"`,
        meta: { from: from?.name, to: to.name },
      });
      return { ...updated, stageId, lastActivityAt: at };
    },
  }),

  defineOperation({
    name: "engagement.archive",
    title: "Archive engagement",
    description: "Archive (soft delete) an engagement.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.engagements.get(id), "engagement", id);
      const e = op.ports.engagements.setArchived(id, true);
      audit(op, { operation: "engagement.archive", entityType: "engagement", entityId: id, summary: `Archived engagement "${e.title}"` });
      return e;
    },
  }),

  defineOperation({
    name: "engagement.restore",
    title: "Restore engagement",
    description: "Restore an archived engagement.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.engagements.get(id), "engagement", id);
      const e = op.ports.engagements.setArchived(id, false);
      audit(op, { operation: "engagement.restore", entityType: "engagement", entityId: id, summary: `Restored engagement "${e.title}"` });
      return e;
    },
  }),

  defineOperation({
    name: "engagement.delete",
    title: "Hard-delete engagement",
    description: "Permanently delete an engagement. Irreversible; prefer engagement.archive.",
    input: zGet,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const e = ports.engagements.get(id);
      return { engagement: e ? { id: e.id, title: e.title } : null };
    },
    handler: (op, { id }) => {
      const e = found(op.ports.engagements.get(id), "engagement", id);
      op.ports.engagements.hardDelete(id);
      audit(op, { operation: "engagement.delete", entityType: "engagement", entityId: id, summary: `Hard-deleted engagement "${e.title}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "engagement.getContext",
    title: "Engagement context bundle",
    description: "Structured context for agents: engagement, company, person, offerings, timeline, open tasks.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const engagement = found(ports.engagements.get(id), "engagement", id);
      const activities = ports.activities.list({ engagementId: id, limit: 50, offset: 0 });
      const openTasks = ports.activities.list({ engagementId: id, kind: "task", open: true, limit: 25, offset: 0 });
      return {
        engagement,
        company: engagement.companyId ? ports.companies.get(engagement.companyId) : null,
        person: engagement.personId ? ports.people.get(engagement.personId) : null,
        deal: engagement.dealId ? ports.deals.get(engagement.dealId) : null,
        tags: ports.tags.forEntity("engagement", id),
        customFields: ports.customFields.values("engagement", id),
        offerings: ports.offerings.links("engagement", id),
        lists: ports.lists.forEntity("engagement", id),
        recentActivities: activities.items,
        openTasks: openTasks.items,
      };
    },
  }),
];
