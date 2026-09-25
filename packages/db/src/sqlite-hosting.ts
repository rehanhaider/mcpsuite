/**
 * SQLite implementation of the hosting-control data interface (./hosting.ts).
 *
 * The SQL here moved out of packages/hosting-control unchanged: its own
 * hc_* tables (created on open, never part of ./schema-sql.ts) and the CRM
 * rows a lifecycle action touches. Every method is a unit of work on the
 * shared connection (./sqlite-tx.ts), so it joins the request's open
 * transaction and otherwise waits for other requests' transactions.
 *
 * Permanent deletion removes the workspace-scoped tables from an explicit
 * list (WORKSPACE_SCOPED_TABLES) instead of discovering them at run time;
 * test/sqlite-hosting.test.ts fails when the schema gains a workspace-scoped
 * table the list does not name.
 */
import { DEFAULT_WORKSPACE_SETTINGS, newId, nowIso } from "@mcpsuite/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { DEFAULT_DEAL_STAGES, DEFAULT_ENGAGEMENT_STAGES } from "./bootstrap.ts";
import { createSqliteIdentity } from "./sqlite-identity.ts";
import { withConnection } from "./sqlite-tx.ts";
import type { AccessState, HostedMember, HostingStore, OutboxRow, Receipt } from "./hosting.ts";
import type { IdentityStore } from "./identity.ts";

