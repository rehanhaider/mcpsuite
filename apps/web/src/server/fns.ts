/**
 * The web adapter's entire server surface:
 *   - `op`      — run any catalog operation as the logged-in human
 *   - `whoami`  — session probe for the root route
 *   - `login` / `logout`
 *
 * Nothing else touches @emcp/db. Pages compose these via React Query.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRuntime, verifyUserPassword, hashPassword } from "@emcp/db";
import { currentSession, issueSession, requireContext, revokeSession } from "./session.ts";

/**
 * Op results carry `unknown` payloads which fail Start's compile-time
 * serializability check, so the result crosses the wire as a JSON string
 * and `callOp` parses it back into an OpResult.
 */
export const op = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().min(1), input: z.unknown().optional() }))
  .handler(({ data }): string => {
    const { ctx } = requireContext();
    return JSON.stringify(getRuntime().run(ctx, data.name, data.input ?? {}));
  });

export const whoami = createServerFn({ method: "GET" }).handler(() => {
  const session = currentSession();
  if (!session) return null;
  const runtime = getRuntime();
  const ports = runtime.portsFor(session.workspaceId);
  return {
    user: session.user,
    role: session.role,
    workspace: ports.workspace.get(),
    pendingApprovals: ports.pendingActions.countPending(),
  };
});

export const login = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.string().email(), password: z.string().min(1) }))
  .handler(({ data }) => {
    const runtime = getRuntime();
    const user = verifyUserPassword(runtime.db, data.email, data.password);
    if (!user) return { ok: false as const, error: "Invalid email or password" };
    issueSession(user.id);
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(() => {
  revokeSession();
  return { ok: true as const };
});

export const changePassword = createServerFn({ method: "POST" })
  .validator(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }))
  .handler(({ data }) => {
    const { session } = requireContext();
    const runtime = getRuntime();
    const user = verifyUserPassword(runtime.db, session.user.email, data.current);
    if (!user) return { ok: false as const, error: "Current password is incorrect" };
    const ports = runtime.portsFor(session.workspaceId);
    ports.users.setPassword(session.user.id, hashPassword(data.next));
    return { ok: true as const };
  });
