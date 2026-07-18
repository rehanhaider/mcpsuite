/**
 * Cookie-backed session resolution for server functions. The session itself
 * lives in the sessions table (@emcp/db); the cookie only carries the opaque
 * token. HttpOnly, SameSite=Lax, 30-day expiry (matches the DB row).
 */
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import { createSession, destroySession, getRuntime, resolveSession, webContext, type SessionUser } from "@emcp/db";
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

export function setSessionCookie(token: string): void {
  const secure = process.env.NODE_ENV === "production" && process.env.EMCP_INSECURE_COOKIE !== "1";
  setResponseHeader(
    "Set-Cookie",
    [
      `${COOKIE}=${encodeURIComponent(token)}`,
      "HttpOnly",
      ...(secure ? ["Secure"] : []),
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${MAX_AGE}`,
    ].join("; "),
  );
}

export function clearSessionCookie(): void {
  setResponseHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function currentSession(): SessionUser | null {
  return resolveSession(getRuntime().db, readSessionToken());
}

export function requireContext(): { ctx: RequestContext; session: SessionUser } {
  const session = currentSession();
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return { ctx: webContext(session), session };
}

export function issueSession(userId: string): void {
  const { token } = createSession(getRuntime().db, userId);
  setSessionCookie(token);
}

export function revokeSession(): void {
  const token = readSessionToken();
  if (token) destroySession(getRuntime().db, token);
  clearSessionCookie();
}
