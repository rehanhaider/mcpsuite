/** Workspace settings, team users, MCP clients, audit log. */
import { z } from "zod";
import { OpError } from "../errors.ts";
import { zAuditFilter, zId, zWorkspaceUpdate } from "../domain.ts";
import {
  MCP_SCOPES,
  ROLES,
  TRUST_PROFILES,
  grantableScopes,
  roleAtLeast,
  type McpScope,
  type Role,
  type TrustProfile,
} from "../policy.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit, definedOnly, found } from "./helpers.ts";
import type { McpClient } from "../domain.ts";

/** Reject scopes the given role is not allowed to grant to an agent. */
function assertGrantableScopes(scopes: readonly McpScope[], role: Role): void {
  const cap = grantableScopes(role);
  const excess = scopes.filter((s) => !cap.includes(s));
  if (excess.length > 0) {
    throw OpError.forbidden(
      `Role ${role} cannot grant scope ${excess.map((s) => `"${s}"`).join(", ")} — agents never exceed their owner's permissions (grantable: ${cap.join(", ")})`,
    );
  }
}

/** Only the user who owns an agent client (or an admin) may manage it. */
function assertCanManageClient(op: OpCtx, client: McpClient): void {
  if (client.createdByUserId !== op.ctx.userId && !roleAtLeast(op.ctx.role, "admin")) {
    throw OpError.forbidden("Only the user this agent belongs to (or an admin) can manage it");
  }
}

export interface AuthServices {
  hashPassword(password: string): string;
  generatePassword(): string;
  /** Returns { token, hash, prefix } for a new MCP API key. */
  generateMcpToken(): { token: string; hash: string; prefix: string };
}

