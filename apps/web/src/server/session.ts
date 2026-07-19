/**
 * Cookie-backed session resolution for server functions. The session itself
 * lives in the sessions table (@emcp/db) and links to the OpenAuth subject;
 * the cookie only carries the opaque token. HttpOnly, SameSite=Lax, Path=/,
 * host-only, Secure per X-Forwarded-Proto, 30-day expiry (matches the DB
 * row). Per-request resolution loads the CURRENT user/workspace/role/enabled
 * state — token claims are never authority (docs/auth-api.md).
 *
 * Runtime acquisition goes through the async DATABASE_URL adapter selection.
 * Cookie sessions (and their store) are SQLite-only; hosted identity is a
 * separate surface, so under the Postgres adapter every session resolves to
 * null and these helpers answer unauthenticated.
 */
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import {
  createSession,
  destroySession,
  getRuntimeAsync,
  resolveSession,
  webContext,
  type Runtime,
  type SessionLink,
  type SessionUser,
} from "@emcp/db";
import type { RequestContext } from "@emcp/core";

const COOKIE = "emcp_session";
const MAX_AGE = 30 * 24 * 60 * 60; // seconds — keep in sync with SESSION_TTL_MS

export function readSessionToken(): string | null {
  const header = getRequestHeader("cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === COOKIE) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** Secure iff the effective protocol is https — X-Forwarded-Proto decides (docs/auth-api.md). */
function requestIsSecure(): boolean {
  const forwarded = getRequestHeader("x-forwarded-proto");
  return forwarded ? forwarded.split(",")[0]!.trim() === "https" : false;
}

export function setSessionCookie(token: string): void {
  setResponseHeader(
    "Set-Cookie",
    [
      `${COOKIE}=${encodeURIComponent(token)}`,
      "HttpOnly",
      ...(requestIsSecure() ? ["Secure"] : []),
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${MAX_AGE}`,
    ].join("; "),
  );
}

export function clearSessionCookie(): void {
  setResponseHeader(
    "Set-Cookie",
    [`${COOKIE}=`, "HttpOnly", ...(requestIsSecure() ? ["Secure"] : []), "SameSite=Lax", "Path=/", "Max-Age=0"].join("; "),
  );
}

/** The SQLite runtime, or null when DATABASE_URL selected another adapter. */
export async function sessionRuntime(): Promise<Runtime | null> {
  const runtime = await getRuntimeAsync();
  return runtime.adapter === "sqlite" ? runtime : null;
}

export async function currentSession(): Promise<SessionUser | null> {
  const runtime = await sessionRuntime();
  return runtime ? resolveSession(runtime.db, readSessionToken()) : null;
}

export async function requireContext(): Promise<{ ctx: RequestContext; session: SessionUser; runtime: Runtime }> {
  const runtime = await sessionRuntime();
  const session = runtime ? resolveSession(runtime.db, readSessionToken()) : null;
  if (!runtime || !session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return { ctx: webContext(session), session, runtime };
}

export async function issueSession(userId: string, link: SessionLink = {}): Promise<void> {
  const runtime = await sessionRuntime();
  if (!runtime) throw new Error("Web sessions require the SQLite adapter (hosted sign-in is a separate surface)");
  const { token } = createSession(runtime.db, userId, link);
  setSessionCookie(token);
}

/** Logout: delete the session row (revokes its OpenAuth refresh token) + clear the cookie. */
export async function revokeSession(): Promise<void> {
  const token = readSessionToken();
  if (token) {
    const runtime = await sessionRuntime();
    if (runtime) destroySession(runtime.db, token);
  }
  clearSessionCookie();
}
