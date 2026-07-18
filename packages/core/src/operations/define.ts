import type { z } from "zod";
import type { RequestContext } from "../context.ts";
import type { Ports } from "../ports.ts";
import type { McpScope, RiskCategory, Role } from "../policy.ts";
import type { ErrorPayload } from "../errors.ts";

export interface OpCtx {
  ctx: RequestContext;
  ports: Ports;
}

export interface OperationDef<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  /** Dotted name, e.g. "company.create". MCP tool name = snake_cased. */
  name: string;
  title: string;
  description: string;
  input: I;
  /** Minimum human role. Agents additionally need `scope`. */
  minRole: Role;
  /** MCP scope required for agent actors. */
  scope: McpScope;
  /**
   * Risky operations create pending approvals for agent actors whose trust
   * profile does not clear the category. Humans with minRole run directly.
   */
  risk: RiskCategory | null;
  /** Hide from MCP tool generation (web/session-only ops). */
  mcpExpose: boolean;
  /**
   * Optional preview generator stored on pending actions.
   * Method syntax (not arrow property) on purpose: methods are bivariant, so
   * heterogeneous concrete defs remain assignable to OperationDef[].
   */
  preview?(op: OpCtx, input: z.infer<I>): Promise<Record<string, unknown>>;
  handler(op: OpCtx, input: z.infer<I>): Promise<O>;
}

// Written to accept any concrete OperationDef while keeping per-op inference.
// Handlers and previews are async by contract: returning a Promise is the only
// accepted shape, so a port call can never leak an unawaited Promise into an
// operation payload without the compiler complaining.
export function defineOperation<I extends z.ZodTypeAny, O>(def: {
  name: string;
  title: string;
  description: string;
  input: I;
  minRole: Role;
  scope: McpScope;
  risk?: RiskCategory | null;
  mcpExpose?: boolean;
  preview?: (op: OpCtx, input: z.infer<I>) => Promise<Record<string, unknown>>;
  handler: (op: OpCtx, input: z.infer<I>) => Promise<O>;
}): OperationDef<I, O> {
  return {
    risk: null,
    mcpExpose: true,
    ...def,
  } as OperationDef<I, O>;
}

/** Uniform result envelope, mapped by adapters to HTTP / MCP conventions. */
export type OpResult<T = unknown> =
  | { status: "ok"; data: T }
  | {
      status: "pending_approval";
      pendingActionId: string;
      operation: string;
      riskCategory: RiskCategory;
      preview: Record<string, unknown> | null;
      message: string;
    }
  | { status: "error"; error: ErrorPayload };