export function buildAdminOps(auth: AuthServices) {
  return [
    defineOperation({
      name: "workspace.get",
      title: "Get workspace",
      description: "Fetch workspace settings: name, default currency, timezone, display prefixes, staleness windows.",
      input: z.object({}),
      minRole: "viewer",
      scope: "read",
      handler: ({ ports }) => ports.workspace.get(),
    }),

    defineOperation({
      name: "workspace.update",
      title: "Update workspace",
      description: "Update workspace settings. Configuration change — gated for agents.",
      input: zWorkspaceUpdate,
      minRole: "admin",
      scope: "admin",
      risk: "config",
      handler: async (op, input) => {
        const ws = await op.ports.workspace.get();
        const settings = { ...ws.settings };
        if (input.staleEngagementDays) settings.staleEngagementDays = input.staleEngagementDays;
        if (input.staleDealDays) settings.staleDealDays = input.staleDealDays;
        if (input.prefixes) settings.prefixes = { ...settings.prefixes, ...input.prefixes };
        const updated = await op.ports.workspace.update({
          ...definedOnly({ name: input.name, defaultCurrency: input.defaultCurrency, timezone: input.timezone }),
          settings,
        });
        await audit(op, { operation: "workspace.update", entityType: "workspace", entityId: ws.id, summary: "Updated workspace settings" });
        return updated;
      },
    }),

    defineOperation({
      name: "user.list",
      title: "List users",
      description: "List workspace users with roles.",
      input: z.object({}),
      minRole: "viewer",
      scope: "read",
      handler: ({ ports }) => ports.users.list(),
    }),

    defineOperation({
      name: "user.create",
      title: "Create user",
      description:
        "Create a team user with a role. Returns a generated one-time password (shown once) the user must change.",
      input: z.object({
        name: z.string().min(1).max(120),
        email: z.string().email().max(320),
        role: z.enum(ROLES).default("member"),
      }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, input) => {
        if (input.role === "owner") throw OpError.validation("There can only be one owner; use role admin");
        if (await op.ports.users.getByEmail(input.email)) {
          throw new OpError("conflict", `A user with email ${input.email} already exists`);
        }
        const password = auth.generatePassword();
        const user = await op.ports.users.create({
          name: input.name,
          email: input.email.toLowerCase(),
          role: input.role as Role,
          passwordHash: auth.hashPassword(password),
        });
        await audit(op, {
          operation: "user.create",
          entityType: "user",
          entityId: user.id,
          summary: `Created user ${input.email} (${input.role})`,
        });
        return { user, oneTimePassword: password };
      },
    }),

    defineOperation({
      name: "user.update",
      title: "Update user",
      description: "Update a user's name, role, or enable/disable their login.",
      input: z.object({
        id: zId,
        name: z.string().min(1).max(120).optional(),
        role: z.enum(ROLES).optional(),
        disabled: z.boolean().optional(),
      }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id, disabled, ...patch }) => {
        const user = found(await op.ports.users.get(id), "user", id);
        if (user.role === "owner" && (patch.role || disabled)) {
          throw OpError.validation("The owner account cannot be demoted or disabled");
        }
        if (patch.role === "owner") throw OpError.validation("Ownership transfer is not supported yet");
        const updated = await op.ports.users.update(id, {
          ...definedOnly(patch),
          ...(disabled === undefined ? {} : { disabledAt: disabled ? new Date().toISOString() : null }),
        });
        // Disabling revokes everything, in the SAME transaction as the update
        // (the executor wraps this handler in ports.tx): all sessions are
        // deleted and every MCP client the user created is revoked. Re-enabling
        // restores none of it (docs/issues/0022).
        let revocation: { endedSessions: number; revokedMcpClients: number } | null = null;
        if (disabled === true) {
          revocation = {
            endedSessions: (await op.ports.users.deleteSessions?.(id)) ?? 0,
            revokedMcpClients: (await op.ports.mcpClients.revokeAllForUser?.(id)) ?? 0,
          };
        }
        await audit(op, {
          operation: "user.update",
          entityType: "user",
          entityId: id,
          summary: `Updated user ${user.email}`,
          ...(revocation ? { meta: revocation } : {}),
        });
        return updated;
      },
    }),

    defineOperation({
      name: "user.resetPassword",
      title: "Reset user password",
      description: "Generate a new one-time password for a user (shown once).",
      input: z.object({ id: zId }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id }) => {
        const user = found(await op.ports.users.get(id), "user", id);
        if (user.role === "owner" && op.ctx.role !== "owner") throw OpError.forbidden("Only the owner can reset the owner password");
        const password = auth.generatePassword();
        await op.ports.users.setPassword(id, auth.hashPassword(password));
        await audit(op, { operation: "user.resetPassword", entityType: "user", entityId: id, summary: `Reset password for ${user.email}` });
        return { oneTimePassword: password };
      },
    }),

    defineOperation({
      name: "mcpClient.list",
      title: "List MCP clients",
      description:
        "List MCP agent clients with scopes, trust profiles and last-used timestamps. Members see their own agents; admins see all.",
      input: z.object({}),
      minRole: "member",
      scope: "admin",
      handler: async ({ ports, ctx }) => {
        const all = await ports.mcpClients.list();
        return roleAtLeast(ctx.role, "admin") ? all : all.filter((c) => c.createdByUserId === ctx.userId);
      },
    }),

    defineOperation({
      name: "mcpClient.create",
      title: "Create MCP client",
      description:
        "Create an MCP agent client and return its API key ONCE. The agent acts on behalf of you: scopes are capped by your role and its authority always mirrors your current permissions. Trust: review_risky_actions | trusted_agent | fully_authorized_agent.",
      input: z.object({
        name: z.string().min(1).max(120),
        scopes: z.array(z.enum(MCP_SCOPES)).min(1).default(["read", "write"]),
        trust: z.enum(TRUST_PROFILES).default("review_risky_actions"),
      }),
      minRole: "member",
      scope: "admin",
      risk: "admin",
      handler: async (op, input) => {
        if (!op.ctx.userId) throw OpError.validation("An agent client must belong to a user");
        assertGrantableScopes(input.scopes, op.ctx.role);
        const { token, hash, prefix } = auth.generateMcpToken();
        const client = await op.ports.mcpClients.create({
          name: input.name,
          tokenHash: hash,
          tokenPrefix: prefix,
          scopes: input.scopes as McpScope[],
          trust: input.trust as TrustProfile,
          createdByUserId: op.ctx.userId,
        });
        await audit(op, {
          operation: "mcpClient.create",
          entityType: "mcp_client",
          entityId: client.id,
          summary: `Created MCP client "${input.name}" (${input.trust}; ${input.scopes.join(",")})`,
        });
        return { client, token };
      },
    }),

    defineOperation({
      name: "mcpClient.update",
      title: "Update MCP client",
      description: "Rename a client or change its scopes/trust profile.",
      input: z.object({
        id: zId,
        name: z.string().min(1).max(120).optional(),
        scopes: z.array(z.enum(MCP_SCOPES)).min(1).optional(),
        trust: z.enum(TRUST_PROFILES).optional(),
      }),
      minRole: "member",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id, ...patch }) => {
        const client = found(await op.ports.mcpClients.get(id), "MCP client", id);
        assertCanManageClient(op, client);
        if (patch.scopes) {
          const creator = client.createdByUserId ? await op.ports.users.get(client.createdByUserId) : null;
          if (!creator) throw OpError.validation("This client's owning user no longer exists — revoke it instead");
          assertGrantableScopes(patch.scopes, creator.role);
        }
        const updated = await op.ports.mcpClients.update(id, definedOnly(patch) as never);
        await audit(op, {
          operation: "mcpClient.update",
          entityType: "mcp_client",
          entityId: id,
          summary: `Updated MCP client "${client.name}"`,
          meta: { fields: Object.keys(definedOnly(patch)) },
        });
        return updated;
      },
    }),

    defineOperation({
      name: "mcpClient.revoke",
      title: "Revoke MCP client",
      description: "Revoke an MCP client's API key immediately.",
      input: z.object({ id: zId }),
      minRole: "member",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id }) => {
        const client = found(await op.ports.mcpClients.get(id), "MCP client", id);
        assertCanManageClient(op, client);
        const revoked = await op.ports.mcpClients.revoke(id);
        await audit(op, { operation: "mcpClient.revoke", entityType: "mcp_client", entityId: id, summary: `Revoked MCP client "${client.name}"` });
        return revoked;
      },
    }),

    defineOperation({
      name: "audit.list",
      title: "List audit events",
      description: "Query the audit trail (who did what, from which surface). Newest first.",
      input: zAuditFilter,
      minRole: "admin",
      scope: "admin",
      handler: ({ ports }, input) => ports.audit.list(input),
    }),
  ];
}
