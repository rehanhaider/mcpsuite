/**
 * Cookie-backed session resolution for server functions. The session itself
 * lives in the sessions table (@mcpsuite/db) and links to the OpenAuth subject;
 * the cookie only carries the opaque token. HttpOnly, SameSite=Lax, Path=/,
 * host-only, Secure per X-Forwarded-Proto, 30-day expiry (matches the DB
 * row). Per-request resolution loads the CURRENT user/workspace/role/enabled
 * state — token claims are never authority (docs/auth-api.md).
 *
 * Runtime acquisition goes through the async DATABASE_URL adapter selection;
 * sessions go through the runtime's identity store, so they work on every
 * database adapter.
 */
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import { getRuntimeAsync, webContext, type AnyRuntime, type SessionLink, type SessionUser } from "@mcpsuite/db";
import type { RequestContext } from "@mcpsuite/core";

const COOKIE = "mcpsuite_session";
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

export async function currentSession(): Promise<SessionUser | null> {
  const runtime = await getRuntimeAsync();
  return runtime.identity.resolveSession(readSessionToken());
}

export async function requireContext(): Promise<{ ctx: RequestContext; session: SessionUser; runtime: AnyRuntime }> {
  const runtime = await getRuntimeAsync();
  const session = await runtime.identity.resolveSession(readSessionToken());
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return { ctx: webContext(session), session, runtime };
}

export async function issueSession(userId: string, link: SessionLink = {}): Promise<void> {
  const runtime = await getRuntimeAsync();
  const { token } = await runtime.identity.createSession(userId, link);
  setSessionCookie(token);
}

/** Logout: delete the session row (revokes its OpenAuth refresh token) + clear the cookie. */
export async function revokeSession(): Promise<void> {
  const token = readSessionToken();
  try {
    if (token) {
      const runtime = await getRuntimeAsync();
      await runtime.identity.destroySession(token);
    }
  } finally {
    // Clear the cookie even if the session could not be deleted.
    clearSessionCookie();
  }
}
