/**
 * Identity resolution: web sessions (opaque token, SHA-256 at rest) and MCP
 * API keys → RequestContext. V1 is single-workspace; the workspace id comes
 * from the caller's membership / client row.
 *
 * Sessions are minted after a successful OpenAuth flow and link to the
 * OpenAuth SUBJECT (docs/auth-api.md). Per-request resolution always loads
 * the CURRENT user/workspace/role/enabled state from the database — token
 * claims are never authority.
 */
import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import {
  clampScopes,
  newId,
  nowIso,
  type McpScope,
  type OpResult,
  type RequestContext,
  type Role,
  type TrustProfile,
  type User,
  type UserStatus,
} from "@emcp/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { sha256Hex, verifyPassword } from "./services.ts";
import { invalidateRefreshToken } from "./openauth.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  user: User;
  workspaceId: string;
  role: Role;
  /** While true the op layer refuses everything except password change/logout/whoami. */
  passwordMustChange: boolean;
  /** The OpenAuth subject this session was minted for (null for pre-OpenAuth rows). */
  authSubject: string | null;
}

export interface SessionLink {
  /** OpenAuth subject the session belongs to. */
  authSubject?: string | null;
  /** OpenAuth refresh token to revoke on logout. */
  authRefresh?: string | null;
  /** Verified email — required (and only used) for user-less sessions. */
  email?: string | null;
}

/**
 * `userId: null` mints an UNPROVISIONED session (docs/auth-api.md §Hosted
 * open registration): the identity verified its email but its CRM user does
 * not exist yet. `resolveSession` adopts the user by email once hosted
 * provisioning creates it.
 */
