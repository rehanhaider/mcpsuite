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
  /**
   * Legacy password helpers. User creation and password recovery now flow
   * through single-use setup/reset codes (`ports.credentials.issueCode`), so
   * catalog operations no longer consume these; they remain optional for
   * bootstrap-side callers (first-run owner provisioning).
   */
  hashPassword?(password: string): string;
  generatePassword?(): string;
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
      title: "Invite user",
      description:
        "Invite a team user with a role. Creates a PENDING user and returns a single-use setup code (shown once) with which the user sets their own password. There is no admin-supplied initial password.",
      input: z.object({
        name: z.string().min(1).max(120),
        email: z.string().email().max(320),
        role: z.enum(ROLES).default("member"),
      }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, input) => {
        if (input.role === "owner") {
          throw OpError.validation("There can only be one owner; invite an admin and use user.transferOwnership");
        }
        const email = input.email.toLowerCase();
        if (await op.ports.users.getByEmail(email)) {
          throw new OpError("conflict", `A user with email ${email} already exists`);
        }
        const { userId } = await op.ports.users.createPending({ email, name: input.name, role: input.role as Role });
        const { code } = await op.ports.credentials.issueCode(userId, "setup");
        const user = found(await op.ports.users.get(userId), "user", userId);
        await audit(op, {
          operation: "user.create",
          entityType: "user",
          entityId: userId,
          summary: `Invited user ${email} (${input.role})`,
        });
        // The raw code lives ONLY in this result so a self-host admin can hand
        // it over manually; hosted deployments deliver it via the configured
        // mailer at the credentials seam instead of displaying it. It is never
        // audited or logged, and only its hash is stored.
        return { user, setupCode: code };
      },
    }),

    defineOperation({
      name: "user.regenerateSetupCode",
      title: "Regenerate setup code",
      description:
        "Issue a fresh single-use setup code for a still-pending user. All previously issued codes are invalidated. Returns the new code once.",
      input: z.object({ id: zId }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id }) => {
        const user = found(await op.ports.users.get(id), "user", id);
        if (user.status !== "pending") {
          throw new OpError("invalid_state", "Only pending users have setup codes — use user.resetPassword for users who already completed setup");
        }
        const { code } = await op.ports.credentials.issueCode(id, "setup");
        await audit(op, {
          operation: "user.regenerateSetupCode",
          entityType: "user",
          entityId: id,
          summary: `Regenerated setup code for ${user.email}`,
        });
        return { setupCode: code };
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
        // Only the owner role is protected: admins manage everyone else,
        // including other admins (docs/issues/0022).
        if (user.role === "owner" && (patch.role || disabled)) {
          throw OpError.validation("The owner account cannot be demoted or disabled");
        }
        if (patch.role === "owner") throw OpError.validation("Use user.transferOwnership to change the workspace owner");
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
      description:
        "Issue a single-use password-reset code for a user (shown once). Ends all of the user's sessions and invalidates earlier codes; the user chooses their new password with the code. There is no temporary password.",
      input: z.object({ id: zId }),
      minRole: "admin",
      scope: "admin",
      risk: "admin",
      handler: async (op, { id }) => {
        const user = found(await op.ports.users.get(id), "user", id);
        if (user.role === "owner" && op.ctx.role !== "owner") throw OpError.forbidden("Only the owner can reset the owner password");
        if (user.status === "pending") {
          throw new OpError("invalid_state", "This user has not completed setup — use user.regenerateSetupCode instead");
        }
        // The credentials seam invalidates prior codes and ends every session.
        // Self-host shows the code once to the admin; hosted delivery mails it.
        const { code } = await op.ports.credentials.issueCode(id, "reset");
        await audit(op, { operation: "user.resetPassword", entityType: "user", entityId: id, summary: `Issued password reset code for ${user.email}` });
        return { resetCode: code };
      },
    }),

    defineOperation({
      name: "user.delete",
      title: "Delete user permanently",
      description:
        "PERMANENTLY delete a user. Removes their login, sessions, MCP clients and private data; business records and history survive and show \"Deleted user\". Cannot be undone. The owner cannot be deleted — transfer ownership first.",
      input: z.object({ id: zId }),
      minRole: "admin",
      scope: "admin",
      risk: "destructive",
      handler: async (op, { id }) => {
        const user = found(await op.ports.users.get(id), "user", id);
        if (user.role === "owner") {
          throw OpError.validation("The owner cannot be deleted — transfer ownership first with user.transferOwnership");
        }
        if (op.ctx.userId === id) {
          const otherAdmins = (await op.ports.users.list()).filter(
            (u) => u.id !== id && u.status === "active" && roleAtLeast(u.role, "admin"),
          );
          if (otherAdmins.length === 0) {
            throw new OpError("invalid_state", "You are the last active administrator — you cannot delete your own account");
          }
        }
        const ownedClients = (await op.ports.mcpClients.list()).filter((c) => c.createdByUserId === id && !c.revokedAt);
        const endedSessions = (await op.ports.users.deleteSessions?.(id)) ?? 0;
        await op.ports.users.deletePermanently(id);
        // Deliberately no name/email here: after deletion nothing may retain
        // them, and historical actor references render as "Deleted user"
        // (docs/issues/0022).
        await audit(op, {
          operation: "user.delete",
          entityType: "user",
          entityId: id,
          summary: `Permanently deleted a ${user.role} user`,
          meta: { role: user.role, endedSessions, removedMcpClients: ownedClients.length },
        });
        return { deleted: true, endedSessions, removedMcpClients: ownedClients.length };
      },
    }),

    defineOperation({
      name: "user.transferOwnership",
      title: "Transfer ownership",
      description:
        "Transfer the workspace owner role to another ACTIVE user. Only the current owner can do this. Both role changes happen atomically: the target becomes owner and the previous owner becomes admin.",
      input: z.object({ toUserId: zId }),
      minRole: "owner",
      scope: "admin",
      risk: "admin",
      handler: async (op, { toUserId }) => {
        // The actor must BE the owner — admin is not enough. This also holds on
        // the approval path: an approving admin executes as themselves and is
        // rejected here. (The audited hosting-control recovery seam runs as a
        // system actor with the owner role and a null userId.)
        if (op.ctx.role !== "owner") throw OpError.forbidden("Only the current owner can transfer ownership");
        const current = (await op.ports.users.list()).find((u) => u.role === "owner");
        if (!current) throw new OpError("invalid_state", "This workspace has no owner user");
        if (op.ctx.userId && op.ctx.userId !== current.id) {
          throw OpError.forbidden("Only the current owner can transfer ownership");
        }
        const target = found(await op.ports.users.get(toUserId), "user", toUserId);
        if (target.id === current.id) throw OpError.validation("This user already owns the workspace");
        if (target.status !== "active") {
          throw OpError.validation(`Ownership can only be transferred to an active user (${target.email} is ${target.status})`);
        }
        await op.ports.users.transferOwnership(current.id, toUserId);
        await audit(op, {
          operation: "user.transferOwnership",
          entityType: "user",
          entityId: toUserId,
          summary: `Transferred workspace ownership to ${target.email}`,
          meta: { fromUserId: current.id, toUserId },
        });
        return {
          from: found(await op.ports.users.get(current.id), "user", current.id),
          to: found(await op.ports.users.get(toUserId), "user", toUserId),
        };
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
