/**
 * Workspace lifecycle primitives for the hosting control API:
 * provision, access set, inspect, and permanent delete.
 *
 * Every function here MUST be called inside a database transaction owned by
 * the HTTP layer (better-sqlite3 `db.$client.transaction(...)`) so product
 * changes, CRM audit events, the hc_* rows, and idempotency completion
 * commit or roll back together.
 *
 * Provisioning reuses the existing bootstrap machinery (default stage seeds,
 * password hashing, workspace settings) but is multi-workspace: unlike
 * `bootstrap()` — which is a first-run, single-workspace seeder — each call
 * creates a brand-new workspace with its own owner and default pipelines.
 */
import { DEFAULT_WORKSPACE_SETTINGS, newId, nowIso } from "@emcp/core";
import { DEFAULT_DEAL_STAGES, DEFAULT_ENGAGEMENT_STAGES, hashPassword, schema, type Db } from "@emcp/db";
import { HcError } from "./errors.ts";
import { deleteAccess, getAccess, insertAccess, redactAuditForWorkspace, updateAccess, type AccessState } from "./hc-store.ts";

type StageSeed = (typeof DEFAULT_ENGAGEMENT_STAGES)[number];

// --- Provision --------------------------------------------------------------

export interface ProvisionInput {
  organizationName: string;
  /**
   * The owner's verified identity. The architecture doc uses an OpenAuth
   * subject; until OpenAuth lands in this product, the email IS the identity.
   */
  ownerEmail: string;
  ownerName?: string;
  /**
   * Optional. When omitted the owner is created without a password (no login
   * until one is set — the OpenAuth-shaped default). Providing one lets the
   * current password-auth product sign the owner in immediately.
   */
  ownerPassword?: string;
  accessMode?: "active" | "locked";
  accessExpiresAt?: string | null;
  defaultCurrency?: string;
  timezone?: string;
}

export interface ProvisionResult {
  workspaceId: string;
  ownerUserId: string;
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  version: number;
}

