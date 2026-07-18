import { z } from "zod";
import { OpError } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { zDealCreate, zDealFilter, zDealUpdate, zExpectedVersion, zId, type Deal } from "../domain.ts";
import { actorStamp } from "../context.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit, checkVersion, definedOnly, found } from "./helpers.ts";
import { resolvePipelineStage } from "./engagement-ops.ts";

const zGet = z.object({ id: zId });

function logDealStageChange(op: OpCtx, deal: Deal, toStageName: string, fromStageName: string | undefined, note?: string | null) {
  op.ports.activities.create(
    {
      kind: "status_change",
      dealId: deal.id,
      companyId: deal.companyId,
      personId: deal.primaryPersonId,
      title: `Stage: ${fromStageName ?? "?"} → ${toStageName}`,
      body: note ?? null,
      meta: { entity: "deal" },
    },
    actorStamp(op.ctx),
  );
}

export const dealOps = [
  defineOperation({
    name: "deal.list",
    title: "List deals",
    description: "List deals with filters, sorting and pagination.",
    input: zDealFilter,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, input) => ports.deals.list(input),
  }),

  defineOperation({
    name: "deal.get",
    title: "Get deal",
    description: "Fetch one deal with stakeholders, tags, custom fields and linked offerings.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const deal = found(ports.deals.get(id), "deal", id);
      return {
        ...deal,
        stakeholders: ports.deals.stakeholders(id),
        tags: ports.tags.forEntity("deal", id),
        customFields: ports.customFields.values("deal", id),
        offerings: ports.offerings.links("deal", id),
        lists: ports.lists.forEntity("deal", id),
      };
    },
  }),

  defineOperation({
    name: "deal.create",
    title: "Create deal",
    description:
      "Create a deal. Amounts are integer minor units (e.g. cents). Currency defaults to the workspace currency; pipeline/stage default to the default deal pipeline. Offering links copy from the source engagement when engagementId is set.",
    input: zDealCreate,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      if (input.companyId) found(op.ports.companies.get(input.companyId), "company", input.companyId);
      if (input.primaryPersonId) found(op.ports.people.get(input.primaryPersonId), "person", input.primaryPersonId);
      if (input.engagementId) found(op.ports.engagements.get(input.engagementId), "engagement", input.engagementId);
      if (input.offeringId) found(op.ports.offerings.get(input.offeringId), "offering", input.offeringId);
      const { pipelineId, stageId } = resolvePipelineStage(op, "deal", input.pipelineId, input.stageId);
      const stage = op.ports.pipelines.getStage(stageId);
      const { offeringId, ...rest } = input;
      const deal = op.ports.tx(() => {
        const d = op.ports.deals.create({
          ...definedOnly(rest),
          pipelineId,
          stageId,
          currency: input.currency ?? op.ports.workspace.get().defaultCurrency,
          probability: input.probability ?? stage?.probability ?? null,
          ownerUserId: input.ownerUserId ?? op.ctx.userId,
        } as Partial<Deal> & { title: string; pipelineId: string; stageId: string; currency: string });
        if (input.engagementId) op.ports.engagements.update(input.engagementId, { dealId: d.id });
        const carried = input.engagementId ? op.ports.offerings.links("engagement", input.engagementId) : [];
        for (const l of carried) {
          op.ports.offerings.link({
            offeringId: l.offeringId,
            entityType: "deal",
            entityId: d.id,
            fit: l.fit,
            note: l.note,
            isPrimary: l.isPrimary,
          });
        }
        if (offeringId && !carried.some((l) => l.offeringId === offeringId)) {
          op.ports.offerings.link({
            offeringId,
            entityType: "deal",
            entityId: d.id,
            isPrimary: carried.length === 0,
          });
        }
        return d;
      });
      audit(op, {
        operation: "deal.create",
        entityType: "deal",
        entityId: deal.id,
        summary: `Created deal "${deal.title}"`,
      });
      return deal;
    },
  }),

  defineOperation({
    name: "deal.update",
    title: "Update deal",
    description: "Patch deal fields (not the stage — use deal.updateStage / deal.markWon / deal.markLost).",
    input: zDealUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion, ...patch }) => {
      const existing = found(op.ports.deals.get(id), "deal", id);
      checkVersion("deal", id, existing.version, expectedVersion);
      const updated = op.ports.deals.update(id, definedOnly(patch));
      audit(op, {
        operation: "deal.update",
        entityType: "deal",
        entityId: id,
        summary: `Updated deal "${updated.title}"`,
        meta: { fields: Object.keys(definedOnly(patch)) },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "deal.updateStage",
    title: "Move deal stage",
    description:
      "Move a deal to another stage of its pipeline. Probability follows the stage default unless the deal has an explicit one. Emits a status_change activity.",
    input: z.object({ id: zId, stageId: zId, note: z.string().max(5000).nullish(), expectedVersion: zExpectedVersion }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, stageId, note, expectedVersion }) => {
      const deal = found(op.ports.deals.get(id), "deal", id);
      checkVersion("deal", id, deal.version, expectedVersion);
      const pipeline = found(op.ports.pipelines.get(deal.pipelineId), "pipeline", deal.pipelineId);
      const from = pipeline.stages.find((s) => s.id === deal.stageId);
      const to = pipeline.stages.find((s) => s.id === stageId);
      if (!to) throw OpError.validation(`Stage ${stageId} is not part of pipeline "${pipeline.name}"`);
      const patch: Partial<Deal> = { stageId, probability: to.probability ?? deal.probability };
      if (to.outcome === "won" || to.outcome === "lost") {
        patch.status = to.outcome;
        patch.closedAt = nowIso();
      } else if (deal.status !== "open") {
        patch.status = "open";
        patch.closedAt = null;
      }
      const updated = op.ports.deals.update(id, patch);
      logDealStageChange(op, deal, to.name, from?.name, note);
      op.ports.deals.update(id, { lastActivityAt: nowIso() });
      audit(op, {
        operation: "deal.updateStage",
        entityType: "deal",
        entityId: id,
        summary: `Moved deal "${deal.title}" to stage "${to.name}"`,
        meta: { from: from?.name, to: to.name },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "deal.markWon",
    title: "Mark deal won",
    description: "Mark a deal as won (moves to the pipeline's won stage when one exists).",
    input: z.object({ id: zId, note: z.string().max(5000).nullish(), expectedVersion: zExpectedVersion }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, note, expectedVersion }) => {
      const deal = found(op.ports.deals.get(id), "deal", id);
      checkVersion("deal", id, deal.version, expectedVersion);
      const pipeline = found(op.ports.pipelines.get(deal.pipelineId), "pipeline", deal.pipelineId);
      const wonStage = pipeline.stages.find((s) => s.outcome === "won");
      const from = pipeline.stages.find((s) => s.id === deal.stageId);
      const updated = op.ports.deals.update(id, {
        status: "won",
        closedAt: nowIso(),
        probability: 100,
        ...(wonStage ? { stageId: wonStage.id } : {}),
      });
      logDealStageChange(op, deal, wonStage?.name ?? "Won", from?.name, note);
      audit(op, { operation: "deal.markWon", entityType: "deal", entityId: id, summary: `Won deal "${deal.title}"` });
      return updated;
    },
  }),

  defineOperation({
    name: "deal.markLost",
    title: "Mark deal lost",
    description: "Mark a deal as lost with an optional reason (moves to the pipeline's lost stage when one exists).",
    input: z.object({
      id: zId,
      lostReason: z.string().max(500).nullish(),
      note: z.string().max(5000).nullish(),
      expectedVersion: zExpectedVersion,
    }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, lostReason, note, expectedVersion }) => {
      const deal = found(op.ports.deals.get(id), "deal", id);
      checkVersion("deal", id, deal.version, expectedVersion);
      const pipeline = found(op.ports.pipelines.get(deal.pipelineId), "pipeline", deal.pipelineId);
      const lostStage = pipeline.stages.find((s) => s.outcome === "lost");
      const from = pipeline.stages.find((s) => s.id === deal.stageId);
      const updated = op.ports.deals.update(id, {
        status: "lost",
        closedAt: nowIso(),
        probability: 0,
        lostReason: lostReason ?? deal.lostReason,
        ...(lostStage ? { stageId: lostStage.id } : {}),
      });
      logDealStageChange(op, deal, lostStage?.name ?? "Lost", from?.name, note ?? lostReason);
      audit(op, {
        operation: "deal.markLost",
        entityType: "deal",
        entityId: id,
        summary: `Lost deal "${deal.title}"${lostReason ? ` — ${lostReason}` : ""}`,
      });
      return updated;
    },
  }),

  defineOperation({
    name: "deal.reopen",
    title: "Reopen deal",
    description: "Reopen a won/lost deal back to open status (stays in its current stage).",
    input: z.object({ id: zId, expectedVersion: zExpectedVersion }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion }) => {
      const deal = found(op.ports.deals.get(id), "deal", id);
      checkVersion("deal", id, deal.version, expectedVersion);
      if (deal.status === "open") throw OpError.validation("Deal is already open");
      const updated = op.ports.deals.update(id, { status: "open", closedAt: null, lostReason: null });
      audit(op, { operation: "deal.reopen", entityType: "deal", entityId: id, summary: `Reopened deal "${deal.title}"` });
      return updated;
    },
  }),

  defineOperation({
    name: "deal.archive",
    title: "Archive deal",
    description: "Archive (soft delete) a deal.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.deals.get(id), "deal", id);
      const d = op.ports.deals.setArchived(id, true);
      audit(op, { operation: "deal.archive", entityType: "deal", entityId: id, summary: `Archived deal "${d.title}"` });
      return d;
    },
  }),

  defineOperation({
    name: "deal.restore",
    title: "Restore deal",
    description: "Restore an archived deal.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.deals.get(id), "deal", id);
      const d = op.ports.deals.setArchived(id, false);
      audit(op, { operation: "deal.restore", entityType: "deal", entityId: id, summary: `Restored deal "${d.title}"` });
      return d;
    },
  }),

  defineOperation({
    name: "deal.delete",
    title: "Hard-delete deal",
    description: "Permanently delete a deal. Irreversible; prefer deal.archive.",
    input: zGet,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const d = ports.deals.get(id);
      return { deal: d ? { id: d.id, title: d.title } : null };
    },
    handler: (op, { id }) => {
      const d = found(op.ports.deals.get(id), "deal", id);
      op.ports.deals.hardDelete(id);
      audit(op, { operation: "deal.delete", entityType: "deal", entityId: id, summary: `Hard-deleted deal "${d.title}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "deal.addStakeholder",
    title: "Add deal stakeholder",
    description: "Add a person to a deal's stakeholder list with an optional role.",
    input: z.object({
      dealId: zId,
      personId: zId,
      role: z.string().max(100).nullish(),
      isPrimary: z.boolean().default(false),
      note: z.string().max(1000).nullish(),
    }),
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      found(op.ports.deals.get(input.dealId), "deal", input.dealId);
      found(op.ports.people.get(input.personId), "person", input.personId);
      const sh = op.ports.deals.addStakeholder(input);
      audit(op, {
        operation: "deal.addStakeholder",
        entityType: "deal",
        entityId: input.dealId,
        summary: "Added stakeholder",
        meta: { personId: input.personId, role: input.role },
      });
      return sh;
    },
  }),

  defineOperation({
    name: "deal.updateStakeholder",
    title: "Update deal stakeholder",
    description: "Update a stakeholder's role, primary flag or note.",
    input: z.object({
      id: zId,
      role: z.string().max(100).nullish(),
      isPrimary: z.boolean().optional(),
      note: z.string().max(1000).nullish(),
    }),
    minRole: "member",
    scope: "write",
    handler: (op, { id, ...patch }) => {
      found(op.ports.deals.getStakeholder(id), "stakeholder", id);
      return op.ports.deals.updateStakeholder(id, definedOnly(patch));
    },
  }),

  defineOperation({
    name: "deal.removeStakeholder",
    title: "Remove deal stakeholder",
    description: "Remove a person from a deal's stakeholder list.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.deals.getStakeholder(id), "stakeholder", id);
      op.ports.deals.removeStakeholder(id);
      return { ok: true };
    },
  }),

  defineOperation({
    name: "deal.getContext",
    title: "Deal context bundle",
    description:
      "Structured context for agents: deal, company, stakeholders, offerings, recent activities and open tasks.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const deal = found(ports.deals.get(id), "deal", id);
      const activities = ports.activities.list({ dealId: id, limit: 50, offset: 0 });
      const openTasks = ports.activities.list({ dealId: id, kind: "task", open: true, limit: 25, offset: 0 });
      return {
        deal,
        company: deal.companyId ? ports.companies.get(deal.companyId) : null,
        primaryPerson: deal.primaryPersonId ? ports.people.get(deal.primaryPersonId) : null,
        stakeholders: ports.deals.stakeholders(id),
        tags: ports.tags.forEntity("deal", id),
        customFields: ports.customFields.values("deal", id),
        offerings: ports.offerings.links("deal", id),
        lists: ports.lists.forEntity("deal", id),
        recentActivities: activities.items,
        openTasks: openTasks.items,
      };
    },
  }),
];
