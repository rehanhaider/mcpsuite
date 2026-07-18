/**
 * Operation catalog assembly + executor.
 *
 * `runOperation` is the ONLY entry point adapters (web server functions,
 * /api/ops HTTP routes, MCP tools) may use. It applies, in order:
 * validation → role/scope authorization → approval gating → execution.
 */
import { z } from "zod";
import { OpError, toErrorPayload } from "./errors.ts";
import { nowIso } from "./ids.ts";
import { actorStamp, type RequestContext } from "./context.ts";
import type { Ports } from "./ports.ts";
import { roleAtLeast, trustAllows } from "./policy.ts";
import { defineOperation, type OpCtx, type OperationDef, type OpResult } from "./operations/define.ts";
import { companyOps } from "./operations/company-ops.ts";
import { personOps } from "./operations/person-ops.ts";
import { engagementOps } from "./operations/engagement-ops.ts";
import { dealOps } from "./operations/deal-ops.ts";
import { offeringOps } from "./operations/offering-ops.ts";
import { activityOps } from "./operations/activity-ops.ts";
import { pipelineOps } from "./operations/pipeline-ops.ts";
import { customFieldOps, savedViewOps, tagOps } from "./operations/meta-ops.ts";
import { listOps } from "./operations/list-ops.ts";
import { approvalOps, zApproveInput } from "./operations/approval-ops.ts";
import { bulkOps } from "./operations/bulk-ops.ts";
import { buildAdminOps, type AuthServices } from "./operations/admin-ops.ts";
import { buildDataOps, type CsvServices } from "./operations/data-ops.ts";
import { audit, found } from "./operations/helpers.ts";

export interface CatalogDeps {
  auth: AuthServices;
  csv: CsvServices;
}

export type Catalog = Map<string, OperationDef>;

const PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function buildCatalog(deps: CatalogDeps): Catalog {
  const ops: OperationDef[] = [
    ...companyOps,
    ...personOps,
    ...engagementOps,
    ...dealOps,
    ...offeringOps,
    ...activityOps,
    ...pipelineOps,
    ...tagOps,
    ...listOps,
    ...customFieldOps,
    ...savedViewOps,
    ...approvalOps,
    ...bulkOps,
    ...buildAdminOps(deps.auth),
    ...buildDataOps(deps.csv),
  ] as OperationDef[];

  const catalog: Catalog = new Map();
  for (const op of ops) {
    if (catalog.has(op.name)) throw new Error(`Duplicate operation name: ${op.name}`);
    catalog.set(op.name, op);
  }

  // pendingAction.approve re-dispatches stored operations, so it is defined
  // here with catalog access.
  const approve = defineOperation({
    name: "pendingAction.approve",
    title: "Approve pending action",
    description: "Approve a pending action and execute the stored operation. Requires admin.",
    input: zApproveInput,
    minRole: "admin",
    scope: "approvals",
    handler: (op, { id, note }) => {
      const pa = found(op.ports.pendingActions.get(id), "pending action", id);
      if (pa.status !== "pending") throw OpError.validation(`Action is already ${pa.status}`);
      if (op.ctx.actorType === "agent" && pa.requestedByClientId && pa.requestedByClientId === op.ctx.clientId) {
        throw OpError.forbidden("An agent cannot approve its own pending actions");
      }
      if (pa.expiresAt < nowIso()) {
        op.ports.pendingActions.setStatus(id, { status: "cancelled", reviewNote: "expired" });
        throw OpError.validation("This pending action has expired; ask the agent to retry");
      }
      const target = catalog.get(pa.operation);
      if (!target) throw OpError.validation(`Operation ${pa.operation} no longer exists`);

      // Execute as the approving human, bypassing the approval gate.
      let result: unknown;
      try {
        const parsed = target.input.parse(pa.input);
        result = op.ports.tx(() => target.handler(op, parsed));
      } catch (e) {
        op.ports.pendingActions.setStatus(id, {
          status: "failed",
          reviewedByUserId: op.ctx.userId,
          reviewNote: note ?? null,
          result: { error: toErrorPayload(e) as unknown as Record<string, unknown> },
        });
        audit(op, {
          operation: "pendingAction.approve",
          entityType: "pending_action",
          entityId: id,
          summary: `Approved ${pa.operation} but execution FAILED`,
          meta: { error: toErrorPayload(e) },
        });
        throw e;
      }
      const updated = op.ports.pendingActions.setStatus(id, {
        status: "approved",
        reviewedByUserId: op.ctx.userId,
        reviewNote: note ?? null,
        result: { data: result } as Record<string, unknown>,
      });
      audit(op, {
        operation: "pendingAction.approve",
        entityType: "pending_action",
        entityId: id,
        summary: `Approved and executed ${pa.operation}`,
        meta: { requestedBy: pa.requestedByClientId ?? pa.requestedByUserId },
      });
      return { pendingAction: updated, result };
    },
  });
  catalog.set(approve.name, approve as OperationDef);

  return catalog;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function authorize(op: OperationDef, ctx: RequestContext): void {
  if (ctx.actorType === "human" || ctx.actorType === "system") {
    if (!roleAtLeast(ctx.role, op.minRole)) {
      throw OpError.forbidden(`Requires role ${op.minRole}+ (you are ${ctx.role})`);
    }
    return;
  }
  // Agents: scope gates reachability. The role floor only hard-blocks
  // non-risky operations — risky ones fall through to the approval gate,
  // where the approving human supplies the missing authority.
  if (!ctx.scopes.includes(op.scope)) {
    throw OpError.forbidden(`Requires MCP scope "${op.scope}" (client has: ${ctx.scopes.join(", ")})`);
  }
  if (!op.risk && !roleAtLeast(ctx.role, op.minRole)) {
    throw OpError.forbidden(`Requires role ${op.minRole}+`);
  }
}

function needsApproval(op: OperationDef, ctx: RequestContext): boolean {
  if (!op.risk) return false;
  if (ctx.actorType !== "agent") return false;
  // Below the role floor → always route through a human, regardless of trust.
  if (!roleAtLeast(ctx.role, op.minRole)) return true;
  return !trustAllows(ctx.trust, op.risk);
}

export function runOperation(catalog: Catalog, ports: Ports, ctx: RequestContext, name: string, rawInput: unknown): OpResult {
  const op = catalog.get(name);
  if (!op) return { status: "error", error: { code: "not_found", message: `Unknown operation "${name}"` } };

  let input: unknown;
  try {
    input = op.input.parse(rawInput ?? {});
  } catch (e) {
    if (e instanceof z.ZodError) {
      return {
        status: "error",
        error: {
          code: "validation",
          message: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
          details: { issues: e.issues.slice(0, 10) as unknown as Record<string, unknown>[] } as unknown as Record<
            string,
            unknown
          >,
        },
      };
    }
    return { status: "error", error: toErrorPayload(e) };
  }

  const opCtx: OpCtx = { ctx, ports };

  try {
    authorize(op, ctx);

    if (needsApproval(op, ctx)) {
      let preview: Record<string, unknown> | null = null;
      try {
        preview = op.preview ? op.preview(opCtx, input) : null;
      } catch {
        preview = null;
      }
      const pa = ports.pendingActions.create({
        operation: op.name,
        input: input as Record<string, unknown>,
        preview,
        riskCategory: op.risk!,
        actor: actorStamp(ctx),
        expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString(),
      });
      ports.audit.record(
        {
          operation: "pendingAction.create",
          entityType: "pending_action",
          entityId: pa.id,
          summary: `Agent requested approval for ${op.name}`,
          meta: { risk: op.risk },
        },
        actorStamp(ctx),
      );
      return {
        status: "pending_approval",
        pendingActionId: pa.id,
        operation: op.name,
        riskCategory: op.risk!,
        preview,
        message: `This ${op.risk} operation needs human approval. Pending action ${pa.id} was created — a human can approve it in the web UI (Approvals) or via pendingAction.approve.`,
      };
    }

    const data = ports.tx(() => op.handler(opCtx, input));
    return { status: "ok", data };
  } catch (e) {
    return { status: "error", error: toErrorPayload(e) };
  }
}
