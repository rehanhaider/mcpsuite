/** Bulk actions — risky category "bulk": direct for humans, gated for agents. */
import { z } from "zod";
import { OpError } from "../errors.ts";
import { TAGGABLE_TYPES, zId } from "../domain.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit, found } from "./helpers.ts";

const zBulkEntity = z.enum(["company", "person", "engagement", "deal"]);
const zIds = z.array(zId).min(1).max(500);

function setArchivedFor(op: OpCtx, entity: z.infer<typeof zBulkEntity>, id: string, archived: boolean) {
  switch (entity) {
    case "company":
      return op.ports.companies.setArchived(id, archived);
    case "person":
      return op.ports.people.setArchived(id, archived);
    case "engagement":
      return op.ports.engagements.setArchived(id, archived);
    case "deal":
      return op.ports.deals.setArchived(id, archived);
  }
}

function setOwnerFor(op: OpCtx, entity: z.infer<typeof zBulkEntity>, id: string, ownerUserId: string | null) {
  switch (entity) {
    case "company":
      return op.ports.companies.update(id, { ownerUserId });
    case "person":
      return op.ports.people.update(id, { ownerUserId });
    case "engagement":
      return op.ports.engagements.update(id, { ownerUserId });
    case "deal":
      return op.ports.deals.update(id, { ownerUserId });
  }
}

export const bulkOps = [
  defineOperation({
    name: "bulk.updateStage",
    title: "Bulk move stage",
    description: "Move many engagements or deals to a stage in one shot. Risky (bulk).",
    input: z.object({ entityType: z.enum(["engagement", "deal"]), ids: zIds, stageId: zId }),
    minRole: "member",
    scope: "write",
    risk: "bulk",
    preview: ({ ports }, { entityType, ids, stageId }) => ({
      entityType,
      count: ids.length,
      stage: ports.pipelines.getStage(stageId)?.name ?? stageId,
    }),
    handler: (op, { entityType, ids, stageId }) => {
      const stage = found(op.ports.pipelines.getStage(stageId), "stage", stageId);
      const updated = op.ports.tx(() => {
        let n = 0;
        for (const id of ids) {
          if (entityType === "engagement") {
            const e = op.ports.engagements.get(id);
            if (!e || e.pipelineId !== stage.pipelineId) continue;
            op.ports.engagements.update(id, { stageId });
          } else {
            const d = op.ports.deals.get(id);
            if (!d || d.pipelineId !== stage.pipelineId) continue;
            op.ports.deals.update(id, { stageId });
          }
          n++;
        }
        return n;
      });
      audit(op, {
        operation: "bulk.updateStage",
        entityType,
        entityId: null,
        summary: `Bulk-moved ${updated}/${ids.length} ${entityType}s to stage "${stage.name}"`,
      });
      return { updated, skipped: ids.length - updated };
    },
  }),

  defineOperation({
    name: "bulk.assignOwner",
    title: "Bulk assign owner",
    description: "Assign an owner to many records in one shot. Risky (bulk).",
    input: z.object({ entityType: zBulkEntity, ids: zIds, ownerUserId: zId.nullable() }),
    minRole: "member",
    scope: "write",
    risk: "bulk",
    preview: ({ ports }, { entityType, ids, ownerUserId }) => ({
      entityType,
      count: ids.length,
      owner: ownerUserId ? (ports.users.get(ownerUserId)?.name ?? ownerUserId) : "(unassigned)",
    }),
    handler: (op, { entityType, ids, ownerUserId }) => {
      if (ownerUserId) found(op.ports.users.get(ownerUserId), "user", ownerUserId);
      const updated = op.ports.tx(() => {
        let n = 0;
        for (const id of ids) {
          try {
            setOwnerFor(op, entityType, id, ownerUserId);
            n++;
          } catch {
            // skip missing rows
          }
        }
        return n;
      });
      audit(op, {
        operation: "bulk.assignOwner",
        entityType,
        entityId: null,
        summary: `Bulk-assigned owner on ${updated}/${ids.length} ${entityType}s`,
      });
      return { updated, skipped: ids.length - updated };
    },
  }),

  defineOperation({
    name: "bulk.addTag",
    title: "Bulk add tag",
    description: "Apply a tag to many records in one shot. Risky (bulk).",
    input: z.object({ entityType: z.enum(TAGGABLE_TYPES), ids: zIds, tagId: zId }),
    minRole: "member",
    scope: "write",
    risk: "bulk",
    preview: ({ ports }, { entityType, ids, tagId }) => ({
      entityType,
      count: ids.length,
      tag: ports.tags.get(tagId)?.name ?? tagId,
    }),
    handler: (op, { entityType, ids, tagId }) => {
      found(op.ports.tags.get(tagId), "tag", tagId);
      op.ports.tx(() => {
        for (const id of ids) op.ports.tags.apply(tagId, entityType, id);
      });
      audit(op, {
        operation: "bulk.addTag",
        entityType,
        entityId: null,
        summary: `Bulk-tagged ${ids.length} ${entityType}s`,
      });
      return { updated: ids.length };
    },
  }),

  defineOperation({
    name: "bulk.archive",
    title: "Bulk archive",
    description: "Archive many records in one shot (reversible). Risky (bulk).",
    input: z.object({ entityType: zBulkEntity, ids: zIds }),
    minRole: "member",
    scope: "write",
    risk: "bulk",
    preview: (_op, { entityType, ids }) => ({ entityType, count: ids.length }),
    handler: (op, { entityType, ids }) => {
      const updated = op.ports.tx(() => {
        let n = 0;
        for (const id of ids) {
          try {
            setArchivedFor(op, entityType, id, true);
            n++;
          } catch (e) {
            if (e instanceof OpError && e.code === "not_found") continue;
            throw e;
          }
        }
        return n;
      });
      audit(op, {
        operation: "bulk.archive",
        entityType,
        entityId: null,
        summary: `Bulk-archived ${updated}/${ids.length} ${entityType}s`,
      });
      return { updated, skipped: ids.length - updated };
    },
  }),
];
