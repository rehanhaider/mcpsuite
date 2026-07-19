/**
 * The web adapter's entire server surface:
 *   - `op`          — run any catalog operation as the logged-in human
 *   - `whoami`      — session probe for the root route
 *   - `login` / `logout`
 *   - `changePassword` — logged-in password change (OpenAuth storage)
 *   - `setPassword`    — redeem a setup/reset code (docs/auth-api.md)
 *
 * Nothing else touches @emcp/db. Pages compose these via React Query.
 * Authentication is the OpenAuth issuer mounted at /api/auth/* (see
 * src/server/auth-issuer.ts); these functions drive it in-process. Runtime
 * acquisition awaits the DATABASE_URL adapter selection (`getRuntimeAsync`);
 * cookie sessions live in the SQLite store, so under another adapter these
 * surfaces answer unauthenticated (hosted sign-in is a separate surface).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  redeemAuthCodeAndSetPassword,
  resolveWorkspaceAccess,
  setOpenAuthPassword,
  verifyOpenAuthPassword,
  workspaceLockedResult,
  WORKSPACE_LOCKED_MESSAGE,
} from "@emcp/db";
import { LOGIN_ERROR_MESSAGES, performPasswordLogin } from "./auth-issuer.ts";
import { currentSession, requireContext, sessionRuntime, setSessionCookie, revokeSession } from "./session.ts";

/**
 * Op results carry `unknown` payloads which fail Start's compile-time
 * serializability check, so the result crosses the wire as a JSON string
 * and `callOp` parses it back into an OpResult.
 *
 * Gates: a locked workspace refuses every catalog operation here; the
 * forced-password-change gate lives inside runtime.run itself so it covers
 * every surface (web, /api/ops, MCP) with the same typed error.
 */
export const op = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().min(1), input: z.unknown().optional() }))
  .handler(async ({ data }): Promise<string> => {
    const { ctx, runtime } = await requireContext();
    if (resolveWorkspaceAccess(runtime.db, ctx.workspaceId).mode === "locked") {
      return JSON.stringify(workspaceLockedResult());
    }
    return JSON.stringify(await runtime.run(ctx, data.name, data.input ?? {}));
  });

export const whoami = createServerFn({ method: "GET" }).handler(async () => {
  const session = await currentSession();
  if (!session) return null;
  const runtime = await sessionRuntime();
  if (!runtime) return null; // sessions only resolve on the SQLite adapter
  const ports = runtime.portsFor(session.workspaceId);
  // Always reported so the UI can react (self-host resolves as active).
  const access = resolveWorkspaceAccess(runtime.db, session.workspaceId);
  return {
    user: session.user,
    role: session.role,
    // While set, the web app must route to /set-password; every catalog
    // operation answers password_change_required until it is cleared.
    passwordMustChange: session.passwordMustChange,
    workspace: await ports.workspace.get(),
    pendingApprovals:
      access.mode === "locked" || session.passwordMustChange ? 0 : await ports.pendingActions.countPending(),
    access,
  };
});

/**
 * Password login through the in-process OpenAuth flow (docs/auth-api.md):
 * authorize → password/authorize → token exchange → subject → emcp_session.
 */
export const login = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.string().email(), password: z.string().min(1) }))
  .handler(async ({ data }) => {
    const runtime = await sessionRuntime();
    if (!runtime) {
      return { ok: false as const, error: "Password sign-in is not available on this deployment" };
    }
    const result = await performPasswordLogin(runtime.db, { email: data.email, password: data.password });
    if (!result.ok) return { ok: false as const, error: LOGIN_ERROR_MESSAGES[result.error] };
    setSessionCookie(result.sessionToken);
    return { ok: true as const, mustChangePassword: result.mustChangePassword };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  await revokeSession();
  return { ok: true as const };
});

/**
 * Logged-in password change against OpenAuth storage. Also the forced-change
 * screen's submit: it stays reachable while password_change_required blocks
 * the catalog, and clears the flag on success.
 */
export const changePassword = createServerFn({ method: "POST" })
  .validator(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }))
  .handler(async ({ data }) => {
    const { session, runtime } = await requireContext();
    if (resolveWorkspaceAccess(runtime.db, session.workspaceId).mode === "locked") {
      return { ok: false as const, error: WORKSPACE_LOCKED_MESSAGE };
    }
    if (!(await verifyOpenAuthPassword(runtime.db, session.user.email, data.current))) {
      return { ok: false as const, error: "Current password is incorrect" };
    }
    await setOpenAuthPassword(runtime.db, session.user.email, data.next);
    // A self-chosen password satisfies any forced-change requirement.
    await runtime.portsFor(session.workspaceId).credentials.mustChangePassword(session.user.id, false);
    return { ok: true as const };
  });

/**
 * Redeem a single-use setup/reset code and set the password in OpenAuth
 * storage (unauthenticated: the code is the proof). Activation and subject
 * binding still happen on the first login.
 */
export const setPassword = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.string().email(),
      code: z.string().min(4).max(64),
      purpose: z.enum(["setup", "reset"]),
      password: z.string().min(10).max(200),
    }),
  )
  .handler(async ({ data }) => {
    const runtime = await sessionRuntime();
    if (!runtime) {
      return { ok: false as const, error: "Password setup is not available on this deployment" };
    }
    const outcome = await redeemAuthCodeAndSetPassword(runtime.db, data);
    if (!outcome.ok) {
      const error =
        outcome.reason === "expired_code"
          ? "This code has expired — ask for a new one"
          : outcome.reason === "rate_limited"
            ? "Too many attempts — ask for a new code"
            : "Invalid email or code";
      return { ok: false as const, error };
    }
    return { ok: true as const };
  });
