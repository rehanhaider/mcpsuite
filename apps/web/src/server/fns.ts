/**
 * The web adapter's entire server surface:
 *   - `op`      — run any catalog operation as the logged-in human
 *   - `whoami`  — session probe for the root route
 *   - `login` / `logout`
 *
 * Nothing else touches @emcp/db. Pages compose these via React Query.
 * Runtime acquisition awaits the DATABASE_URL adapter selection
 * (`getRuntimeAsync`); password accounts and cookie sessions live in the
 * SQLite store, so under another adapter these surfaces answer
 * unauthenticated (hosted sign-in is a separate surface).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getRuntimeAsync,
  hashPassword,
  resolveWorkspaceAccess,
  verifyUserPassword,
  workspaceLockedResult,
  WORKSPACE_LOCKED_MESSAGE,
} from "@emcp/db";
import { currentSession, issueSession, requireContext, revokeSession } from "./session.ts";

/**
 * Op results carry `unknown` payloads which fail Start's compile-time
 * serializability check, so the result crosses the wire as a JSON string
 * and `callOp` parses it back into an OpResult.
 */
export const op = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().min(1), input: z.unknown().optional() }))
  .handler(async ({ data }): Promise<string> => {
    const { ctx, runtime } = await requireContext();
    // Hosted access gate: a locked workspace refuses every catalog operation.
    if (resolveWorkspaceAccess(runtime.db, ctx.workspaceId).mode === "locked") {
      return JSON.stringify(workspaceLockedResult());
    }
    return JSON.stringify(await runtime.run(ctx, data.name, data.input ?? {}));
  });

export const whoami = createServerFn({ method: "GET" }).handler(async () => {
  const session = await currentSession();
  if (!session) return null;
  const runtime = await getRuntimeAsync();
  if (runtime.adapter !== "sqlite") return null; // sessions only resolve on the SQLite adapter
  const ports = runtime.portsFor(session.workspaceId);
  // Always reported so the UI can react (self-host resolves as active).
  const access = resolveWorkspaceAccess(runtime.db, session.workspaceId);
  return {
    user: session.user,
    role: session.role,
    workspace: await ports.workspace.get(),
    pendingApprovals: access.mode === "locked" ? 0 : await ports.pendingActions.countPending(),
    access,
  };
});

export const login = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.string().email(), password: z.string().min(1) }))
  .handler(async ({ data }) => {
    const runtime = await getRuntimeAsync();
    if (runtime.adapter !== "sqlite") {
      // Password accounts live in the SQLite store; hosted sign-in is separate.
      return { ok: false as const, error: "Password sign-in is not available on this deployment" };
    }
    const user = verifyUserPassword(runtime.db, data.email, data.password);
    if (!user) return { ok: false as const, error: "Invalid email or password" };
    await issueSession(user.id);
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  await revokeSession();
  return { ok: true as const };
});

export const changePassword = createServerFn({ method: "POST" })
  .validator(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }))
  .handler(async ({ data }) => {
    const { session, runtime } = await requireContext();
    if (resolveWorkspaceAccess(runtime.db, session.workspaceId).mode === "locked") {
      return { ok: false as const, error: WORKSPACE_LOCKED_MESSAGE };
    }
    const user = verifyUserPassword(runtime.db, session.user.email, data.current);
    if (!user) return { ok: false as const, error: "Current password is incorrect" };
    const ports = runtime.portsFor(session.workspaceId);
    await ports.users.setPassword(session.user.id, hashPassword(data.next));
    return { ok: true as const };
  });
