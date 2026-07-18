/** Pending action review — the human (or explicitly authorized agent) side of the approval gate. */
import { z } from "zod";
import { OpError } from "../errors.ts";
import { zId, PENDING_STATUSES } from "../domain.ts";
import { defineOperation } from "./define.ts";
import { audit, found } from "./helpers.ts";

export const approvalOps = [
  defineOperation({
    name: "pendingAction.list",
    title: "List pending actions",
    description: "List approval requests (default: status=pending).",
    input: z.object({ status: z.enum(PENDING_STATUSES).optional().default("pending") }),
    minRole: "member",
    scope: "approvals",
    handler: ({ ports }, { status }) => ports.pendingActions.list(status),
  }),

  defineOperation({
    name: "pendingAction.get",
    title: "Get pending action",
    description: "Fetch one approval request with its stored input and preview.",
    input: z.object({ id: zId }),
    minRole: "member",
    scope: "approvals",
    handler: ({ ports }, { id }) => found(ports.pendingActions.get(id), "pending action", id),
  }),

  defineOperation({
    name: "pendingAction.reject",
    title: "Reject pending action",
    description: "Reject an approval request with an optional note.",
    input: z.object({ id: zId, note: z.string().max(2000).nullish() }),
    minRole: "admin",
    scope: "approvals",
    handler: (op, { id, note }) => {
      const pa = found(op.ports.pendingActions.get(id), "pending action", id);
      if (pa.status !== "pending") throw OpError.validation(`Action is already ${pa.status}`);
      const updated = op.ports.pendingActions.setStatus(id, {
        status: "rejected",
        reviewedByUserId: op.ctx.userId,
        reviewNote: note ?? null,
      });
      audit(op, {
        operation: "pendingAction.reject",
        entityType: "pending_action",
        entityId: id,
        summary: `Rejected pending ${pa.operation}`,
        meta: { note },
      });
      return updated;
    },
  }),

  defineOperation({
    name: "pendingAction.cancel",
    title: "Cancel pending action",
    description: "Cancel your own pending approval request.",
    input: z.object({ id: zId }),
    minRole: "member",
    scope: "write",
    handler: (op, { id }) => {
      const pa = found(op.ports.pendingActions.get(id), "pending action", id);
      if (pa.status !== "pending") throw OpError.validation(`Action is already ${pa.status}`);
      const isRequester =
        (op.ctx.clientId && pa.requestedByClientId === op.ctx.clientId) ||
        (op.ctx.userId && pa.requestedByUserId === op.ctx.userId);
      if (!isRequester && op.ctx.role !== "owner" && op.ctx.role !== "admin") {
        throw OpError.forbidden("Only the requester or an admin can cancel");
      }
      const updated = op.ports.pendingActions.setStatus(id, { status: "cancelled", reviewedByUserId: op.ctx.userId });
      audit(op, {
        operation: "pendingAction.cancel",
        entityType: "pending_action",
        entityId: id,
        summary: `Cancelled pending ${pa.operation}`,
      });
      return updated;
    },
  }),

  // NOTE: pendingAction.approve is defined in the executor module because it
  // needs to re-dispatch the stored operation through the catalog.
];

export const zApproveInput = z.object({ id: zId, note: z.string().max(2000).nullish() });
