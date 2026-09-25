import { runOperation, type Catalog, type OpResult, type Ports, type RequestContext } from "@mcpsuite/core";
import { passwordChangeRequiredResult } from "./auth.ts";
import type { IdentityStore } from "./identity.ts";

/**
 * Run a catalog operation behind the forced-password-change gate
 * (docs/issues/0022 addendum). While the flag is set, the op layer refuses
 * every catalog operation — for the user's own sessions AND for agents acting
 * on their behalf — with a stable typed error. Password change, logout and
 * whoami are not catalog operations, so they stay reachable. Both adapters'
 * runtimes route through here, so the gate cannot differ between them.
 */
export async function runGated(
  catalog: Catalog,
  identity: IdentityStore,
  portsFor: (workspaceId: string) => Ports,
  ctx: RequestContext,
  operation: string,
  input: unknown,
): Promise<OpResult> {
  if (ctx.userId && (await identity.passwordMustChange(ctx.workspaceId, ctx.userId))) {
    return passwordChangeRequiredResult();
  }
  return runOperation(catalog, portsFor(ctx.workspaceId), ctx, operation, input);
}
