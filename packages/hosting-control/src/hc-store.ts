/**
 * Hosting-control's own SQLite tables and row helpers.
 *
 * These tables live in the same database file as the CRM but are owned and
 * created by THIS package on open — packages/db's versioned migrations are
 * never touched. All access goes through the raw better-sqlite3 client
 * (`db.$client`) so this package stays compatible with the sync drizzle
 * handle regardless of how the ports/catalog layer evolves.
 *
 * Tables:
 *   hc_idempotency_receipts — one row per (Idempotency-Key) mutation identity.
 *   hc_workspace_access     — generic hosting access state per workspace.
 *   hc_service_audit        — permanent service-action audit trail.
 */
import { nowIso } from "@emcp/core";
import type { Db } from "@emcp/db";

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
`;

/** Idempotent — safe to run on every process start. */
export function ensureHcTables(db: Db): void {
  db.$client.exec(HC_TABLES_SQL);
}

// --- Idempotency receipts ---------------------------------------------------

export interface Receipt {
  idempotencyKey: string;
  action: string;
  requestHash: string;
  targetHash: string | null;
  state: "pending" | "completed";
  httpStatus: number | null;
  responseBody: string | null;
  requestId: string;
  createdAt: string;
  completedAt: string | null;
}

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

function mapReceipt(row: ReceiptRow): Receipt {
  return {
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
  };
}

export function getReceipt(db: Db, idempotencyKey: string): Receipt | null {
  const row = db.$client
    .prepare("SELECT * FROM hc_idempotency_receipts WHERE idempotency_key = ?")
    .get(idempotencyKey) as ReceiptRow | undefined;
  return row ? mapReceipt(row) : null;
}

/**
 * Stale 'pending' rows (a crash between claim and commit) may be taken over
 * after this many milliseconds instead of returning request_in_progress
 * forever.
 */
const PENDING_TAKEOVER_MS = 60_000;

/**
 * Claim the idempotency key. Exactly one concurrent caller wins the claim;
 * everyone else receives the existing receipt (pending → request in progress,
 * completed → replay the stored response).
 */
export function beginReceipt(
  db: Db,
  idempotencyKey: string,
  action: string,
  requestHash: string,
  requestId: string,
): { started: true } | { started: false; receipt: Receipt } {
  const inserted = db.$client
    .prepare(
      `INSERT INTO hc_idempotency_receipts (idempotency_key, action, request_hash, state, request_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .run(idempotencyKey, action, requestHash, requestId, nowIso());
  if (inserted.changes === 1) return { started: true };

  const receipt = getReceipt(db, idempotencyKey);
  if (!receipt) return { started: true }; // deleted between statements; treat as claimed
  if (receipt.state === "pending") {
    const age = Date.now() - Date.parse(receipt.createdAt);
    if (Number.isFinite(age) && age > PENDING_TAKEOVER_MS) {
      const takeover = db.$client
        .prepare(
          `UPDATE hc_idempotency_receipts SET request_id = ?, created_at = ?
           WHERE idempotency_key = ? AND state = 'pending' AND created_at = ?`,
        )
        .run(requestId, nowIso(), idempotencyKey, receipt.createdAt);
      if (takeover.changes === 1) return { started: true };
    }
  }
  return { started: false, receipt };
}

/** Marks the receipt completed. Call inside the same mutation transaction. */
export function completeReceipt(
  db: Db,
  idempotencyKey: string,
  done: { targetHash: string | null; httpStatus: number; responseBody: string | null },
): void {
  db.$client
    .prepare(
      `UPDATE hc_idempotency_receipts
       SET state = 'completed', target_hash = ?, http_status = ?, response_body = ?, completed_at = ?
       WHERE idempotency_key = ?`,
    )
    .run(done.targetHash, done.httpStatus, done.responseBody, nowIso(), idempotencyKey);
}

/** Releases a claimed key after a failed execution so the caller may retry. */
export function abandonReceipt(db: Db, idempotencyKey: string): void {
  db.$client
    .prepare("DELETE FROM hc_idempotency_receipts WHERE idempotency_key = ? AND state = 'pending'")
    .run(idempotencyKey);
}

// --- Workspace access state -------------------------------------------------

export interface AccessState {
  workspaceId: string;
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  version: number;
}

interface AccessRow {
  workspace_id: string;
  access_mode: string;
  access_expires_at: string | null;
  version: number;
}

export function getAccess(db: Db, workspaceId: string): AccessState | null {
  const row = db.$client
    .prepare("SELECT workspace_id, access_mode, access_expires_at, version FROM hc_workspace_access WHERE workspace_id = ?")
    .get(workspaceId) as AccessRow | undefined;
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    accessMode: row.access_mode === "locked" ? "locked" : "active",
    accessExpiresAt: row.access_expires_at,
    version: row.version,
  };
}

export function insertAccess(db: Db, workspaceId: string, mode: "active" | "locked", expiresAt: string | null): void {
  const now = nowIso();
  db.$client
    .prepare(
      `INSERT INTO hc_workspace_access (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(workspaceId, mode, expiresAt, now, now);
}

export function updateAccess(db: Db, workspaceId: string, mode: "active" | "locked", expiresAt: string | null): void {
  db.$client
    .prepare(
      `UPDATE hc_workspace_access
       SET access_mode = ?, access_expires_at = ?, version = version + 1, updated_at = ?
       WHERE workspace_id = ?`,
    )
    .run(mode, expiresAt, nowIso(), workspaceId);
}

export function deleteAccess(db: Db, workspaceId: string): void {
  db.$client.prepare("DELETE FROM hc_workspace_access WHERE workspace_id = ?").run(workspaceId);
}

// --- Service audit ----------------------------------------------------------

export interface ServiceAuditInput {
  id: string;
  requestId: string;
  idempotencyKey: string | null;
  action: string;
  method: string;
  path: string;
  workspaceId: string | null;
  targetHash: string | null;
  reason: string | null;
  serviceIdentity: string;
  resultCode: string;
  httpStatus: number;
  retryable: boolean;
  productVersion: string | null;
  startedAt: string;
  completedAt: string;
}

export function writeAudit(db: Db, a: ServiceAuditInput): void {
  db.$client
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
}

/**
 * After permanent deletion only the one-way target hash may remain in the
 * global audit trail — the raw workspace id is scrubbed from earlier rows.
 */
export function redactAuditForWorkspace(db: Db, workspaceId: string): void {
  db.$client.prepare("UPDATE hc_service_audit SET workspace_id = NULL WHERE workspace_id = ?").run(workspaceId);
}