export function createSession(db: Db, userId: string | null, link: SessionLink = {}): { token: string; expiresAt: string } {
  const token = `sess_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.insert(t.sessions)
    .values({
      id: newId(),
      tokenHash: sha256Hex(token),
      userId,
      email: link.email ? link.email.trim().toLowerCase() : null,
      authSubject: link.authSubject ?? null,
      authRefresh: link.authRefresh ?? null,
      expiresAt,
      createdAt: nowIso(),
    })
    .run();
  // Opportunistic cleanup of expired sessions.
  db.delete(t.sessions).where(lt(t.sessions.expiresAt, nowIso())).run();
  return { token, expiresAt };
}

/**
 * Logout: delete the session row and revoke the OpenAuth refresh token it was
 * minted with (where applicable).
 */
export function destroySession(db: Db, token: string): void {
  const row = db.select().from(t.sessions).where(eq(t.sessions.tokenHash, sha256Hex(token))).get();
  if (!row) return;
  db.delete(t.sessions).where(eq(t.sessions.id, row.id)).run();
  if (row.authRefresh) void invalidateRefreshToken(db, row.authRefresh);
}

/** A live session whose verified identity has no CRM user yet (pre-provisioning). */
export interface UnprovisionedSession {
  unprovisioned: true;
  email: string;
  authSubject: string | null;
}

export function isUnprovisionedSession(v: SessionUser | UnprovisionedSession): v is UnprovisionedSession {
  return (v as UnprovisionedSession).unprovisioned === true;
}

/**
 * Like `resolveSession`, but user-less sessions surface as
 * `UnprovisionedSession` instead of null. Only identity-introspection
 * surfaces (`/api/me`, the auth callback) should use this form; every
 * data/op path keeps `resolveSession`, for which "no CRM user" simply
 * means "not signed in".
 */
export function resolveSessionAny(db: Db, token: string | null | undefined): SessionUser | UnprovisionedSession | null {
  if (!token) return null;
  const session = db.select().from(t.sessions).where(eq(t.sessions.tokenHash, sha256Hex(token))).get();
  if (!session || session.expiresAt < nowIso()) return null;

  if (session.userId == null) {
    if (!session.email) return null;
    // Adoption: hosted provisioning may have created the user since the
    // session was minted — bind it now (subject bind-once) and upgrade the
    // session row in place.
    const candidate = db.select().from(t.users).where(eq(t.users.email, session.email)).get();
    if (candidate && !candidate.disabledAt && candidate.status === "active") {
      if (candidate.authSubject && session.authSubject && candidate.authSubject !== session.authSubject) {
        // The user bound a different identity in the meantime: this session
        // can never own it. Kill it.
        db.delete(t.sessions).where(eq(t.sessions.id, session.id)).run();
        return null;
      }
      if (!candidate.authSubject && session.authSubject) {
        db.update(t.users)
          .set({ authSubject: session.authSubject, updatedAt: nowIso() })
          .where(eq(t.users.id, candidate.id))
          .run();
      }
      db.update(t.sessions).set({ userId: candidate.id, email: null }).where(eq(t.sessions.id, session.id)).run();
      return resolveUserSession(db, { ...session, userId: candidate.id });
    }
    return { unprovisioned: true, email: session.email, authSubject: session.authSubject };
  }

  return resolveUserSession(db, session as typeof session & { userId: string });
}

export function resolveSession(db: Db, token: string | null | undefined): SessionUser | null {
  const resolved = resolveSessionAny(db, token);
  if (!resolved || isUnprovisionedSession(resolved)) return null;
  return resolved;
}

function resolveUserSession(
  db: Db,
  session: { userId: string; authSubject: string | null },
): SessionUser | null {
  const user = db.select().from(t.users).where(eq(t.users.id, session.userId)).get();
  // Only active users resolve: pending never completed auth, disabled is out.
  if (!user || user.disabledAt || user.status !== "active") return null;
  const membership = db.select().from(t.memberships).where(eq(t.memberships.userId, user.id)).get();
  if (!membership) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: membership.role as Role,
      status: user.status as UserStatus,
      hasPassword: user.passwordHash != null,
      disabledAt: user.disabledAt,
      createdAt: user.createdAt,
    },
    workspaceId: membership.workspaceId,
    role: membership.role as Role,
    passwordMustChange: user.passwordMustChange === 1,
    authSubject: session.authSubject,
  };
}

/**
 * Legacy pre-OpenAuth credential check against users.password_hash. Login no
 * longer uses it (credentials live in OpenAuth storage); it remains for the
 * hosting-control provisioning surface until that flow moves to pending
 * owners.
 */
export function verifyUserPassword(db: Db, email: string, password: string): { id: string } | null {
  const user = db.select().from(t.users).where(eq(t.users.email, email.toLowerCase())).get();
  if (!user || !user.passwordHash || user.disabledAt || user.status === "disabled") return null;
  return verifyPassword(password, user.passwordHash) ? { id: user.id } : null;
}

export function webContext(session: SessionUser): RequestContext {
  return {
    workspaceId: session.workspaceId,
    actorType: "human",
    userId: session.user.id,
    clientId: null,
    role: session.role,
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "web",
  };
}

// ---------------------------------------------------------------------------
// Forced password change (mirror of the workspace_locked gate pattern)
// ---------------------------------------------------------------------------

export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  "You must set a new password before doing anything else. Open Set password (/set-password) to continue.";

/** The op-layer refusal envelope while users.password_must_change is set. */
export function passwordChangeRequiredResult(): OpResult {
  return {
    status: "error",
    error: { code: "password_change_required", message: PASSWORD_CHANGE_REQUIRED_MESSAGE },
  };
}

/** True when the user exists and has password_must_change set. */
export function userMustChangePassword(db: Db, userId: string): boolean {
  const row = db.select({ flag: t.users.passwordMustChange }).from(t.users).where(eq(t.users.id, userId)).get();
  return row?.flag === 1;
}

export interface ResolvedMcpClient {
  clientId: string;
  workspaceId: string;
  name: string;
  /** Stored scopes clamped to what the creator's current role can grant. */
  scopes: McpScope[];
  trust: TrustProfile;
  /** The user this agent acts on behalf of (its creator). */
  userId: string;
  /** The creator's current role — the agent's authority ceiling. */
  role: Role;
}

/**
 * An agent's authority mirrors the user who created it, evaluated at request
 * time: role = creator's current role, scopes = stored ∩ grantable(role).
 * A revoked key, or a creator who was deleted, disabled, still pending, or
 * removed from the workspace, makes the key inert.
 */
export function resolveMcpToken(db: Db, bearerToken: string | null | undefined): ResolvedMcpClient | null {
  if (!bearerToken) return null;
  const row = db.select().from(t.mcpClients).where(eq(t.mcpClients.tokenHash, sha256Hex(bearerToken))).get();
  if (!row || row.revokedAt || !row.createdByUserId) return null;
  const creator = db.select().from(t.users).where(eq(t.users.id, row.createdByUserId)).get();
  if (!creator || creator.disabledAt || creator.status !== "active") return null;
  const membership = db
    .select()
    .from(t.memberships)
    .where(and(eq(t.memberships.userId, creator.id), eq(t.memberships.workspaceId, row.workspaceId)))
    .get();
  if (!membership) return null;
  db.update(t.mcpClients).set({ lastUsedAt: nowIso() }).where(eq(t.mcpClients.id, row.id)).run();
  const role = membership.role as Role;
  let scopes: McpScope[] = [];
  try {
    scopes = JSON.parse(row.scopes) as McpScope[];
  } catch {
    scopes = [];
  }
  return {
    clientId: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    scopes: clampScopes(scopes, role),
    trust: row.trust as TrustProfile,
    userId: creator.id,
    role,
  };
}

export function mcpContext(
  client: ResolvedMcpClient,
  surface: "mcp_http" | "mcp_stdio" = "mcp_http",
): RequestContext {
  return {
    workspaceId: client.workspaceId,
    actorType: "agent",
    // The agent acts on behalf of its creator: role and scopes reflect what
    // that user is currently allowed to do — never more.
    userId: client.userId,
    clientId: client.clientId,
    role: client.role,
    scopes: client.scopes,
    trust: client.trust,
    surface,
  };
}
