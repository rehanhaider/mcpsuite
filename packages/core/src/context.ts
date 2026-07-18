import type { Surface, ActorType } from "./domain.ts";
import type { McpScope, Role, TrustProfile } from "./policy.ts";
import type { ActorStamp } from "./ports.ts";

/**
 * Resolved identity + authority for one request. Web resolves it from the
 * session cookie, MCP HTTP from the Bearer API key, MCP stdio from local
 * trust env. Every operation execution requires one.
 */
export interface RequestContext {
  workspaceId: string;
  actorType: ActorType;
  /** Human user (web) or the user an agent acts on behalf of (stdio owner). */
  userId: string | null;
  /** MCP client id for agent actors. */
  clientId: string | null;
  role: Role;
  scopes: McpScope[];
  trust: TrustProfile;
  surface: Surface;
}

export function actorStamp(ctx: RequestContext): ActorStamp {
  return {
    actorType: ctx.actorType,
    actorUserId: ctx.userId,
    actorClientId: ctx.clientId,
    surface: ctx.surface,
  };
}

export function systemContext(workspaceId: string): RequestContext {
  return {
    workspaceId,
    actorType: "system",
    userId: null,
    clientId: null,
    role: "owner",
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "system",
  };
}