const HC_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS hc_idempotency_receipts (
  idempotency_key TEXT PRIMARY KEY,
  action          TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  target_hash     TEXT,
  state           TEXT NOT NULL DEFAULT 'pending',
  http_status     INTEGER,
  response_body   TEXT,
  request_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE TABLE IF NOT EXISTS hc_workspace_access (
  workspace_id      TEXT PRIMARY KEY,
  access_mode       TEXT NOT NULL DEFAULT 'active',
  access_expires_at TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hc_service_audit (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL,
  idempotency_key  TEXT,
  action           TEXT NOT NULL,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  workspace_id     TEXT,
  target_hash      TEXT,
  reason           TEXT,
  service_identity TEXT NOT NULL,
  result_code      TEXT NOT NULL,
  http_status      INTEGER NOT NULL,
  retryable        INTEGER NOT NULL DEFAULT 0,
  product_version  TEXT,
  started_at       TEXT NOT NULL,
  completed_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hc_service_audit_ws_ix ON hc_service_audit(workspace_id);
CREATE INDEX IF NOT EXISTS hc_service_audit_hash_ix ON hc_service_audit(target_hash);
CREATE TABLE IF NOT EXISTS hc_auth_delivery_outbox (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hc_auth_outbox_state_ix ON hc_auth_delivery_outbox(state);
CREATE INDEX IF NOT EXISTS hc_auth_outbox_ws_ix ON hc_auth_delivery_outbox(workspace_id);
`;

/**
 * Every CRM table carrying a workspace_id column, in schema (creation) order
 * — the order permanent deletion removes them in. `workspaces` itself is
 * deleted last, separately.
 */
export const WORKSPACE_SCOPED_TABLES = [
  "memberships",
  "mcp_clients",
  "workspace_counters",
  "companies",
  "people",
  "company_people",
  "pipelines",
  "stages",
  "engagements",
  "deals",
  "deal_stakeholders",
  "offerings",
  "offering_links",
  "activities",
  "tags",
  "taggings",
  "lists",
  "list_members",
  "custom_field_definitions",
  "custom_field_values",
  "saved_views",
  "pending_actions",
  "audit_events",
] as const;

/**
 * Stale 'pending' receipts (a crash between claim and commit) may be taken
 * over after this many milliseconds instead of answering request_in_progress
 * forever.
 */
const PENDING_TAKEOVER_MS = 60_000;

interface ReceiptRow {
  idempotency_key: string;
  action: string;
  request_hash: string;
  target_hash: string | null;
  state: string;
  http_status: number | null;
  response_body: string | null;
  request_id: string;
  created_at: string;
  completed_at: string | null;
}

const mapReceipt = (row: ReceiptRow): Receipt => ({
  idempotencyKey: row.idempotency_key,
  action: row.action,
  requestHash: row.request_hash,
  targetHash: row.target_hash,
  state: row.state === "completed" ? "completed" : "pending",
  httpStatus: row.http_status,
  responseBody: row.response_body,
  requestId: row.request_id,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

interface UserRow {
  id: string;
  email: string;
  status?: string | null;
  disabled_at?: string | null;
  password_hash?: string | null;
}

const mapMember = (row: UserRow): HostedMember => ({
  id: row.id,
  email: row.email,
  status: typeof row.status === "string" ? row.status : null,
  disabledAt: row.disabled_at ?? null,
  hasPassword: row.password_hash != null,
});

export function createSqliteHostingStore(db: Db, options: { identity?: IdentityStore } = {}): HostingStore {
  const sqlite = db.$client;
  const identity = options.identity ?? createSqliteIdentity(db);
  const unit = <T>(fn: () => T | Promise<T>): Promise<T> => withConnection(sqlite, fn);

  const getReceiptSync = (idempotencyKey: string): Receipt | null => {
    const row = sqlite.prepare("SELECT * FROM hc_idempotency_receipts WHERE idempotency_key = ?").get(idempotencyKey) as
      | ReceiptRow
      | undefined;
    return row ? mapReceipt(row) : null;
  };

  const getAccessSync = (workspaceId: string): AccessState | null => {
    const row = sqlite
      .prepare("SELECT workspace_id, access_mode, access_expires_at, version FROM hc_workspace_access WHERE workspace_id = ?")
      .get(workspaceId) as
      | { workspace_id: string; access_mode: string; access_expires_at: string | null; version: number }
      | undefined;
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      accessMode: row.access_mode === "locked" ? "locked" : "active",
      accessExpiresAt: row.access_expires_at,
      version: row.version,
    };
  };

  const seedPipeline = (
    workspaceId: string,
    type: "engagement" | "deal",
    name: string,
    stages: typeof DEFAULT_ENGAGEMENT_STAGES,
  ): void => {
    const pipelineId = newId();
    db.insert(t.pipelines)
      .values({ id: pipelineId, workspaceId, type, name, isDefault: 1, position: 0, createdAt: nowIso() })
      .run();
    stages.forEach((s, i) => {
      db.insert(t.stages)
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
  };

  return {
    adapter: "sqlite",
    identity,
    withTransaction: (fn) => identity.withTransaction(fn),
    ensureSchema: () => unit(() => void sqlite.exec(HC_TABLES_SQL)),
    schemaVersion: () => unit(() => Number(sqlite.pragma("user_version", { simple: true })) || 0),

    // --- receipts ---------------------------------------------------------
    beginReceipt: (idempotencyKey, action, requestHash, requestId) =>
      unit(() => {
        const inserted = sqlite
          .prepare(
            `INSERT INTO hc_idempotency_receipts (idempotency_key, action, request_hash, state, request_id, created_at)
             VALUES (?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(idempotency_key) DO NOTHING`,
          )
          .run(idempotencyKey, action, requestHash, requestId, nowIso());
        if (inserted.changes === 1) return { started: true as const };
        const receipt = getReceiptSync(idempotencyKey);
        if (!receipt) return { started: true as const }; // deleted between statements; treat as claimed
        if (receipt.state === "pending") {
          const age = Date.now() - Date.parse(receipt.createdAt);
          if (Number.isFinite(age) && age > PENDING_TAKEOVER_MS) {
            const takeover = sqlite
              .prepare(
                `UPDATE hc_idempotency_receipts SET request_id = ?, created_at = ?
                 WHERE idempotency_key = ? AND state = 'pending' AND created_at = ?`,
              )
              .run(requestId, nowIso(), idempotencyKey, receipt.createdAt);
            if (takeover.changes === 1) return { started: true as const };
          }
        }
        return { started: false as const, receipt };
      }),
    completeReceipt: (idempotencyKey, done) =>
      unit(() => {
        sqlite
          .prepare(
            `UPDATE hc_idempotency_receipts
             SET state = 'completed', target_hash = ?, http_status = ?, response_body = ?, completed_at = ?
             WHERE idempotency_key = ?`,
          )
          .run(done.targetHash, done.httpStatus, done.responseBody, nowIso(), idempotencyKey);
      }),
    abandonReceipt: (idempotencyKey) =>
      unit(() => {
        sqlite.prepare("DELETE FROM hc_idempotency_receipts WHERE idempotency_key = ? AND state = 'pending'").run(idempotencyKey);
      }),
    getReceipt: (idempotencyKey) => unit(() => getReceiptSync(idempotencyKey)),

    // --- service audit ----------------------------------------------------
    writeAudit: (a) =>
      unit(() => {
        sqlite
          .prepare(
            `INSERT INTO hc_service_audit
              (id, request_id, idempotency_key, action, method, path, workspace_id, target_hash, reason,
               service_identity, result_code, http_status, retryable, product_version, started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            a.id,
            a.requestId,
            a.idempotencyKey,
            a.action,
            a.method,
            a.path,
            a.workspaceId,
            a.targetHash,
            a.reason,
            a.serviceIdentity,
            a.resultCode,
            a.httpStatus,
            a.retryable ? 1 : 0,
            a.productVersion,
            a.startedAt,
            a.completedAt,
          );
      }),
    redactAudit: (workspaceId) =>
      unit(() => {
        sqlite.prepare("UPDATE hc_service_audit SET workspace_id = NULL WHERE workspace_id = ?").run(workspaceId);
      }),

    // --- outbox -----------------------------------------------------------
    insertOutbox: (row) =>
      unit(() => {
        const now = nowIso();
        sqlite
          .prepare(
            `INSERT INTO hc_auth_delivery_outbox (id, workspace_id, user_id, purpose, state, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .run(row.id, row.workspaceId, row.userId, row.purpose, now, now);
      }),
    markOutbox: (id, state, lastError) =>
      unit(() => {
        sqlite
          .prepare(
            `UPDATE hc_auth_delivery_outbox
             SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(state, lastError ?? null, nowIso(), id);
      }),
    listPendingOutbox: () =>
      unit(() => {
        const rows = sqlite
          .prepare(
            `SELECT id, workspace_id, user_id, purpose, state, attempts
             FROM hc_auth_delivery_outbox WHERE state = 'pending' ORDER BY created_at`,
          )
          .all() as Array<{ id: string; workspace_id: string; user_id: string; purpose: string; state: string; attempts: number }>;
        return rows.map(
          (r): OutboxRow => ({
            id: r.id,
            workspaceId: r.workspace_id,
            userId: r.user_id,
            purpose: r.purpose === "reset" ? "reset" : "setup",
            state: r.state === "sent" ? "sent" : r.state === "abandoned" ? "abandoned" : "pending",
            attempts: r.attempts,
          }),
        );
      }),
    deleteOutbox: (workspaceId) =>
      unit(() => {
        sqlite.prepare("DELETE FROM hc_auth_delivery_outbox WHERE workspace_id = ?").run(workspaceId);
      }),

    // --- access -----------------------------------------------------------
    getAccess: (workspaceId) => unit(() => getAccessSync(workspaceId)),
    insertAccess: (workspaceId, mode, expiresAt) =>
      unit(() => {
        const now = nowIso();
        sqlite
          .prepare(
            `INSERT INTO hc_workspace_access (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(workspaceId, mode, expiresAt, now, now);
      }),
    updateAccess: (workspaceId, mode, expiresAt) =>
      unit(() => {
        sqlite
          .prepare(
            `UPDATE hc_workspace_access
             SET access_mode = ?, access_expires_at = ?, version = version + 1, updated_at = ?
             WHERE workspace_id = ?`,
          )
          .run(mode, expiresAt, nowIso(), workspaceId);
      }),
    deleteAccess: (workspaceId) =>
      unit(() => {
        sqlite.prepare("DELETE FROM hc_workspace_access WHERE workspace_id = ?").run(workspaceId);
      }),

    // --- CRM rows ---------------------------------------------------------
    workspaceExists: (workspaceId) =>
      unit(() => sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) != null),
    createWorkspace: (input) =>
      unit(() => {
        const now = nowIso();
        db.insert(t.workspaces)
          .values({
            id: input.id,
            name: input.name,
            defaultCurrency: input.defaultCurrency,
            timezone: input.timezone,
            settings: JSON.stringify(DEFAULT_WORKSPACE_SETTINGS),
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }),
    createOwner: (workspaceId, owner) =>
      unit(() => {
        const existing = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(owner.email);
        if (existing) return "email_taken" as const;
        const now = nowIso();
        db.insert(t.users)
          .values({
            id: owner.id,
            email: owner.email,
            name: owner.name,
            passwordHash: null,
            status: owner.status,
            authSubject: owner.authSubject,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(t.memberships).values({ id: newId(), workspaceId, userId: owner.id, role: "owner", createdAt: now }).run();
        return "created" as const;
      }),
    seedDefaultPipelines: (workspaceId) =>
      unit(() => {
        seedPipeline(workspaceId, "engagement", "Outreach", DEFAULT_ENGAGEMENT_STAGES);
        seedPipeline(workspaceId, "deal", "Sales", DEFAULT_DEAL_STAGES);
      }),
    ownerOf: (workspaceId) =>
      unit(() => {
        const row = sqlite
          .prepare(
            `SELECT u.* FROM users u
             JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
             WHERE m.role = 'owner'`,
          )
          .get(workspaceId) as UserRow | undefined;
        return row ? mapMember(row) : null;
      }),
    findMember: (workspaceId, by) =>
      unit(() => {
        const [where, value] =
          "userId" in by ? ["u.id = ?", by.userId] : ["u.email = ?", by.email.trim().toLowerCase()];
        const row = sqlite
          .prepare(
            `SELECT u.* FROM users u
             JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
             WHERE ${where}`,
          )
          .get(workspaceId, value) as UserRow | undefined;
        return row ? mapMember(row) : null;
      }),
    swapOwner: (workspaceId, targetUserId) =>
      unit(() => {
        sqlite
          .prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND role = 'owner' AND user_id != ?")
          .run(workspaceId, targetUserId);
        sqlite.prepare("UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, targetUserId);
      }),
    workspaceAuditEvent: (workspaceId, operation, summary, meta) =>
      unit(() => {
        db.insert(t.auditEvents)
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
      }),
    memberForDelivery: (_workspaceId, userId) =>
      unit(() => {
        const row = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
        return row ? mapMember(row) : null;
      }),
    deleteWorkspace: (workspaceId) =>
      unit(() => {
        if (!sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId)) return false;
        const memberIds = (
          sqlite.prepare("SELECT user_id AS userId FROM memberships WHERE workspace_id = ?").all(workspaceId) as Array<{
            userId: string;
          }>
        ).map((r) => r.userId);
        for (const table of WORKSPACE_SCOPED_TABLES) {
          sqlite.prepare(`DELETE FROM "${table}" WHERE workspace_id = ?`).run(workspaceId);
        }
        // Users are global rows reached via memberships; remove the ones that
        // no longer belong to any workspace (single-membership model), plus
        // their sessions.
        if (memberIds.length > 0) {
          const placeholders = memberIds.map(() => "?").join(",");
          sqlite
            .prepare(
              `DELETE FROM sessions WHERE user_id IN (${placeholders})
               AND user_id NOT IN (SELECT user_id FROM memberships)`,
            )
            .run(...memberIds);
          sqlite
            .prepare(
              `DELETE FROM users WHERE id IN (${placeholders})
               AND id NOT IN (SELECT user_id FROM memberships)`,
            )
            .run(...memberIds);
        }
        sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
        return true;
      }),
  };
}
