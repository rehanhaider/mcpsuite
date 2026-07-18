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
    preview: async ({ ports }, { entityType, ids, stageId }) => ({
      entityType,
      count: ids.length,
      stage: (await ports.pipelines.getStage(stageId))?.name ?? stageId,
    }),
    handler: async (op, { entityType, ids, stageId }) => {
      const stage = found(await op.ports.pipelines.getStage(stageId), "stage", stageId);
      const updated = await op.ports.tx(async () => {
        let n = 0;
        for (const id of ids) {
          if (entityType === "engagement") {
            const e = await op.ports.engagements.get(id);
            if (!e || e.pipelineId !== stage.pipelineId) continue;
            await op.ports.engagements.update(id, { stageId });
          } else {
            const d = await op.ports.deals.get(id);
            if (!d || d.pipelineId !== stage.pipelineId) continue;
            await op.ports.deals.update(id, { stageId });
          }
          n++;
        }
        return n;
      });
      await audit(op, {
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
    preview: async ({ ports }, { entityType, ids, ownerUserId }) => ({
      entityType,
      count: ids.length,
      owner: ownerUserId ? ((await ports.users.get(ownerUserId))?.name ?? ownerUserId) : "(unassigned)",
    }),
    handler: async (op, { entityType, ids, ownerUserId }) => {
      if (ownerUserId) found(await op.ports.users.get(ownerUserId), "user", ownerUserId);
      const updated = await op.ports.tx(async () => {
        let n = 0;
        for (const id of ids) {
          try {
            await setOwnerFor(op, entityType, id, ownerUserId);
            n++;
          } catch {
            // skip missing rows
          }
        }
        return n;
      });
      await audit(op, {
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
    preview: async ({ ports }, { entityType, ids, tagId }) => ({
      entityType,
      count: ids.length,
      tag: (await ports.tags.get(tagId))?.name ?? tagId,
    }),
    handler: async (op, { entityType, ids, tagId }) => {
      found(await op.ports.tags.get(tagId), "tag", tagId);
      await op.ports.tx(async () => {
        for (const id of ids) await op.ports.tags.apply(tagId, entityType, id);
      });
      await audit(op, {
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
    preview: async (_op, { entityType, ids }) => ({ entityType, count: ids.length }),
    handler: async (op, { entityType, ids }) => {
      const updated = await op.ports.tx(async () => {
        let n = 0;
        for (const id of ids) {
          try {
            await setArchivedFor(op, entityType, id, true);
            n++;
          } catch (e) {
            if (e instanceof OpError && e.code === "not_found") continue;
            throw e;
          }
        }
        return n;
      });
      await audit(op, {
        operation: "bulk.archive",
        entityType,
        entityId: null,
        summary: `Bulk-archived ${updated}/${ids.length} ${entityType}s`,
      });
      return { updated, skipped: ids.length - updated };
    },
  }),
];
