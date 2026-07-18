import { z } from "zod";
import { OpError } from "../errors.ts";
import { PIPELINE_TYPES, zId, zPipelineCreate, zSemanticColor, zStageInput } from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, definedOnly, found } from "./helpers.ts";

export const pipelineOps = [
  defineOperation({
    name: "pipeline.list",
    title: "List pipelines",
    description: "List pipelines (engagement/outreach and deal) with their ordered stages.",
    input: z.object({ type: z.enum(PIPELINE_TYPES).optional() }),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { type }) => ports.pipelines.list(type),
  }),

  defineOperation({
    name: "pipeline.create",
    title: "Create pipeline",
    description: "Create a pipeline with an initial ordered stage list. Configuration change — gated for agents.",
    input: zPipelineCreate,
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, input) => {
      const pipeline = await op.ports.pipelines.create(input);
      await audit(op, {
        operation: "pipeline.create",
        entityType: "pipeline",
        entityId: pipeline.id,
        summary: `Created ${input.type} pipeline "${input.name}"`,
      });
      return pipeline;
    },
  }),

  defineOperation({
    name: "pipeline.rename",
    title: "Rename pipeline",
    description: "Rename a pipeline.",
    input: z.object({ id: zId, name: z.string().min(1).max(100) }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id, name }) => {
      found(await op.ports.pipelines.get(id), "pipeline", id);
      const p = await op.ports.pipelines.rename(id, name);
      await audit(op, { operation: "pipeline.rename", entityType: "pipeline", entityId: id, summary: `Renamed pipeline to "${name}"` });
      return p;
    },
  }),

  defineOperation({
    name: "pipeline.setDefault",
    title: "Set default pipeline",
    description: "Make a pipeline the default for its type.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id }) => {
      found(await op.ports.pipelines.get(id), "pipeline", id);
      await op.ports.pipelines.setDefault(id);
      await audit(op, { operation: "pipeline.setDefault", entityType: "pipeline", entityId: id, summary: "Set default pipeline" });
      return { ok: true };
    },
  }),

  defineOperation({
    name: "pipeline.delete",
    title: "Delete pipeline",
    description: "Delete a pipeline. Blocked while any engagement/deal references it.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    preview: async ({ ports }, { id }) => ({ usage: await ports.pipelines.pipelineUsage(id) }),
    handler: async (op, { id }) => {
      const pipeline = found(await op.ports.pipelines.get(id), "pipeline", id);
      const usage = await op.ports.pipelines.pipelineUsage(id);
      if (usage > 0) throw OpError.inUse("pipeline", id, usage);
      await op.ports.pipelines.delete(id);
      await audit(op, { operation: "pipeline.delete", entityType: "pipeline", entityId: id, summary: `Deleted pipeline "${pipeline.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "stage.add",
    title: "Add stage",
    description: "Append a stage to a pipeline.",
    input: z.object({ pipelineId: zId }).merge(zStageInput),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { pipelineId, ...input }) => {
      found(await op.ports.pipelines.get(pipelineId), "pipeline", pipelineId);
      const stage = await op.ports.pipelines.addStage(pipelineId, input);
      await audit(op, { operation: "stage.add", entityType: "pipeline", entityId: pipelineId, summary: `Added stage "${input.name}"` });
      return stage;
    },
  }),

  defineOperation({
    name: "stage.update",
    title: "Update stage",
    description: "Update a stage's name, color, probability or outcome.",
    input: z.object({
      id: zId,
      name: z.string().min(1).max(100).optional(),
      color: zSemanticColor.optional(),
      probability: z.number().int().min(0).max(100).nullish(),
      outcome: z.enum(["won", "lost", "done", "dropped"]).nullish(),
    }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id, ...patch }) => {
      found(await op.ports.pipelines.getStage(id), "stage", id);
      const stage = await op.ports.pipelines.updateStage(id, definedOnly(patch));
      await audit(op, { operation: "stage.update", entityType: "stage", entityId: id, summary: `Updated stage "${stage.name}"` });
      return stage;
    },
  }),

  defineOperation({
    name: "stage.reorder",
    title: "Reorder stages",
    description: "Persist a new stage order. Pass the full ordered list of stage ids for the pipeline.",
    input: z.object({ pipelineId: zId, stageIds: z.array(zId).min(1) }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { pipelineId, stageIds }) => {
      const pipeline = found(await op.ports.pipelines.get(pipelineId), "pipeline", pipelineId);
      if (new Set(stageIds).size !== pipeline.stages.length) {
        throw OpError.validation("stageIds must contain every stage of the pipeline exactly once");
      }
      await op.ports.pipelines.reorderStages(pipelineId, stageIds);
      await audit(op, { operation: "stage.reorder", entityType: "pipeline", entityId: pipelineId, summary: "Reordered stages" });
      return { ok: true };
    },
  }),

  defineOperation({
    name: "stage.delete",
    title: "Delete stage",
    description: "Delete a stage. Blocked while any record sits in it.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    preview: async ({ ports }, { id }) => ({ usage: await ports.pipelines.stageUsage(id) }),
    handler: async (op, { id }) => {
      const stage = found(await op.ports.pipelines.getStage(id), "stage", id);
      const usage = await op.ports.pipelines.stageUsage(id);
      if (usage > 0) throw OpError.inUse("stage", id, usage);
      await op.ports.pipelines.deleteStage(id);
      await audit(op, { operation: "stage.delete", entityType: "stage", entityId: id, summary: `Deleted stage "${stage.name}"` });
      return { deleted: id };
    },
  }),
];
