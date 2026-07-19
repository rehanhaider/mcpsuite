/**
 * Workspace lifecycle primitives for the hosting control API:
 * provision, access set, inspect, owner transfer, owner recovery, and
 * permanent delete.
 *
 * Every function here MUST be called inside a database transaction owned by
 * the HTTP layer (better-sqlite3 `db.$client.transaction(...)`) so product
 * changes, CRM audit events, the hc_* rows, and idempotency completion
 * commit or roll back together. Delivery of setup/reset codes happens AFTER
 * that commit (the committed outbox row is the durable acknowledgement).
 *
 * Provisioning reuses the existing bootstrap machinery (default stage seeds,
 * workspace settings) but is multi-workspace: unlike `bootstrap()` — which is
 * a first-run, single-workspace seeder — each call creates a brand-new
 * workspace with its own owner and default pipelines. Owners are always
 * created PENDING (no password, no credential material in the request); they
 * activate through a single-use setup code routed via the delivery seam.
 */
import { DEFAULT_WORKSPACE_SETTINGS, OpError, newId, nowIso } from "@emcp/core";
import {
  DEFAULT_DEAL_STAGES,
  DEFAULT_ENGAGEMENT_STAGES,
  emailForAuthSubjectSync,
  hasPasswordCredentialSync,
  issueAuthCodeSync,
  schema,
  type AuthCodePurpose,
  type Db,
} from "@emcp/db";
import { deliveryMode, type DeliveryMode } from "./auth-delivery.ts";
import { HcError } from "./errors.ts";
import {
  deleteAccess,
  deleteOutboxForWorkspace,
  getAccess,
  insertAccess,
  insertOutbox,
  redactAuditForWorkspace,
  updateAccess,
  type AccessState,
} from "./hc-store.ts";

type StageSeed = (typeof DEFAULT_ENGAGEMENT_STAGES)[number];

// --- Provision --------------------------------------------------------------

export interface ProvisionInput {
  organizationName: string;
  /**
   * The owner's verified OpenAuth subject (trial-first signup). Resolved to
   * its registered email; the owner is created ACTIVE with the subject bound.
   */
  authSubject?: string;
  /** Plain-email identity (staff/manual provisioning → pending owner). */
  ownerEmail?: string;
  ownerName?: string;
  accessMode?: "active" | "locked";
  accessExpiresAt?: string | null;
  defaultCurrency?: string;
  timezone?: string;
}

/** One-time setup material — the HTTP layer decides what a response may show. */
export interface SetupInitiation {
  /** Single-use code. Display mode may return it ONCE; it is never stored or logged. */
  code: string;
  /** Delivery target, for the post-commit send only — never in responses. */
  email: string;
  purpose: AuthCodePurpose;
  delivery: "queued" | "display";
  outboxId: string | null;
}

export interface ProvisionResult {
  workspaceId: string;
  ownerUserId: string;
  /** "active" when a verified OpenAuth credential already existed (trial-first signup). */
  ownerStatus: "pending" | "active";
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  version: number;
  /** null when the owner is active — no setup code exists. */
  setup: SetupInitiation | null;
}

