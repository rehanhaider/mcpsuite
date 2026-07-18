/**
 * Authorization model: fixed human roles, MCP scopes, agent trust profiles,
 * and risk categories for approval gating. Browser-safe (no node imports).
 */

export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

export const MCP_SCOPES = ["read", "write", "admin", "approvals"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Scopes a user of a given role may grant to their agents. An agent acts on
 * behalf of the user who created it and can never out-rank them: stored
 * scopes are validated against this map when a client is created/updated AND
 * clamped against the creator's CURRENT role on every request, so demotions
 * apply immediately. Members get `approvals` so their agents can follow the
 * status of their own pending actions (approve/reject stay admin-role-gated).
 */
export const ROLE_GRANTABLE_SCOPES: Record<Role, readonly McpScope[]> = {
  viewer: ["read"],
  member: ["read", "write", "approvals"],
  admin: ["read", "write", "admin", "approvals"],
  owner: ["read", "write", "admin", "approvals"],
};

export function grantableScopes(role: Role): readonly McpScope[] {
  return ROLE_GRANTABLE_SCOPES[role];
}

export function clampScopes(scopes: readonly McpScope[], role: Role): McpScope[] {
  return scopes.filter((s) => ROLE_GRANTABLE_SCOPES[role].includes(s));
}

export const TRUST_PROFILES = [
  "review_risky_actions",
  "trusted_agent",
  "fully_authorized_agent",
] as const;
export type TrustProfile = (typeof TRUST_PROFILES)[number];

export const TRUST_PROFILE_LABELS: Record<TrustProfile, string> = {
  review_risky_actions: "Review risky actions",
  trusted_agent: "Trusted agent",
  fully_authorized_agent: "Fully authorized agent",
};

export const RISK_CATEGORIES = ["destructive", "bulk", "config", "data", "admin"] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** Risk categories each trust profile may execute WITHOUT human approval. */
const TRUST_ALLOWANCES: Record<TrustProfile, readonly RiskCategory[]> = {
  review_risky_actions: [],
  trusted_agent: ["bulk", "data", "config"],
  fully_authorized_agent: ["bulk", "data", "config", "admin", "destructive"],
};

export function trustAllows(trust: TrustProfile, category: RiskCategory): boolean {
  return TRUST_ALLOWANCES[trust].includes(category);
}
