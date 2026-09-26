/**
 * PostgreSQL implementation of the hosting-control data interface
 * (../hosting.ts), for the private hosting control service connecting as
 * crm_operator (schema.sql, "Hosting control").
 *
 * crm_operator has no BYPASSRLS. Every method that names a workspace binds
 * the request's transaction to it first (./tx.ts), so the CRM rows,
 * hosting.workspace_access and the delivery outbox it reaches are that
 * workspace's only — it cannot list workspaces or read another one's rows.
 * Receipts and the service audit are hosting control's own records (not
 * workspace-bound); the delivery sweep lists pending deliveries only through
 * hosting.pending_auth_deliveries(). All SQL is fixed statements with bound
 * parameters.
 *
 * Permanent deletion purges each member's issuer credentials
 * (crm.purge_openauth_identity), then deletes the workspace row; every
 * workspace-owned table, the users, their sessions and codes, the access
 * state and the outbox cascade from it (schema.sql foreign keys).
 */
import { sql, type SQL } from "drizzle-orm";
import { DEFAULT_WORKSPACE_SETTINGS, newId, nowIso } from "@mcpsuite/core";
import { DEFAULT_DEAL_STAGES, DEFAULT_ENGAGEMENT_STAGES } from "../bootstrap.ts";
import type { AccessState, HostedMember, HostingStore, OutboxRow, Receipt } from "../hosting.ts";
import type { IdentityStore } from "../identity.ts";
import { redactDatabaseUrl } from "../runtime.ts";
import { createPgIdentity } from "./identity.ts";
import { connectPg, type PgDb } from "./repositories.ts";
import { inPgNestedTransaction, inPgTransaction } from "./tx.ts";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Malformed ids must behave like random nonexistent ids, not type errors. */
const uid = (v: string): string => (UUID_RE.test(v) ? v : NIL_UUID);

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoN = (v: unknown): string | null => (v == null ? null : iso(v));

/** Walks err.cause chains for the SQLSTATE the pg driver attaches. */
const pgErrorCode = (e: unknown): string | undefined => {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
};

/** Same takeover window as the SQLite adapter. */
const PENDING_TAKEOVER_MS = 60_000;

const rows = async <T = Record<string, unknown>>(x: PgDb, q: SQL): Promise<T[]> => {
  const res = (await x.execute(q)) as unknown;
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: unknown[] }).rows ?? []) as T[];
};

interface ReceiptRow {
  idempotency_key: string;
  action: string;
  request_hash: string;
  target_hash: string | null;
  state: string;
  http_status: number | null;
  response_body: string | null;
  request_id: string;
  created_at: unknown;
  completed_at: unknown;
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
  createdAt: iso(row.created_at),
  completedAt: isoN(row.completed_at),
});

interface MemberRow {
  id: string;
  email: string;
  status: string;
  disabled_at: unknown;
  has_password: boolean;
}

const mapMember = (row: MemberRow): HostedMember => ({
  id: row.id,
  email: row.email,
  status: row.status,
  disabledAt: isoN(row.disabled_at),
  hasPassword: row.has_password === true,
});

const MEMBER_COLUMNS = sql`u.id, u.email, u.status, u.disabled_at, (u.password_hash IS NOT NULL) AS has_password`;

