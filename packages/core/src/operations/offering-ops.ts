import { z } from "zod";
import { zId, zOfferingCreate, zOfferingLinkInput, zOfferingUpdate, type Offering } from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, checkVersion, definedOnly, found } from "./helpers.ts";

const zGet = z.object({ id: zId });

export const offeringOps = [
  defineOperation({
    name: "offering.list",
    title: "List offerings",
    description: "List the workspace's offerings (products/services/packages you pitch or sell).",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { includeArchived }) => ports.offerings.list(includeArchived),
  }),

  defineOperation({
    name: "offering.get",
    title: "Get offering",
    description: "Fetch one offering including where it is linked.",
    input: zGet,
    minRole: "viewer",
    scope: "read",
    handler: ({ ports }, { id }) => {
      const offering = found(ports.offerings.get(id), "offering", id);
      return { ...offering, links: ports.offerings.linksForOffering(id), customFields: ports.customFields.values("offering", id) };
    },
  }),

  defineOperation({
    name: "offering.create",
    title: "Create offering",
    description: "Create an offering. Types: product, service, package, other.",
    input: zOfferingCreate,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      const offering = op.ports.offerings.create({
        ...input,
        ownerUserId: input.ownerUserId ?? op.ctx.userId,
      } as Partial<Offering> & { name: string; type: string });
      audit(op, {
        operation: "offering.create",
        entityType: "offering",
        entityId: offering.id,
        summary: `Created offering "${offering.name}"`,
      });
      return offering;
    },
  }),

  defineOperation({
    name: "offering.update",
    title: "Update offering",
    description: "Patch offering fields.",
    input: zOfferingUpdate,
    minRole: "member",
    scope: "write",
    handler: (op, { id, expectedVersion, ...patch }) => {
      const existing = found(op.ports.offerings.get(id), "offering", id);
      checkVersion("offering", id, existing.version, expectedVersion);
      const updated = op.ports.offerings.update(id, definedOnly(patch));
      audit(op, {
        operation: "offering.update",
        entityType: "offering",
        entityId: id,
        summary: `Updated offering "${updated.name}"`,
      });
      return updated;
    },
  }),

  defineOperation({
    name: "offering.archive",
    title: "Archive offering",
    description: "Archive (soft delete) an offering.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.offerings.get(id), "offering", id);
      const o = op.ports.offerings.setArchived(id, true);
      audit(op, { operation: "offering.archive", entityType: "offering", entityId: id, summary: `Archived offering "${o.name}"` });
      return o;
    },
  }),

  defineOperation({
    name: "offering.restore",
    title: "Restore offering",
    description: "Restore an archived offering.",
    input: zGet,
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      found(op.ports.offerings.get(id), "offering", id);
      const o = op.ports.offerings.setArchived(id, false);
      audit(op, { operation: "offering.restore", entityType: "offering", entityId: id, summary: `Restored offering "${o.name}"` });
      return o;
    },
  }),

  defineOperation({
    name: "offering.delete",
    title: "Hard-delete offering",
    description: "Permanently delete an offering and its links. Irreversible; prefer offering.archive.",
    input: zGet,
    minRole: "admin",
    scope: "write",
    risk: "destructive",
    preview: ({ ports }, { id }) => {
      const o = ports.offerings.get(id);
      return { offering: o ? { id: o.id, name: o.name } : null, links: o ? ports.offerings.linksForOffering(id).length : 0 };
    },
    handler: (op, { id }) => {
      const o = found(op.ports.offerings.get(id), "offering", id);
      op.ports.offerings.hardDelete(id);
      audit(op, { operation: "offering.delete", entityType: "offering", entityId: id, summary: `Hard-deleted offering "${o.name}"` });
      return { deleted: id };
    },
  }),

  defineOperation({
    name: "offering.link",
    title: "Link offering",
    description: "Link an offering to an engagement or deal, optionally with fit/note/primary metadata.",
    input: zOfferingLinkInput,
    minRole: "member",
    scope: "write",
    handler: (op, input) => {
      found(op.ports.offerings.get(input.offeringId), "offering", input.offeringId);
      if (input.entityType === "engagement") found(op.ports.engagements.get(input.entityId), "engagement", input.entityId);
      else found(op.ports.deals.get(input.entityId), "deal", input.entityId);
      const link = op.ports.offerings.link(input);
      audit(op, {
        operation: "offering.link",
        entityType: input.entityType,
        entityId: input.entityId,
        summary: `Linked offering`,
        meta: { offeringId: input.offeringId },
      });
      return link;
    },
  }),

  defineOperation({
    name: "offering.unlink",
    title: "Unlink offering",
    description: "Remove an offering link from an engagement or deal.",
    input: z.object({ offeringId: zId, entityType: z.enum(["engagement", "deal"]), entityId: zId }),
    minRole: "member",
    scope: "write",
    handler: (op, { offeringId, entityType, entityId }) => {
      op.ports.offerings.unlink(offeringId, entityType, entityId);
      audit(op, {
        operation: "offering.unlink",
        entityType,
        entityId,
        summary: "Unlinked offering",
        meta: { offeringId },
      });
      return { ok: true };
    },
  }),
];
