/**
 * Contact lists — curated audiences ("Job search", "Product X prospects",
 * "Q3 pipeline focus"). The agent-facing segmentation surface: an agent can
 * enumerate lists, read a list's members, and (de)assign contacts, leads and deals.
 *
 * Membership changes are deliberately NOT risk-gated: they're reversible
 * metadata with no data loss, and gating them would cripple the core agent
 * workflow ("file these 40 recruiters under Job search"). Deleting a list is
 * a config change and stays gated. Typed lists reject mismatched entity types.
 */
import { z } from "zod";
import { OpError } from "../errors.ts";
import type { ListableType } from "../domain.ts";
import { zListCreate, zListMembers, zListUpdate, zId, zLimit, zOffset, LISTABLE_TYPES } from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, definedOnly, found } from "./helpers.ts";

const ENTITY_LABELS: Record<ListableType, string> = {
  person: "people",
  company: "companies",
  engagement: "leads",
  deal: "deals",
};

export const listOps = [
  defineOperation({
    name: "list.list",
    title: "List contact lists",
    description: "All contact lists (segments) with per-entity-type membership counts.",
    input: z.object({}),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }) => ports.lists.list(),
  }),

  defineOperation({
    name: "list.get",
    title: "Get contact list",
    description: "One contact list with its membership counts.",
    input: z.object({ id: zId }),
    minRole: "viewer",
    scope: "read",
    handler: async ({ ports }, { id }) => {
      found(await ports.lists.get(id), "list", id);
      const withCounts = (await ports.lists.list()).find((l) => l.id === id);
      return withCounts!;
    },
  }),

  defineOperation({
    name: "list.create",
    title: "Create contact list",
    description:
      'Create a contact list (audience/segment, e.g. "Job search — recruiters"). Pass entityType when the audience is homogeneous. Names are unique; returns the existing list on a name match.',
    input: zListCreate,
    minRole: "member",
    scope: "write",
    handler: async (op, input) => {
      const name = input.name.trim();
      const requested = input.entityType ?? null;
      const existing = await op.ports.lists.getByName(name);
      if (existing) {
        if (existing.entityType && requested && existing.entityType !== requested) {
          throw OpError.validation(
            `List "${existing.name}" already exists as a ${ENTITY_LABELS[existing.entityType]}-only list`,
          );
        }
        return existing;
      }
      const list = await op.ports.lists.create({
        name,
        description: input.description ?? null,
        color: input.color,
        entityType: requested,
      });
      await audit(op, { operation: "list.create", entityType: "list", entityId: list.id, summary: `Created list "${list.name}"` });
      return list;
    },
  }),

  defineOperation({
    name: "list.update",
    title: "Update contact list",
    description: "Rename, recolor, re-describe or retype a contact list. Retyping fails while conflicting members exist.",
    input: zListUpdate,
    minRole: "member",
    scope: "write",
    handler: async (op, { id, ...patch }) => {
      found(await op.ports.lists.get(id), "list", id);
      if (patch.entityType) {
        const counts = await op.ports.lists.memberTypeCounts(id);
        for (const [type, n] of Object.entries(counts)) {
          if (n > 0 && type !== patch.entityType) {
            throw OpError.validation(`List has ${n} ${ENTITY_LABELS[type as ListableType] ?? type} members; remove them before retyping`);
          }
        }
      }
      const list = await op.ports.lists.update(id, definedOnly(patch));
      await audit(op, { operation: "list.update", entityType: "list", entityId: id, summary: `Updated list "${list.name}"` });
      return list;
    },
  }),

  defineOperation({
    name: "list.delete",
    title: "Delete contact list",
    description: "Delete a contact list and detach every member (records themselves are untouched). Configuration change — gated for agents.",
    input: z.object({ id: zId }),
    minRole: "admin",
    scope: "write",
    risk: "config",
    preview: async ({ ports }, { id }) => {
      const l = (await ports.lists.list()).find((x) => x.id === id);
      return {
        list: l ? { name: l.name, people: l.people, companies: l.companies, engagements: l.engagements, deals: l.deals } : null,
      };
    },
    handler: async (op, { id }) => {
      const list = found(await op.ports.lists.get(id), "list", id);
      await op.ports.lists.delete(id);
      await audit(op, { operation: "list.delete", entityType: "list", entityId: id, summary: `Deleted list "${list.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "list.addMembers",
    title: "Add contacts to list",
    description: "Attach people, companies, leads or deals to a contact list (idempotent, up to 500 at a time). Typed lists reject mismatched entity types.",
    input: zListMembers,
    minRole: "member",
    scope: "write",
    handler: async (op, { listId, entityType, entityIds }) => {
      const list = found(await op.ports.lists.get(listId), "list", listId);
      if (list.entityType && list.entityType !== entityType) {
        throw OpError.validation(`List "${list.name}" holds ${list.entityType}s only`);
      }
      const port = {
        person: op.ports.people,
        company: op.ports.companies,
        engagement: op.ports.engagements,
        deal: op.ports.deals,
      }[entityType];
      const missing: string[] = [];
      for (const id of entityIds) {
        if (!(await port.get(id))) missing.push(id);
      }
      if (missing.length > 0) throw OpError.validation(`Unknown ${entityType} ids: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      const added = await op.ports.tx(() => op.ports.lists.addMembers(listId, entityType, entityIds));
      await audit(op, {
        operation: "list.addMembers",
        entityType: "list",
        entityId: listId,
        summary: `Added ${added} ${ENTITY_LABELS[entityType]} to list "${list.name}"`,
      });
      return { added, alreadyPresent: entityIds.length - added };
    },
  }),

  defineOperation({
    name: "list.removeMembers",
    title: "Remove contacts from list",
    description: "Detach people, companies, leads or deals from a contact list.",
    input: zListMembers,
    minRole: "member",
    scope: "write",
    handler: async (op, { listId, entityType, entityIds }) => {
      const list = found(await op.ports.lists.get(listId), "list", listId);
      const removed = await op.ports.tx(() => op.ports.lists.removeMembers(listId, entityType, entityIds));
      await audit(op, {
        operation: "list.removeMembers",
        entityType: "list",
        entityId: listId,
        summary: `Removed ${removed} ${ENTITY_LABELS[entityType]} from list "${list.name}"`,
      });
      return { removed };
    },
  }),

  defineOperation({
    name: "list.members",
    title: "List contact list members",
    description: "Members of a contact list — people, companies, leads and deals in one call, paginated per entity type. Typed lists only fetch their entity type.",
    input: z.object({
      id: zId,
      entityType: z.enum(LISTABLE_TYPES).optional(),
      limit: zLimit,
      offset: zOffset,
    }),
    minRole: "viewer",
    scope: "read",
    handler: async ({ ports }, { id, entityType, limit, offset }) => {
      const list = found(await ports.lists.get(id), "list", id);
      const want = (t: ListableType) => entityType === undefined || entityType === t;
      const typed = list.entityType;
      if (typed) {
        return {
          list,
          people:
            typed === "person" && want("person")
              ? await ports.people.list({ listId: id, includeArchived: false, sort: "name", dir: "asc", limit, offset })
              : null,
          companies:
            typed === "company" && want("company")
              ? await ports.companies.list({ listId: id, includeArchived: false, sort: "name", dir: "asc", limit, offset })
              : null,
          engagements:
            typed === "engagement" && want("engagement")
              ? await ports.engagements.list({ listId: id, includeArchived: false, sort: "updatedAt", dir: "desc", limit, offset })
              : null,
          deals:
            typed === "deal" && want("deal")
              ? await ports.deals.list({ listId: id, includeArchived: false, sort: "updatedAt", dir: "desc", limit, offset })
              : null,
        };
      }
      return {
        list,
        people: want("person")
          ? await ports.people.list({ listId: id, includeArchived: false, sort: "name", dir: "asc", limit, offset })
          : null,
        companies: want("company")
          ? await ports.companies.list({ listId: id, includeArchived: false, sort: "name", dir: "asc", limit, offset })
          : null,
        engagements: want("engagement")
          ? await ports.engagements.list({ listId: id, includeArchived: false, sort: "updatedAt", dir: "desc", limit, offset })
          : null,
        deals: want("deal")
          ? await ports.deals.list({ listId: id, includeArchived: false, sort: "updatedAt", dir: "desc", limit, offset })
          : null,
      };
    },
  }),
];
