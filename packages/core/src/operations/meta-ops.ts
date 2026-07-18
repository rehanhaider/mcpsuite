/** Tags, custom fields, saved views. */
import { z } from "zod";
import { OpError } from "../errors.ts";
import { slugify } from "../ids.ts";
import {
  CUSTOM_FIELD_TYPES_ENTITIES,
  validateCustomFieldValue,
  zActivityFilter,
  zCompanyFilter,
  zCustomFieldCreate,
  zCustomFieldSetValues,
  zCustomFieldUpdate,
  zDealFilter,
  zEngagementFilter,
  zId,
  zPersonFilter,
  zSavedViewCreate,
  zSemanticColor,
  zTagApply,
  zTagCreate,
  type CustomFieldValue,
} from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, definedOnly, found } from "./helpers.ts";

export const tagOps = [
  defineOperation({
    name: "tag.list",
    title: "List tags",
    description: "List workspace tags with usage counts.",
    input: z.object({}),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }) => ports.tags.list(),
  }),

  defineOperation({
    name: "tag.create",
    title: "Create tag",
    description: "Create a tag (loose label). Names are unique per workspace; returns the existing tag when the name already exists.",
    input: zTagCreate,
    minRole: "member",
    scope: "write",
    handler: async (op, input) => {
      const existing = await op.ports.tags.getByName(input.name.trim());
      if (existing) return existing;
      const tag = await op.ports.tags.create({ name: input.name.trim(), color: input.color });
      await audit(op, { operation: "tag.create", entityType: "tag", entityId: tag.id, summary: `Created tag "${tag.name}"` });
      return tag;
    },
  }),

  defineOperation({
    name: "tag.update",
    title: "Update tag",
    description: "Rename or recolor a tag.",
    input: z.object({ id: zId, name: z.string().min(1).max(80).optional(), color: zSemanticColor.optional() }),
    minRole: "member",
    scope: "write",
    handler: async (op, { id, ...patch }) => {
      found(await op.ports.tags.get(id), "tag", id);
      const tag = await op.ports.tags.update(id, definedOnly(patch));
      await audit(op, { operation: "tag.update", entityType: "tag", entityId: id, summary: `Updated tag "${tag.name}"` });
      return tag;
    },
  }),

  defineOperation({
    name: "tag.delete",
    title: "Delete tag",
    description: "Delete a tag and detach it from every record. Configuration change — gated for agents.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "write",
    risk: "config",
    preview: async ({ ports }, { id }) => {
      const t = (await ports.tags.list()).find((x) => x.id === id);
      return { tag: t ? { name: t.name, usage: t.usage } : null };
    },
    handler: async (op, { id }) => {
      const tag = found(await op.ports.tags.get(id), "tag", id);
      await op.ports.tags.delete(id);
      await audit(op, { operation: "tag.delete", entityType: "tag", entityId: id, summary: `Deleted tag "${tag.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "tag.apply",
    title: "Apply tag",
    description: "Attach a tag to a company, person, engagement or deal.",
    input: zTagApply,
    minRole: "member",
    scope: "write",
    handler: async (op, { tagId, entityType, entityId }) => {
      found(await op.ports.tags.get(tagId), "tag", tagId);
      await op.ports.tags.apply(tagId, entityType, entityId);
      return { ok: true };
    },
  }),

  defineOperation({
    name: "tag.remove",
    title: "Remove tag",
    description: "Detach a tag from a record.",
    input: zTagApply,
    minRole: "member",
    scope: "write",
    handler: async (op, { tagId, entityType, entityId }) => {
      await op.ports.tags.remove(tagId, entityType, entityId);
      return { ok: true };
    },
  }),
];

export const customFieldOps = [
  defineOperation({
    name: "customField.list",
    title: "List custom field definitions",
    description: "List typed custom field definitions, optionally per entity type.",
    input: z.object({
      entityType: z.enum(CUSTOM_FIELD_TYPES_ENTITIES).optional(),
      includeArchived: z.boolean().default(false),
    }),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { entityType, includeArchived }) => ports.customFields.listDefs(entityType, includeArchived),
  }),

  defineOperation({
    name: "customField.create",
    title: "Create custom field",
    description:
      "Create a typed custom field definition (text/number/boolean/date/select/multi_select/url/email). Configuration change — gated for agents.",
    input: zCustomFieldCreate,
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, input) => {
      if ((input.type === "select" || input.type === "multi_select") && !input.options?.length) {
        throw OpError.validation("Select fields need at least one option");
      }
      const key = slugify(input.label);
      if (!key) throw OpError.validation("Label must contain letters or numbers");
      if (await op.ports.customFields.getDefByKey(input.entityType, key)) {
        throw new OpError("conflict", `A ${input.entityType} field with key "${key}" already exists`);
      }
      const def = await op.ports.customFields.createDef({
        entityType: input.entityType,
        key,
        label: input.label,
        type: input.type,
        options: input.options ?? null,
        required: input.required,
      });
      await audit(op, {
        operation: "customField.create",
        entityType: "custom_field",
        entityId: def.id,
        summary: `Created ${input.entityType} field "${input.label}"`,
      });
      return def;
    },
  }),

  defineOperation({
    name: "customField.update",
    title: "Update custom field",
    description: "Update a custom field's label, options or required flag (type and key are immutable).",
    input: zCustomFieldUpdate,
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id, ...patch }) => {
      const def = found(await op.ports.customFields.getDef(id), "custom field", id);
      if ((def.type === "select" || def.type === "multi_select") && patch.options !== undefined && !patch.options?.length) {
        throw OpError.validation("Select fields need at least one option");
      }
      const updated = await op.ports.customFields.updateDef(id, definedOnly(patch));
      await audit(op, {
        operation: "customField.update",
        entityType: "custom_field",
        entityId: id,
        summary: `Updated field "${updated.label}"`,
      });
      return updated;
    },
  }),

  defineOperation({
    name: "customField.archive",
    title: "Archive custom field",
    description: "Archive a custom field definition. Existing values are kept but hidden.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id }) => {
      found(await op.ports.customFields.getDef(id), "custom field", id);
      const def = await op.ports.customFields.setDefArchived(id, true);
      await audit(op, { operation: "customField.archive", entityType: "custom_field", entityId: id, summary: `Archived field "${def.label}"` });
      return def;
    },
  }),

  defineOperation({
    name: "customField.restore",
    title: "Restore custom field",
    description: "Restore an archived custom field definition.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "admin",
    risk: "config",
    handler: async (op, { id }) => {
      found(await op.ports.customFields.getDef(id), "custom field", id);
      const def = await op.ports.customFields.setDefArchived(id, false);
      await audit(op, { operation: "customField.restore", entityType: "custom_field", entityId: id, summary: `Restored field "${def.label}"` });
      return def;
    },
  }),

  defineOperation({
    name: "customField.setValues",
    title: "Set custom field values",
    description: "Set one or more custom field values on a record. Values are validated against the field type; null clears.",
    input: zCustomFieldSetValues,
    minRole: "member",
    scope: "write",
    handler: async (op, { entityType, entityId, values }) => {
      // Validate the target record exists.
      const port = {
        company: () => op.ports.companies.get(entityId),
        person: () => op.ports.people.get(entityId),
        engagement: () => op.ports.engagements.get(entityId),
        deal: () => op.ports.deals.get(entityId),
        offering: () => op.ports.offerings.get(entityId),
      }[entityType];
      found(await port(), entityType, entityId);

      const results: Record<string, CustomFieldValue> = {};
      for (const [key, raw] of Object.entries(values)) {
        const def = await op.ports.customFields.getDefByKey(entityType, key);
        if (!def) throw OpError.validation(`No ${entityType} custom field with key "${key}"`);
        let value: CustomFieldValue;
        try {
          value = validateCustomFieldValue(def, raw as CustomFieldValue);
        } catch (e) {
          throw OpError.validation(e instanceof Error ? e.message : String(e), { field: key });
        }
        await op.ports.customFields.setValue(def.id, entityType, entityId, value);
        results[key] = value;
      }
      await audit(op, {
        operation: "customField.setValues",
        entityType,
        entityId,
        summary: `Set custom fields: ${Object.keys(values).join(", ")}`,
      });
      return { entityType, entityId, values: results };
    },
  }),
];

export const savedViewOps = [
  defineOperation({
    name: "savedView.list",
    title: "List saved views",
    description: "List saved views visible to the current actor (own private views + shared + system).",
    input: z.object({}),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports, ctx }) => ports.savedViews.list(ctx.userId),
  }),

  defineOperation({
    name: "savedView.create",
    title: "Create saved view",
    description: "Save a filter set as a named view (private or shared). Filters must match the entity's list filter shape.",
    input: zSavedViewCreate,
    minRole: "member",
    scope: "write",
    handler: async (op, input) => {
      const filters = parseFilters(input.entityType, input.filters) as Record<string, unknown>;
      const view = await op.ports.savedViews.create({ ...input, filters, ownerUserId: op.ctx.userId });
      await audit(op, { operation: "savedView.create", entityType: "saved_view", entityId: view.id, summary: `Saved view "${view.name}"` });
      return view;
    },
  }),

  defineOperation({
    name: "savedView.update",
    title: "Update saved view",
    description: "Rename a view or replace its filters/visibility.",
    input: z.object({
      id: zId,
      name: z.string().min(1).max(120).optional(),
      filters: z.record(z.unknown()).optional(),
      visibility: z.enum(["private", "shared"]).optional(),
    }),
    minRole: "member",
    scope: "write",
    handler: async (op, { id, ...patch }) => {
      const view = found(await op.ports.savedViews.get(id), "saved view", id);
      if (view.visibility === "system") throw OpError.validation("System views cannot be edited");
      if (view.visibility === "private" && view.ownerUserId !== op.ctx.userId && op.ctx.role !== "owner" && op.ctx.role !== "admin") {
        throw OpError.forbidden("Not your view");
      }
      return op.ports.savedViews.update(id, definedOnly(patch));
    },
  }),

  defineOperation({
    name: "savedView.delete",
    title: "Delete saved view",
    description: "Delete a saved view.",
    input: z.object({ id: zId }),
    minRole: "member",
    scope: "write",
    handler: async (op, { id }) => {
      const view = found(await op.ports.savedViews.get(id), "saved view", id);
      if (view.visibility === "system") throw OpError.validation("System views cannot be deleted");
      if (view.visibility === "private" && view.ownerUserId !== op.ctx.userId && op.ctx.role !== "owner" && op.ctx.role !== "admin") {
        throw OpError.forbidden("Not your view");
      }
      await op.ports.savedViews.delete(id);
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "savedView.run",
    title: "Run saved view",
    description: "Execute a saved view and return the matching records.",
    input: z.object({ id: zId, limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }),
    minRole: "viewer",
    scope: "read",
    handler: async (op, { id, limit, offset }) => {
      const view = found(await op.ports.savedViews.get(id), "saved view", id);
      const filters = { ...view.filters, ...(limit ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) };
      switch (view.entityType) {
        case "company":
          return { view, result: await op.ports.companies.list(parseFilters("company", filters)) };
        case "person":
          return { view, result: await op.ports.people.list(parseFilters("person", filters)) };
        case "engagement":
          return { view, result: await op.ports.engagements.list(parseFilters("engagement", filters)) };
        case "deal":
          return { view, result: await op.ports.deals.list(parseFilters("deal", filters)) };
        case "activity":
          return { view, result: await op.ports.activities.list(parseFilters("activity", filters)) };
        default:
          throw OpError.validation(`Unknown view entity ${String(view.entityType)}`);
      }
    },
  }),
];

const FILTER_SCHEMAS = {
  company: zCompanyFilter,
  person: zPersonFilter,
  engagement: zEngagementFilter,
  deal: zDealFilter,
  activity: zActivityFilter,
} as const;

export function parseFilters<K extends keyof typeof FILTER_SCHEMAS>(
  entity: K,
  filters: Record<string, unknown>,
): z.infer<(typeof FILTER_SCHEMAS)[K]> {
  const parsed = FILTER_SCHEMAS[entity].safeParse(filters);
  if (!parsed.success) {
    throw OpError.validation(`Saved view filters invalid for ${entity}: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data as z.infer<(typeof FILTER_SCHEMAS)[K]>;
}
