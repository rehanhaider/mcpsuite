import { z } from "zod";
import {
  zCompanyCreate,
  zCompanyFilter,
  zCompanyUpdate,
  zCompanyPersonLink,
  zId,
  type Company,
} from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, checkVersion, definedOnly, found } from "./helpers.ts";
import { actorStamp } from "../context.ts";

const zArchiveInput = z.object({ id: zId });
const zGetInput = z.object({ id: zId });

export const companyOps = [
  defineOperation({
    name: "company.list",
    title: "List companies",
    description: "List companies with filters, sorting and pagination.",
    input: zCompanyFilter,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, input) => ports.companies.list(input),
  }),

  defineOperation({
    name: "company.get",
    title: "Get company",
    description: "Fetch one company by id, including linked people, tags and custom field values.",
    input: zGetInput,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const company = found(ports.companies.get(id), "company", id);
      return {
        ...company,
        people: ports.companies.people(id),
        tags: ports.tags.forEntity("company", id),
        customFields: ports.customFields.values("company", id),
      };
    },
  }),

  defineOperation({
    name: "company.create",
    title: "Create company",
    description: "Create a company. Only `name` is required.",
    input: zCompanyCreate,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      const company = op.ports.companies.create({
        ...input,
        ownerUserId: input.ownerUserId ?? op.ctx.userId,
      } as Partial<Company> & { name: string });
      audit(op, {
        operation: "company.create",
        entityType: "company",
        entityId: company.id,
        summary: `Created company "${company.name}"`,
      });
      return company;
    },
  }),

  defineOperation({
    name: "company.update",
    title: "Update company",
    description: "Patch company fields. Pass expectedVersion for optimistic concurrency.",
    input: zCompanyUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion, ...patch }) => {
      const existing = found(op.ports.companies.get(id), "company", id);
      checkVersion("company", id, existing.version, expectedVersion);
      const updated = op.ports.companies.update(id, definedOnly(patch));
      audit(op, {
        operation: "company.update",
        entityType: "company",
        entityId: id,
        summary: `Updated company "${updated.name}"`,
        meta: { fields: Object.keys(definedOnly(patch)) },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "company.archive",
    title: "Archive company",
    description: "Archive (soft delete) a company. It disappears from normal views but stays searchable by admins.",
    input: zArchiveInput,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.companies.get(id), "company", id);
      const c = op.ports.companies.setArchived(id, true);
      audit(op, { operation: "company.archive", entityType: "company", entityId: id, summary: `Archived company "${c.name}"` });
      return c;
    },
  }),

  defineOperation({
    name: "company.restore",
    title: "Restore company",
    description: "Restore an archived company.",
    input: zArchiveInput,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.companies.get(id), "company", id);
      const c = op.ports.companies.setArchived(id, false);
      audit(op, { operation: "company.restore", entityType: "company", entityId: id, summary: `Restored company "${c.name}"` });
      return c;
    },
  }),

  defineOperation({
    name: "company.delete",
    title: "Hard-delete company",
    description:
      "Permanently delete a company and its links. Irreversible. Prefer company.archive. Requires admin; agents need approval unless fully authorized.",
    input: zArchiveInput,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const c = ports.companies.get(id);
      return { company: c ? { id: c.id, name: c.name } : null, linkedPeople: c ? ports.companies.people(id).length : 0 };
    },
    handler: (op, { id }) => {
      const c = found(op.ports.companies.get(id), "company", id);
      op.ports.companies.hardDelete(id);
      audit(op, { operation: "company.delete", entityType: "company", entityId: id, summary: `Hard-deleted company "${c.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "company.linkPerson",
    title: "Link person to company",
    description: "Create or update the typed relationship between a person and a company.",
    input: zCompanyPersonLink,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      found(op.ports.companies.get(input.companyId), "company", input.companyId);
      found(op.ports.people.get(input.personId), "person", input.personId);
      const link = op.ports.people.link(input);
      audit(op, {
        operation: "company.linkPerson",
        entityType: "company",
        entityId: input.companyId,
        summary: `Linked person to company`,
        meta: { personId: input.personId },
      });
      return link;
    },
  }),

  defineOperation({
    name: "company.unlinkPerson",
    title: "Unlink person from company",
    description: "Remove the relationship between a person and a company.",
    input: z.object({ companyId: zId, personId: zId }),
    minRole: "member",
    scope: "write",
    handler: (op, { companyId, personId }) => {
      op.ports.people.unlink(companyId, personId);
      audit(op, {
        operation: "company.unlinkPerson",
        entityType: "company",
        entityId: companyId,
        summary: "Unlinked person from company",
        meta: { personId },
      });
      return { ok: true };
    },
  }),

  defineOperation({
    name: "company.getContext",
    title: "Company context bundle",
    description:
      "Structured context bundle for agents: the company, linked people, open engagements and deals, recent activities, and open tasks.",
    input: zGetInput,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports, ctx }, { id }) => {
      const company = found(ports.companies.get(id), "company", id);
      const engagements = ports.engagements.list({
        companyId: id,
        includeArchived: false,
        sort: "updatedAt",
        dir: "desc",
        limit: 25,
        offset: 0,
      });
      const deals = ports.deals.list({
        companyId: id,
        includeArchived: false,
        sort: "updatedAt",
        dir: "desc",
        limit: 25,
        offset: 0,
      });
      const activities = ports.activities.list({ companyId: id, limit: 25, offset: 0 });
      const openTasks = ports.activities.list({ companyId: id, kind: "task", open: true, limit: 25, offset: 0 });
      return {
        company,
        people: ports.companies.people(id),
        tags: ports.tags.forEntity("company", id),
        lists: ports.lists.forEntity("company", id),
        customFields: ports.customFields.values("company", id),
        engagements: engagements.items,
        deals: deals.items,
        recentActivities: activities.items,
        openTasks: openTasks.items,
        workspaceId: ctx.workspaceId,
      };
    },
  }),
];