export function createPgHostingStore(db: PgDb, options: { identity?: IdentityStore } = {}): HostingStore {
  const identity = options.identity ?? createPgIdentity(db);
  /** The request's transaction: unbound, or bound to one workspace. */
  const inTx = <T>(workspaceId: string | null, fn: (x: PgDb) => Promise<T>): Promise<T> =>
    inPgTransaction(db, workspaceId === null ? null : uid(workspaceId), fn);

  const getReceipt = (x: PgDb, key: string): Promise<Receipt | null> =>
    rows<ReceiptRow>(x, sql`SELECT * FROM hosting.idempotency_receipts WHERE idempotency_key = ${key}`).then(([r]) =>
      r ? mapReceipt(r) : null,
    );

  const seedPipeline = async (
    x: PgDb,
    workspaceId: string,
    type: "engagement" | "deal",
    name: string,
    stages: typeof DEFAULT_ENGAGEMENT_STAGES,
  ): Promise<void> => {
    const pipelineId = newId();
    await rows(
      x,
      sql`INSERT INTO crm.pipelines (id, workspace_id, type, name, is_default, position, created_at)
          VALUES (${pipelineId}::uuid, ${workspaceId}::uuid, ${type}, ${name}, true, 0, ${nowIso()}::timestamptz)`,
    );
    for (const [i, s] of stages.entries()) {
      await rows(
        x,
        sql`INSERT INTO crm.stages (id, workspace_id, pipeline_id, name, color, position, probability, outcome)
            VALUES (${newId()}::uuid, ${workspaceId}::uuid, ${pipelineId}::uuid, ${s.name}, ${s.color}, ${i},
                    ${s.probability ?? null}, ${s.outcome ?? null})`,
      );
    }
  };

  return {
    adapter: "postgres",
    identity,
    withTransaction: (fn) => identity.withTransaction(fn),

    // The schema is applied at deployment (./init.ts); hosting control only
    // checks that its tables are there.
    ensureSchema: () =>
      inTx(null, async (x) => {
        const [row] = await rows<{ reg: string | null }>(x, sql`SELECT to_regclass('hosting.workspace_access')::text AS reg`);
        if (!row?.reg) {
          throw new Error("The PostgreSQL database has no hosting schema: apply packages/db/src/pg/schema.sql first");
        }
      }),
    schemaVersion: () =>
      inTx(null, async (x) => {
        const [row] = await rows<{ v: number | null }>(x, sql`SELECT max(version) AS v FROM crm.schema_version`);
        return Number(row?.v ?? 0);
      }),

    // --- receipts ---------------------------------------------------------
    beginReceipt: (idempotencyKey, action, requestHash, requestId) =>
      inTx(null, async (x) => {
        const inserted = await rows(
          x,
          sql`INSERT INTO hosting.idempotency_receipts (idempotency_key, action, request_hash, state, request_id, created_at)
              VALUES (${idempotencyKey}, ${action}, ${requestHash}, 'pending', ${requestId}, ${nowIso()}::timestamptz)
              ON CONFLICT (idempotency_key) DO NOTHING
              RETURNING 1`,
        );
        if (inserted.length === 1) return { started: true as const };
        const receipt = await getReceipt(x, idempotencyKey);
        if (!receipt) return { started: true as const }; // deleted between statements; treat as claimed
        if (receipt.state === "pending") {
          const age = Date.now() - Date.parse(receipt.createdAt);
          if (Number.isFinite(age) && age > PENDING_TAKEOVER_MS) {
            const takeover = await rows(
              x,
              sql`UPDATE hosting.idempotency_receipts SET request_id = ${requestId}, created_at = ${nowIso()}::timestamptz
                  WHERE idempotency_key = ${idempotencyKey} AND state = 'pending'
                    AND created_at = ${receipt.createdAt}::timestamptz
                  RETURNING 1`,
            );
            if (takeover.length === 1) return { started: true as const };
          }
        }
        return { started: false as const, receipt };
      }),
    completeReceipt: (idempotencyKey, done) =>
      inTx(null, async (x) => {
        await rows(
          x,
          sql`UPDATE hosting.idempotency_receipts
              SET state = 'completed', target_hash = ${done.targetHash}, http_status = ${done.httpStatus},
                  response_body = ${done.responseBody}, completed_at = ${nowIso()}::timestamptz
              WHERE idempotency_key = ${idempotencyKey}`,
        );
      }),
    abandonReceipt: (idempotencyKey) =>
      inTx(null, async (x) => {
        await rows(
          x,
          sql`DELETE FROM hosting.idempotency_receipts WHERE idempotency_key = ${idempotencyKey} AND state = 'pending'`,
        );
      }),
    getReceipt: (idempotencyKey) => inTx(null, (x) => getReceipt(x, idempotencyKey)),

    // --- service audit ----------------------------------------------------
    writeAudit: (a) =>
      inTx(null, async (x) => {
        await rows(
          x,
          sql`INSERT INTO hosting.service_audit
                (id, request_id, idempotency_key, action, method, path, workspace_id, target_hash, reason,
                 service_identity, result_code, http_status, retryable, product_version, started_at, completed_at)
              VALUES (${a.id}::uuid, ${a.requestId}, ${a.idempotencyKey}, ${a.action}, ${a.method}, ${a.path},
                      ${a.workspaceId}, ${a.targetHash}, ${a.reason}, ${a.serviceIdentity}, ${a.resultCode},
                      ${a.httpStatus}, ${a.retryable}, ${a.productVersion}, ${a.startedAt}::timestamptz,
                      ${a.completedAt}::timestamptz)`,
        );
      }),
    redactAudit: (workspaceId) =>
      inTx(null, async (x) => {
        await rows(x, sql`UPDATE hosting.service_audit SET workspace_id = NULL WHERE workspace_id = ${workspaceId}`);
      }),

    // --- outbox -----------------------------------------------------------
    insertOutbox: (row) =>
      inTx(row.workspaceId, async (x) => {
        const now = nowIso();
        await rows(
          x,
          sql`INSERT INTO hosting.auth_delivery_outbox (id, workspace_id, user_id, purpose, state, attempts, created_at, updated_at)
              VALUES (${row.id}::uuid, ${uid(row.workspaceId)}::uuid, ${uid(row.userId)}::uuid, ${row.purpose}, 'pending', 0,
                      ${now}::timestamptz, ${now}::timestamptz)`,
        );
      }),
    markOutbox: (workspaceId, id, state, lastError) =>
      inTx(workspaceId, async (x) => {
        await rows(
          x,
          sql`UPDATE hosting.auth_delivery_outbox
              SET state = ${state}, attempts = attempts + 1, last_error = ${lastError ?? null}, updated_at = ${nowIso()}::timestamptz
              WHERE id = ${uid(id)}::uuid`,
        );
      }),
    listPendingOutbox: () =>
      inTx(null, async (x) => {
        const found = await rows<{ id: string; workspace_id: string; user_id: string; purpose: string; attempts: number }>(
          x,
          sql`SELECT id, workspace_id, user_id, purpose, attempts FROM hosting.pending_auth_deliveries()`,
        );
        return found.map(
          (r): OutboxRow => ({
            id: r.id,
            workspaceId: r.workspace_id,
            userId: r.user_id,
            purpose: r.purpose === "reset" ? "reset" : "setup",
            state: "pending",
            attempts: r.attempts,
          }),
        );
      }),
    deleteOutbox: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        await rows(x, sql`DELETE FROM hosting.auth_delivery_outbox WHERE workspace_id = ${uid(workspaceId)}::uuid`);
      }),

    // --- access (workspace-bound) -----------------------------------------
    getAccess: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const [row] = await rows<{ workspace_id: string; access_mode: string; access_expires_at: unknown; version: number }>(
          x,
          sql`SELECT workspace_id, access_mode, access_expires_at, version FROM hosting.workspace_access
              WHERE workspace_id = ${uid(workspaceId)}::uuid`,
        );
        if (!row) return null;
        return {
          workspaceId: row.workspace_id,
          accessMode: row.access_mode === "locked" ? "locked" : "active",
          accessExpiresAt: isoN(row.access_expires_at),
          version: row.version,
        } satisfies AccessState;
      }),
    insertAccess: (workspaceId, mode, expiresAt) =>
      inTx(workspaceId, async (x) => {
        const now = nowIso();
        await rows(
          x,
          sql`INSERT INTO hosting.workspace_access (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
              VALUES (${uid(workspaceId)}::uuid, ${mode}, ${expiresAt}::timestamptz, 1, ${now}::timestamptz, ${now}::timestamptz)`,
        );
      }),
    updateAccess: (workspaceId, mode, expiresAt) =>
      inTx(workspaceId, async (x) => {
        await rows(
          x,
          sql`UPDATE hosting.workspace_access
              SET access_mode = ${mode}, access_expires_at = ${expiresAt}::timestamptz, version = version + 1,
                  updated_at = ${nowIso()}::timestamptz
              WHERE workspace_id = ${uid(workspaceId)}::uuid`,
        );
      }),
    deleteAccess: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        await rows(x, sql`DELETE FROM hosting.workspace_access WHERE workspace_id = ${uid(workspaceId)}::uuid`);
      }),

    // --- CRM rows (workspace-bound) ---------------------------------------
    workspaceExists: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const found = await rows(x, sql`SELECT 1 FROM crm.workspaces WHERE id = ${uid(workspaceId)}::uuid`);
        return found.length === 1;
      }),
    // READ COMMITTED lets two requests read the same version and both write;
    // the row lock makes the second wait for the first to commit. NO KEY
    // UPDATE conflicts with itself but not with the key-share locks foreign
    // key checks take, so CRM inserts into the workspace are not blocked.
    lockWorkspace: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const found = await rows(
          x,
          sql`SELECT 1 FROM crm.workspaces WHERE id = ${uid(workspaceId)}::uuid FOR NO KEY UPDATE`,
        );
        return found.length === 1;
      }),
    createWorkspace: (input) =>
      inTx(input.id, async (x) => {
        const now = nowIso();
        await rows(
          x,
          sql`INSERT INTO crm.workspaces (id, name, default_currency, timezone, settings, created_at, updated_at)
              VALUES (${uid(input.id)}::uuid, ${input.name}, ${input.defaultCurrency}, ${input.timezone},
                      ${JSON.stringify(DEFAULT_WORKSPACE_SETTINGS)}::jsonb, ${now}::timestamptz, ${now}::timestamptz)`,
        );
      }),
    createOwner: (workspaceId, owner) =>
      inTx(workspaceId, async () => {
        // Email (and subject) are deployment-wide unique, but row-level
        // security hides other workspaces' users, so the unique index is the
        // only way to learn the address is taken. The savepoint keeps the
        // failed insert from aborting the request's transaction.
        try {
          await inPgNestedTransaction(db, uid(workspaceId), async (sp) => {
            const now = nowIso();
            await rows(
              sp,
              sql`INSERT INTO crm.users (id, workspace_id, email, name, password_hash, status, auth_subject, created_at, updated_at)
                  VALUES (${uid(owner.id)}::uuid, ${uid(workspaceId)}::uuid, ${owner.email}, ${owner.name}, NULL, ${owner.status},
                          ${owner.authSubject}, ${now}::timestamptz, ${now}::timestamptz)`,
            );
            await rows(
              sp,
              sql`INSERT INTO crm.memberships (id, workspace_id, user_id, role, created_at)
                  VALUES (${newId()}::uuid, ${uid(workspaceId)}::uuid, ${uid(owner.id)}::uuid, 'owner', ${now}::timestamptz)`,
            );
          });
        } catch (e) {
          if (pgErrorCode(e) === "23505") return "email_taken" as const;
          throw e;
        }
        return "created" as const;
      }),
    seedDefaultPipelines: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        await seedPipeline(x, uid(workspaceId), "engagement", "Outreach", DEFAULT_ENGAGEMENT_STAGES);
        await seedPipeline(x, uid(workspaceId), "deal", "Sales", DEFAULT_DEAL_STAGES);
      }),
    ownerOf: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const [row] = await rows<MemberRow>(
          x,
          sql`SELECT ${MEMBER_COLUMNS} FROM crm.users u
              JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
              WHERE m.role = 'owner'`,
        );
        return row ? mapMember(row) : null;
      }),
    findMember: (workspaceId, by) =>
      inTx(workspaceId, async (x) => {
        const where =
          "userId" in by ? sql`u.id = ${uid(by.userId)}::uuid` : sql`u.email = ${by.email.trim().toLowerCase()}`;
        const [row] = await rows<MemberRow>(
          x,
          sql`SELECT ${MEMBER_COLUMNS} FROM crm.users u
              JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
              WHERE ${where}`,
        );
        return row ? mapMember(row) : null;
      }),
    swapOwner: (workspaceId, targetUserId) =>
      inTx(workspaceId, async (x) => {
        await rows(
          x,
          sql`UPDATE crm.memberships SET role = 'admin' WHERE role = 'owner' AND user_id <> ${uid(targetUserId)}::uuid`,
        );
        await rows(x, sql`UPDATE crm.memberships SET role = 'owner' WHERE user_id = ${uid(targetUserId)}::uuid`);
      }),
    workspaceAuditEvent: (workspaceId, operation, summary, meta) =>
      inTx(workspaceId, async (x) => {
        await rows(
          x,
          sql`INSERT INTO crm.audit_events
                (id, workspace_id, operation, entity_type, entity_id, summary, meta, actor_type, actor_user_id,
                 actor_client_id, surface, created_at)
              VALUES (${newId()}::uuid, ${uid(workspaceId)}::uuid, ${operation}, 'workspace', ${workspaceId}, ${summary},
                      ${meta ? JSON.stringify(meta) : null}::jsonb, 'system', NULL, NULL, 'system', ${nowIso()}::timestamptz)`,
        );
      }),
    memberForDelivery: (workspaceId, userId) =>
      inTx(workspaceId, async (x) => {
        const [row] = await rows<MemberRow>(x, sql`SELECT ${MEMBER_COLUMNS} FROM crm.users u WHERE u.id = ${uid(userId)}::uuid`);
        return row ? mapMember(row) : null;
      }),
    deleteWorkspace: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const found = await rows(x, sql`SELECT 1 FROM crm.workspaces WHERE id = ${uid(workspaceId)}::uuid FOR UPDATE`);
        if (found.length === 0) return false;
        const members = await rows<{ id: string }>(x, sql`SELECT id FROM crm.users`);
        for (const m of members) await rows(x, sql`SELECT crm.purge_openauth_identity(${m.id}::uuid)`);
        await rows(x, sql`DELETE FROM crm.workspaces WHERE id = ${uid(workspaceId)}::uuid`);
        return true;
      }),
  };
}

/**
 * Connect hosting control's own pool. The URL must carry the crm_operator
 * login; the connection is checked once so a bad URL fails at startup.
 */
export async function connectPgHostingStore(databaseUrl: string): Promise<{ store: HostingStore; close(): Promise<void> }> {
  const handle = await connectPg({ databaseUrl });
  try {
    await handle.pool.query("select 1");
  } catch (cause) {
    await handle.close().catch(() => {});
    throw new Error(
      `Cannot reach PostgreSQL for DATABASE_URL (${redactDatabaseUrl(databaseUrl)}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
  return { store: createPgHostingStore(handle.db), close: () => handle.close() };
}