export function provisionWorkspace(db: Db, input: ProvisionInput): ProvisionResult {
  let resolvedEmail = input.ownerEmail?.trim().toLowerCase() ?? null;
  if (input.authSubject) {
    const fromSubject = emailForAuthSubjectSync(db, input.authSubject);
    if (!fromSubject) {
      throw new HcError(404, "not_found", "authSubject does not resolve to a registered identity");
    }
    if (resolvedEmail && resolvedEmail !== fromSubject) {
      throw new HcError(400, "validation_error", "authSubject and ownerEmail identify different identities");
    }
    resolvedEmail = fromSubject;
  }
  const email = resolvedEmail!;
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

  // Trial-first signup (docs/auth-api.md §Hosted open registration): when a
  // completed OpenAuth credential already exists for this email — proof the
  // holder registered and verified on this deployment — the owner is created
  // ACTIVE with no setup code (they set their password during registration;
  // the session resolver binds the subject on their next request). Without a
  // credential the owner starts PENDING and activation happens through the
  // single-use setup code issued below via the CRM code store.
  const hasCredential = hasPasswordCredentialSync(db, email);
  const ownerStatus = hasCredential ? ("active" as const) : ("pending" as const);
  const boundSubject = input.authSubject && hasCredential ? input.authSubject : null;
  const ownerUserId = newId();
  db.insert(schema.users)
    .values({
      id: ownerUserId,
      email,
      name: input.ownerName ?? "Owner",
      passwordHash: null,
      status: ownerStatus,
      authSubject: boundSubject,
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

  const setup = hasCredential ? null : initiateCodeDelivery(db, workspaceId, ownerUserId, email, "setup");

  workspaceAuditEvent(db, workspaceId, "hosting.workspace.provision", "Workspace provisioned by hosting control", {
    accessMode,
    accessExpiresAt,
    ownerStatus,
    setupDelivery: setup?.delivery ?? "none",
  });

  return { workspaceId, ownerUserId, ownerStatus, accessMode, accessExpiresAt, version: 1, setup };
}

/**
 * Issue a single-use code through the CRM code store (redeemable by the login
 * flow; only its hash is at rest) and, in hosted mode, commit the outbox row
 * that makes its delivery durable. `issueAuthCodeSync` joins this open
 * transaction via a savepoint; a retried delivery later issues a fresh code.
 */
function initiateCodeDelivery(
  db: Db,
  workspaceId: string,
  userId: string,
  email: string,
  purpose: AuthCodePurpose,
): SetupInitiation {
  let code: string;
  try {
    code = issueAuthCodeSync(db, { userId, purpose }).code;
  } catch (err) {
    if (err instanceof OpError && err.code === "conflict") {
      // The per-email issue window is exhausted (openauth's fixed-window limit).
      throw new HcError(429, "rate_limited", "Too many codes issued for this identity — retry later", undefined, true);
    }
    throw err;
  }
  const mode: DeliveryMode = deliveryMode();
  let outboxId: string | null = null;
  if (mode === "hosted") {
    outboxId = newId();
    insertOutbox(db, { id: outboxId, workspaceId, userId, purpose });
  }
  return { code, email, purpose, delivery: mode === "hosted" ? "queued" : "display", outboxId };
}

type UserStateRow = {
  status?: string | null;
  disabled_at?: string | null;
  password_hash?: string | null;
};

/**
 * Resolve a user's auth state: `users.status` (pending | active | disabled)
 * is authoritative, with `disabled_at` honored as a hard override and a
 * legacy fallback (no credential ⇒ pending) for rows read before migration.
 * Unknown status values count as ineligible.
 */
export function userAuthState(row: UserStateRow): "pending" | "active" | "disabled" {
  if (row.disabled_at) return "disabled";
  if (typeof row.status === "string") {
    return row.status === "active" ? "active" : row.status === "pending" ? "pending" : "disabled";
  }
  return row.password_hash ? "active" : "pending";
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

// --- Owner transfer ---------------------------------------------------------

export interface TransferOwnerInput {
  /** Exactly one of targetUserId / targetEmail identifies the target. */
  targetUserId?: string;
  targetEmail?: string;
  /** Optional control-state version guard (the version GET /workspaces/:id returns). */
  expectedVersion?: number | null;
  reason: string;
}

export interface TransferOwnerResult {
  workspaceId: string;
  ownerUserId: string;
  previousOwnerUserId: string | null;
  version: number;
  /** false when the target already was the owner (semantic no-op repeat). */
  changed: boolean;
}

/**
 * Bounded hosting-superuser owner transfer (contract §Transfer ownership):
 * the target must already be an ACTIVE user of this workspace — never a new
 * user, never a cross-workspace move, never an email acting as authority (an
 * email here only *resolves* to an existing member). One transaction demotes
 * the previous owner to admin, promotes the target, preserves exactly one
 * owner, bumps the control-state version, and records both audits.
 */
export function transferWorkspaceOwner(db: Db, workspaceId: string, input: TransferOwnerInput): TransferOwnerResult {
  const ws = db.$client.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id: string } | undefined;
  if (!ws) throw new HcError(404, "not_found", "Unknown workspace");

  const access = getAccess(db, workspaceId);
  const currentVersion = access?.version ?? 0;
  if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
    throw new HcError(409, "version_conflict", `Control state version conflict; current version is ${currentVersion}`, {
      currentVersion,
    });
  }

  // Resolve the target inside this workspace only. Absent, foreign-workspace,
  // pending, and disabled targets all answer the same stable conflict so the
  // response can never leak another workspace's membership.
  const bySql = input.targetUserId
    ? { where: "u.id = ?", value: input.targetUserId }
    : { where: "u.email = ?", value: (input.targetEmail ?? "").trim().toLowerCase() };
  const target = db.$client
    .prepare(
      `SELECT u.* FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
       WHERE ${bySql.where}`,
    )
    .get(workspaceId, bySql.value) as ({ id: string } & UserStateRow) | undefined;
  if (!target || userAuthState(target) !== "active") {
    throw new HcError(409, "target_not_eligible", "Target must be an existing active user of this workspace");
  }

  const owner = db.$client
    .prepare("SELECT user_id AS userId FROM memberships WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId) as { userId: string } | undefined;

  // Repeating a completed transfer to the same target succeeds (no-op).
  if (owner?.userId === target.id) {
    return {
      workspaceId,
      ownerUserId: target.id,
      previousOwnerUserId: null,
      version: currentVersion,
      changed: false,
    };
  }

  // Atomic swap: demote every current owner, promote the target — exactly one
  // owner holds after commit even from a corrupt multi-owner state. This
  // mirrors the catalog's `users.transferOwnership` port (demote-then-promote,
  // active-target guard), which is async, workspace-scoped, and runs its own
  // ports.tx — unusable inside this sync receipt+mutation+audit transaction.
  // TODO(auth-phase): switch to the port if it ever gains a sync db-handle
  // form (as issueAuthCodeSync did for code issuance).
  db.$client
    .prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND role = 'owner' AND user_id != ?")
    .run(workspaceId, target.id);
  db.$client
    .prepare("UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?")
    .run(workspaceId, target.id);

  // The transfer is a control-state change (ownerUserId is part of the
  // inspect response), so it advances the same version `expectedVersion`
  // guards. Workspaces without a control row (never hosted) stay at 0.
  let version = currentVersion;
  if (access) {
    updateAccess(db, workspaceId, access.accessMode, access.accessExpiresAt);
    version = currentVersion + 1;
  }

  workspaceAuditEvent(db, workspaceId, "hosting.workspace.owner_transfer", "Workspace ownership transferred by hosting control", {
    previousOwnerUserId: owner?.userId ?? null,
    newOwnerUserId: target.id,
    reason: input.reason,
  });

  return {
    workspaceId,
    ownerUserId: target.id,
    previousOwnerUserId: owner?.userId ?? null,
    version,
    changed: true,
  };
}

// --- Owner recovery ---------------------------------------------------------

export interface OwnerRecoveryInitiation {
  workspaceId: string;
  ownerUserId: string;
  setup: SetupInitiation;
}

/**
 * Initiate credential recovery for the CURRENT owner (contract §Initiate
 * owner recovery): issue a single-use code and route it through the delivery
 * seam. A still-pending owner gets a fresh "setup" code, an active owner a
 * "reset" code. The response layer never returns credentials in hosted mode;
 * a disabled or absent owner is a stable conflict — recovery never picks a
 * different person (that is what owner transfer is for).
 */
export function initiateOwnerRecovery(db: Db, workspaceId: string, reason: string): OwnerRecoveryInitiation {
  const ws = db.$client.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id: string } | undefined;
  if (!ws) throw new HcError(404, "not_found", "Unknown workspace");

  const owner = db.$client
    .prepare(
      `SELECT u.* FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
       WHERE m.role = 'owner'`,
    )
    .get(workspaceId) as ({ id: string; email: string } & UserStateRow) | undefined;
  const state = owner ? userAuthState(owner) : null;
  if (!owner || state === "disabled") {
    throw new HcError(409, "owner_not_available", "The current owner cannot receive recovery for this workspace");
  }

  const purpose: AuthCodePurpose = state === "pending" ? "setup" : "reset";
  const setup = initiateCodeDelivery(db, workspaceId, owner.id, owner.email, purpose);

  workspaceAuditEvent(db, workspaceId, "hosting.workspace.owner_recovery", `Owner credential recovery initiated by hosting control (${purpose})`, {
    ownerUserId: owner.id,
    purpose,
    delivery: setup.delivery,
    reason,
  });

  return { workspaceId, ownerUserId: owner.id, setup };
}

// --- Permanent delete -------------------------------------------------------

/**
 * Physically removes every row belonging to the workspace: all
 * workspace-scoped CRM tables (discovered dynamically by their workspace_id
 * column, so tables added by future migrations are covered), users whose only
 * membership was this workspace, and their sessions. The hc_workspace_access
 * row and any queued hc_auth_delivery_outbox rows disappear too;
 * hc_service_audit keeps only one-way hashes.
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
  deleteOutboxForWorkspace(db, workspaceId);
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