export function provisionWorkspace(db: Db, input: ProvisionInput): ProvisionResult {
  const email = input.ownerEmail.trim().toLowerCase();
  const existing = db.$client.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
  if (existing) {
    // Stable conflict that reveals nothing about the other workspace.
    throw new HcError(409, "identity_unavailable", "This identity is already attached to a workspace");
  }

  const now = nowIso();
  const workspaceId = newId();
  db.insert(schema.workspaces)
    .values({
      id: workspaceId,
      name: input.organizationName,
      defaultCurrency: input.defaultCurrency ?? "USD",
      timezone: input.timezone ?? "UTC",
      settings: JSON.stringify(DEFAULT_WORKSPACE_SETTINGS),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const ownerUserId = newId();
  db.insert(schema.users)
    .values({
      id: ownerUserId,
      email,
      name: input.ownerName ?? "Owner",
      passwordHash: input.ownerPassword ? hashPassword(input.ownerPassword) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.memberships)
    .values({ id: newId(), workspaceId, userId: ownerUserId, role: "owner", createdAt: now })
    .run();

  seedPipeline(db, workspaceId, "engagement", "Outreach", DEFAULT_ENGAGEMENT_STAGES);
  seedPipeline(db, workspaceId, "deal", "Sales", DEFAULT_DEAL_STAGES);

  const accessMode = input.accessMode ?? "active";
  const accessExpiresAt = input.accessExpiresAt ?? null;
  insertAccess(db, workspaceId, accessMode, accessExpiresAt);

  workspaceAuditEvent(db, workspaceId, "hosting.workspace.provision", "Workspace provisioned by hosting control", {
    accessMode,
    accessExpiresAt,
  });

  return { workspaceId, ownerUserId, accessMode, accessExpiresAt, version: 1 };
}

/** Mirrors bootstrap's default pipeline seeding, scoped to one new workspace. */
function seedPipeline(
  db: Db,
  workspaceId: string,
  type: "engagement" | "deal",
  name: string,
  stages: readonly StageSeed[],
): void {
  const pipelineId = newId();
  db.insert(schema.pipelines)
    .values({ id: pipelineId, workspaceId, type, name, isDefault: 1, position: 0, createdAt: nowIso() })
    .run();
  stages.forEach((s, i) => {
    db.insert(schema.stages)
      .values({
        id: newId(),
        workspaceId,
        pipelineId,
        name: s.name,
        color: s.color,
        position: i,
        probability: s.probability ?? null,
        outcome: s.outcome ?? null,
      })
      .run();
  });
}

// --- Access -----------------------------------------------------------------

export interface SetAccessInput {
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  expectedVersion?: number | null;
  reason?: string | null;
}

export function setWorkspaceAccess(db: Db, workspaceId: string, input: SetAccessInput): AccessState {
  const ws = db.$client.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id: string } | undefined;
  if (!ws) throw new HcError(404, "not_found", "Unknown workspace");

  const current = getAccess(db, workspaceId);
  const currentVersion = current?.version ?? 0;
  if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
    throw new HcError(409, "version_conflict", `Access state version conflict; current version is ${currentVersion}`, {
      currentVersion,
    });
  }

  // Setting the current state again succeeds with no duplicate effect.
  if (current && current.accessMode === input.accessMode && current.accessExpiresAt === input.accessExpiresAt) {
    return current;
  }

  if (!current) insertAccess(db, workspaceId, input.accessMode, input.accessExpiresAt);
  else updateAccess(db, workspaceId, input.accessMode, input.accessExpiresAt);

  workspaceAuditEvent(
    db,
    workspaceId,
    "hosting.workspace.access_set",
    `Hosting access set to ${input.accessMode}${input.accessExpiresAt ? ` (expires ${input.accessExpiresAt})` : ""}`,
    { accessMode: input.accessMode, accessExpiresAt: input.accessExpiresAt, reason: input.reason ?? null },
  );

  const next = getAccess(db, workspaceId);
  if (!next) throw new HcError(500, "internal_error", "Access state write failed", undefined, true);
  return next;
}

// --- Inspect ----------------------------------------------------------------

export interface WorkspaceControlState {
  workspaceId: string;
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  ownerUserId: string | null;
  version: number;
}

export function getWorkspaceControlState(db: Db, workspaceId: string): WorkspaceControlState | null {
  const ws = db.$client.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id: string } | undefined;
  if (!ws) return null;
  const owner = db.$client
    .prepare("SELECT user_id AS ownerUserId FROM memberships WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId) as { ownerUserId: string } | undefined;
  const access = getAccess(db, workspaceId);
  return {
    workspaceId,
    accessMode: access?.accessMode ?? "active",
    accessExpiresAt: access?.accessExpiresAt ?? null,
    ownerUserId: owner?.ownerUserId ?? null,
    version: access?.version ?? 0,
  };
}

// --- Permanent delete -------------------------------------------------------

/**
 * Physically removes every row belonging to the workspace: all
 * workspace-scoped CRM tables (discovered dynamically by their workspace_id
 * column, so tables added by future migrations are covered), users whose only
 * membership was this workspace, and their sessions. The hc_workspace_access
 * row disappears too; hc_service_audit keeps only one-way hashes.
 *
 * Deleting an absent workspace is a successful no-op (idempotent retry).
 */
export function deleteWorkspacePermanently(db: Db, workspaceId: string): { existed: boolean } {
  const ws = db.$client.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id: string } | undefined;
  if (!ws) return { existed: false };

  const memberIds = (
    db.$client.prepare("SELECT user_id AS userId FROM memberships WHERE workspace_id = ?").all(workspaceId) as Array<{
      userId: string;
    }>
  ).map((r) => r.userId);

  for (const table of workspaceScopedTables(db)) {
    db.$client.prepare(`DELETE FROM "${table}" WHERE workspace_id = ?`).run(workspaceId);
  }

  // Users are global rows reached via memberships; remove the ones that no
  // longer belong to any workspace (single-membership model), plus their
  // sessions.
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => "?").join(",");
    db.$client
      .prepare(
        `DELETE FROM sessions WHERE user_id IN (${placeholders})
         AND user_id NOT IN (SELECT user_id FROM memberships)`,
      )
      .run(...memberIds);
    db.$client
      .prepare(
        `DELETE FROM users WHERE id IN (${placeholders})
         AND id NOT IN (SELECT user_id FROM memberships)`,
      )
      .run(...memberIds);
  }

  db.$client.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  deleteAccess(db, workspaceId);
  redactAuditForWorkspace(db, workspaceId);
  return { existed: true };
}

/** Every non-hc table carrying a workspace_id column, discovered at runtime. */
function workspaceScopedTables(db: Db): string[] {
  const tables = db.$client
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'hc_%' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('schema_migrations', 'workspaces')`,
    )
    .all() as Array<{ name: string }>;
  const out: string[] = [];
  for (const { name } of tables) {
    const cols = db.$client.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "workspace_id")) out.push(name);
  }
  return out;
}

// --- Shared -----------------------------------------------------------------

/** Lifecycle actions also create a CRM audit event while the workspace exists. */
function workspaceAuditEvent(
  db: Db,
  workspaceId: string,
  operation: string,
  summary: string,
  meta?: Record<string, unknown>,
): void {
  db.insert(schema.auditEvents)
    .values({
      id: newId(),
      workspaceId,
      operation,
      entityType: "workspace",
      entityId: workspaceId,
      summary,
      meta: meta ? JSON.stringify(meta) : null,
      actorType: "system",
      actorUserId: null,
      actorClientId: null,
      surface: "system",
      createdAt: nowIso(),
    })
    .run();
}
