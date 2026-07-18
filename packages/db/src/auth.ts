/**
 * Identity resolution: web sessions (opaque token, SHA-256 at rest) and MCP
 * API keys → RequestContext. V1 is single-workspace; the workspace id comes
 * from the caller's membership / client row.
 */
import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import {
  clampScopes,
  newId,
  nowIso,
  type McpScope,
  type RequestContext,
  type Role,
  type TrustProfile,
  type User,
} from "@emcp/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { sha256Hex, verifyPassword } from "./services.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  user: User;
  workspaceId: string;
  role: Role;
}

export function createSession(db: Db, userId: string): { token: string; expiresAt: string } {
  const token = `sess_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.insert(t.sessions).values({ id: newId(), tokenHash: sha256Hex(token), userId, expiresAt, createdAt: nowIso() }).run();
  // Opportunistic cleanup of expired sessions.
  db.delete(t.sessions).where(lt(t.sessions.expiresAt, nowIso())).run();
  return { token, expiresAt };
}

export function destroySession(db: Db, token: string): void {
  db.delete(t.sessions).where(eq(t.sessions.tokenHash, sha256Hex(token))).run();
}

export function resolveSession(db: Db, token: string | null | undefined): SessionUser | null {
  if (!token) return null;
  const session = db.select().from(t.sessions).where(eq(t.sessions.tokenHash, sha256Hex(token))).get();
  if (!session || session.expiresAt < nowIso()) return null;
  const user = db.select().from(t.users).where(eq(t.users.id, session.userId)).get();
  if (!user || user.disabledAt) return null;
  const membership = db.select().from(t.memberships).where(eq(t.memberships.userId, user.id)).get();
  if (!membership) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: membership.role as Role,
      hasPassword: user.passwordHash != null,
      disabledAt: user.disabledAt,
      createdAt: user.createdAt,
    },
    workspaceId: membership.workspaceId,
    role: membership.role as Role,
  };
}

export function verifyUserPassword(db: Db, email: string, password: string): { id: string } | null {
  const user = db.select().from(t.users).where(eq(t.users.email, email.toLowerCase())).get();
  if (!user || !user.passwordHash || user.disabledAt) return null;
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
 * A revoked key, or a creator who was deleted, disabled, or removed from the
 * workspace, makes the key inert.
 */
export function resolveMcpToken(db: Db, bearerToken: string | null | undefined): ResolvedMcpClient | null {
  if (!bearerToken) return null;
  const row = db.select().from(t.mcpClients).where(eq(t.mcpClients.tokenHash, sha256Hex(bearerToken))).get();
  if (!row || row.revokedAt || !row.createdByUserId) return null;
  const creator = db.select().from(t.users).where(eq(t.users.id, row.createdByUserId)).get();
  if (!creator || creator.disabledAt) return null;
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
