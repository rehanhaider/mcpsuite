import { z } from "zod";
import { zId, zPersonCreate, zPersonFilter, zPersonUpdate, type Person } from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, checkVersion, definedOnly, found } from "./helpers.ts";

const zGet = z.object({ id: zId });

export const personOps = [
  defineOperation({
    name: "person.list",
    title: "List people",
    description: "List people with filters, sorting and pagination.",
    input: zPersonFilter,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, input) => ports.people.list(input),
  }),

  defineOperation({
    name: "person.get",
    title: "Get person",
    description: "Fetch one person by id, including company links, tags and custom field values.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const person = found(ports.people.get(id), "person", id);
      return {
        ...person,
        companies: ports.people.companies(id),
        tags: ports.tags.forEntity("person", id),
        customFields: ports.customFields.values("person", id),
      };
    },
  }),

  defineOperation({
    name: "person.create",
    title: "Create person",
    description: "Create a person. Only `name` is required; optionally link a company via companyId.",
    input: zPersonCreate,
    minRole: "member",
    scope: "write",
    handler: (op, { companyId, companyRole, ...input }) => {
      if (companyId) found(op.ports.companies.get(companyId), "company", companyId);
      const person = op.ports.people.create({
        ...input,
        ownerUserId: input.ownerUserId ?? op.ctx.userId,
      } as Partial<Person> & { name: string });
      if (companyId) {
        op.ports.people.link({
          companyId,
          personId: person.id,
          roleTitle: companyRole ?? input.title ?? null,
          isPrimary: true,
        });
      }
      audit(op, {
        operation: "person.create",
        entityType: "person",
        entityId: person.id,
        summary: `Created person "${person.name}"`,
      });
      return person;
    },
  }),

  defineOperation({
    name: "person.update",
    title: "Update person",
    description: "Patch person fields. Pass expectedVersion for optimistic concurrency.",
    input: zPersonUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion, ...patch }) => {
      const existing = found(op.ports.people.get(id), "person", id);
      checkVersion("person", id, existing.version, expectedVersion);
      const updated = op.ports.people.update(id, definedOnly(patch));
      audit(op, {
        operation: "person.update",
        entityType: "person",
        entityId: id,
        summary: `Updated person "${updated.name}"`,
        meta: { fields: Object.keys(definedOnly(patch)) },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "person.archive",
    title: "Archive person",
    description: "Archive (soft delete) a person.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.people.get(id), "person", id);
      const p = op.ports.people.setArchived(id, true);
      audit(op, { operation: "person.archive", entityType: "person", entityId: id, summary: `Archived person "${p.name}"` });
      return p;
    },
  }),

  defineOperation({
    name: "person.restore",
    title: "Restore person",
    description: "Restore an archived person.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.people.get(id), "person", id);
      const p = op.ports.people.setArchived(id, false);
      audit(op, { operation: "person.restore", entityType: "person", entityId: id, summary: `Restored person "${p.name}"` });
      return p;
    },
  }),

  defineOperation({
    name: "person.delete",
    title: "Hard-delete person",
    description: "Permanently delete a person. Irreversible; prefer person.archive.",
    input: zGet,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const p = ports.people.get(id);
      return { person: p ? { id: p.id, name: p.name } : null };
    },
    handler: (op, { id }) => {
      const p = found(op.ports.people.get(id), "person", id);
      op.ports.people.hardDelete(id);
      audit(op, { operation: "person.delete", entityType: "person", entityId: id, summary: `Hard-deleted person "${p.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "person.getContext",
    title: "Person context bundle",
    description:
      "Structured context for agents: the person, companies, engagements, deals they are involved in, recent activities and open tasks.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const person = found(ports.people.get(id), "person", id);
      const engagements = ports.engagements.list({
        personId: id,
        includeArchived: false,
        sort: "updatedAt",
        dir: "desc",
        limit: 25,
        offset: 0,
      });
      const deals = ports.deals.list({
        personId: id,
        includeArchived: false,
        sort: "updatedAt",
        dir: "desc",
        limit: 25,
        offset: 0,
      });
      const activities = ports.activities.list({ personId: id, limit: 25, offset: 0 });
      const openTasks = ports.activities.list({ personId: id, kind: "task", open: true, limit: 25, offset: 0 });
      return {
        person,
        companies: ports.people.companies(id),
        tags: ports.tags.forEntity("person", id),
        lists: ports.lists.forEntity("person", id),
        customFields: ports.customFields.values("person", id),
        engagements: engagements.items,
        deals: deals.items,
        recentActivities: activities.items,
        openTasks: openTasks.items,
      };
    },
  }),
];
