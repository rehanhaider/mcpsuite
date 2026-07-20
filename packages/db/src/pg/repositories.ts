/**
 * PostgreSQL port implementations for the hosted multi-tenant deployment.
 * Async counterpart of ../repositories.ts (SQLite), same behavior per method.
 *
 * Isolation contract (docs/architecture/postgres-tenant-isolation.md):
 *
 * - Every public port method runs inside a database transaction whose FIRST
 *   statement installs the trusted workspace as a transaction-local GUC:
 *   `SELECT set_config('app.workspace_id', $1, true)` — the parameterized
 *   equivalent of `SET LOCAL app.workspace_id`. It evaporates at
 *   COMMIT/ROLLBACK, so pooled connections cannot leak context. Reads are not
 *   exempt: there is no query path outside this wrapper.
 * - Nested calls (ports.tx(...), or port methods invoking other port methods)
 *   join the ambient transaction via AsyncLocalStorage and cannot replace its
 *   workspace.
 * - Row-level security (schema.sql) enforces the same predicate
 *   independently; this adapter STILL writes an explicit workspace predicate
 *   into every query and subquery — two independent layers, per the doc.
 * - Caller-supplied ids that are not uuid-shaped are normalized to the nil
 *   uuid before hitting a uuid column, so a malformed id behaves exactly like
 *   a random nonexistent id (`not_found`) instead of a type error.
 *
 * Driver gating: the `pg` package is NOT a dependency yet (install is
 * awaiting signoff). This module therefore never imports "pg" statically —
 * `connectPg()` loads it (and `drizzle-orm/node-postgres`, whose module
 * top-level imports pg) dynamically at call time, and all driver typing is
 * structural (`PgPoolLike`). Importing this module, typechecking it, and
 * running the default test suite all work with the driver absent; only
 * calling `connectPg()` requires it.
 *
 * Deliberate behavior deltas vs the SQLite adapter (all doc-driven):
 * - `maintenance.backup()` throws `forbidden`: hosted physical backups happen
 *   only through private operational credentials, never app surfaces.
 * - `mcpClients.getByTokenHash` is workspace-scoped here; global key
 *   resolution goes through `crm.resolve_mcp_key` (schema.sql), not a port.
 * - Hard deletes also clear company/person list memberships (typed FKs
 *   cascade); SQLite leaves those rows orphaned.
 * - Association storage is typed-per-entity (company_tags, …); the generic
 *   port API is preserved by dispatching on the validated entity type.
 * - Identity-level auth storage (sessions, openauth_kv, auth_codes) carries
 *   zero crm_app grants: session sweeps, code issuance and issuer-state purges
 *   go through the fixed SECURITY DEFINER functions from schema.sql, called
 *   inside the same workspace transaction as the triggering mutation
 *   (disable-revocation and permanent user deletion per docs/issues/0022).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  newId,
  nowIso,
  todayIso,
  OpError,
  DEFAULT_WORKSPACE_SETTINGS,
  type Activity,
  type ActivityFilter,
  type ActorStamp,
  type AuditEvent,
  type AuditInput,
  type Company,
  type CompanyFilter,
  type CompanyListItem,
  type CompanyPersonLink,
  type ContactList,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldValue,
  type Deal,
  type DealFilter,
  type DealListItem,
  type DealStakeholder,
  type Engagement,
  type EngagementFilter,
  type EngagementListItem,
  type ListableType,
  type McpClient,
  type McpScope,
  type Offering,
  type OfferingLink,
  type Page,
  type PendingAction,
  type PendingStatus,
  type Person,
  type PersonFilter,
  type PersonListItem,
  type Pipeline,
  type PipelineType,
  type Ports,
  type Role,
  type SavedView,
  type SearchHit,
  type SemanticColor,
  type Stage,
  type Tag,
  type TaggableType,
  type TrustProfile,
  type User,
  type Workspace,
  type WorkspaceSettings,
} from "@emcp/core";
import * as t from "./schema.ts";
import { generateAuthCode, normalizeAuthCode } from "../openauth.ts";

// ---------------------------------------------------------------------------
// Async port surface
// ---------------------------------------------------------------------------
// Stream-stable typing: `Ports` is flipping from sync to async in core. The
// mapped type below produces the async signature from either state
// (`Promise<Awaited<R>>` is idempotent), so this adapter typechecks before
// and after that flip and is assignable to `Ports` once the flip lands.

type AsyncMethod<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
type AsyncPort<T> = { [K in keyof T]: AsyncMethod<T[K]> };

/**
 * Pg-only additions on top of the core port contract. `createPending`,
 * `deletePermanently`, `transferOwnership` and the credentials seam are core
 * `Ports` members now; these two remain adapter-level:
 *
 * - `activate` is the subject-binding step of the issuer success callback
 *   (docs/auth-api.md §password/authorize): the SQLite adapter binds subjects
 *   in its own auth module, the pg deployment does it through this seam.
 * - `deleteSessions` / `revokeAllForUser` are optional in core only until
 *   every adapter implements them — this adapter does, so they are declared
 *   required here (the pg mirror of disable-revocation, docs/issues/0022).
 */
export interface PgUserAuthExtensions {
  /**
   * Bind a verified OpenAuth subject to a not-yet-linked, non-disabled user:
   * a `pending` invite becomes `active` (activation), an `active` user
   * without a subject gets it on first OpenAuth login (e.g. after owner
   * recovery). Conflict when the subject is linked elsewhere; not_found
   * otherwise (including cross-workspace ids).
   */
  activate(id: string, authSubject: string): Promise<User>;
  /** Disable-revocation sweep: hard-deletes the user's sessions; returns count. */
  deleteSessions(userId: string): Promise<number>;
}

export type PgPorts = { [K in Exclude<keyof Ports, "tx">]: AsyncPort<Ports[K]> } & {
  users: AsyncPort<Ports["users"]> & PgUserAuthExtensions;
  mcpClients: AsyncPort<Ports["mcpClients"]> & { revokeAllForUser(userId: string): Promise<number> };
  /** Run fn atomically in a workspace-scoped transaction. Nested calls join it. */
  tx<T>(fn: () => T | Promise<T>): Promise<Awaited<T>>;
};

// ---------------------------------------------------------------------------
// Structural driver types (the real `pg` types are absent until signoff)
// ---------------------------------------------------------------------------

export interface PgQueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface PgPoolClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  release(err?: unknown): void;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
}

/** Drizzle database over node-postgres; relational query API unused. */
export type PgDb = PgDatabase<PgQueryResultHKT, Record<string, never>>;

export interface PgConnectOptions {
  /** e.g. postgres://crm_app:...@127.0.0.1:55432/emcp */
  databaseUrl: string;
  /** Pool size; keep small — every operation is a short transaction. */
  max?: number;
  /** Bring your own pool (tests); databaseUrl is ignored then. */
  pool?: PgPoolLike;
}

export interface PgHandle {
  db: PgDb;
  pool: PgPoolLike;
  close(): Promise<void>;
}

/**
 * Opens a pool + drizzle instance. The only place the driver is loaded; fails
 * with a clear message while `pg` is not installed (BLOCKED-ON-SIGNOFF).
 */
export async function connectPg(options: PgConnectOptions): Promise<PgHandle> {
  let pool = options.pool ?? null;
  if (!pool) {
    const specifier: string = "pg"; // widened type: keeps TS from resolving the absent module
    let pgModule: any;
    try {
      pgModule = await import(specifier);
    } catch (cause) {
      throw new Error(
        'PostgreSQL driver "pg" is not installed. It is intentionally not a dependency yet ' +
          "(pending signoff). Install it with `pnpm --filter @emcp/db add pg` to use the Postgres adapter.",
        { cause },
      );
    }
    const Pool = (pgModule.default ?? pgModule).Pool;
    pool = new Pool({ connectionString: options.databaseUrl, max: options.max ?? 5 }) as PgPoolLike;
  }
  // drizzle-orm/node-postgres imports "pg" at module top level, so it must be
  // loaded lazily too (drizzle-orm itself is installed).
  const nodePostgres: any = await import("drizzle-orm/node-postgres");
  const db = nodePostgres.drizzle({ client: pool }) as unknown as PgDb;
  const owned = !options.pool;
  return {
    db,
    pool,
    close: async () => {
      if (owned) await pool.end();
    },
  };
}

/**
 * Hosting-control-style workspace creation (there is deliberately no public
 * workspace.create operation): generate the id first, install it as the
 * transaction's workspace, then insert — RLS WITH CHECK admits exactly that
 * row. Returns the new workspace id.
 */
export async function provisionPgWorkspace(
  db: PgDb,
  input: { id?: string; name: string; defaultCurrency?: string; timezone?: string; settings?: WorkspaceSettings },
): Promise<string> {
  const id = input.id ?? newId();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${id}, true)`);
    await tx.insert(t.workspaces).values({
      id,
      name: input.name,
      defaultCurrency: input.defaultCurrency ?? "USD",
      timezone: input.timezone ?? "UTC",
      settings: { ...(input.settings ?? DEFAULT_WORKSPACE_SETTINGS) } as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    });
  });
  return id;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Row<T> = T extends { $inferSelect: infer R } ? R : never;

const iso = (d: Date): string => d.toISOString();
const isoN = (d: Date | null): string | null => (d ? d.toISOString() : null);
const toDate = (s: string): Date => new Date(s);
const toDateN = (s: string | null | undefined): Date | null => (s == null ? null : new Date(s));

/** Fields carried as ISO strings in the domain but stored as timestamptz. */
const TS_PATCH_FIELDS = [
  "createdAt",
  "updatedAt",
  "archivedAt",
  "disabledAt",
  "revokedAt",
  "lastUsedAt",
  "completedAt",
  "closedAt",
  "lastActivityAt",
  "requestedAt",
  "reviewedAt",
  "expiresAt",
] as const;

const patchToDb = (patch: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...patch };
  for (const k of TS_PATCH_FIELDS) {
    if (k in out) out[k] = toDateN(out[k] as string | null | undefined);
  }
  return out;
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Malformed ids must behave like random nonexistent ids, not type errors. */
const uid = (v: string): string => (UUID_RE.test(v) ? v : NIL_UUID);
const uidList = (ids: string[]): string[] => ids.map(uid);

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Walks err.cause chains for the SQLSTATE the pg driver attaches. */
const pgErrorCode = (e: unknown): string | undefined => {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
};

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Single-use code lifetimes: invites are handed over out-of-band (long), resets are hot (short). */
const AUTH_CODE_TTL_MS = { setup: 7 * 86_400_000, reset: 3_600_000 } as const;

// ---------------------------------------------------------------------------
// Row mappers (Date -> ISO string, jsonb passes through)
// ---------------------------------------------------------------------------

const mapCompany = (r: Row<typeof t.companies>): Company => ({
  id: r.id,
  displayId: r.displayId,
  name: r.name,
  domain: r.domain,
  website: r.website,
  linkedin: r.linkedin,
  industry: r.industry,
  hq: r.hq,
  country: r.country,
  description: r.description,
  ownerUserId: r.ownerUserId,
  archivedAt: isoN(r.archivedAt),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapPerson = (r: Row<typeof t.people>): Person => ({
  id: r.id,
  displayId: r.displayId,
  name: r.name,
  title: r.title,
  email: r.email,
  phone: r.phone,
  linkedin: r.linkedin,
  location: r.location,
  country: r.country,
  ownerUserId: r.ownerUserId,
  archivedAt: isoN(r.archivedAt),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapEngagement = (r: Row<typeof t.engagements>): Engagement => ({
  id: r.id,
  displayId: r.displayId,
  title: r.title,
  companyId: r.companyId,
  personId: r.personId,
  pipelineId: r.pipelineId,
  stageId: r.stageId,
  channel: r.channel,
  source: r.source,
  ownerUserId: r.ownerUserId,
  nextAction: r.nextAction,
  nextActionDue: r.nextActionDue,
  dealId: r.dealId,
  archivedAt: isoN(r.archivedAt),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
  lastActivityAt: isoN(r.lastActivityAt),
});

const mapDeal = (r: Row<typeof t.deals>): Deal => ({
  id: r.id,
  displayId: r.displayId,
  title: r.title,
  companyId: r.companyId,
  primaryPersonId: r.primaryPersonId,
  pipelineId: r.pipelineId,
  stageId: r.stageId,
  status: r.status as Deal["status"],
  amountMinor: r.amountMinor,
  currency: r.currency,
  probability: r.probability,
  expectedCloseDate: r.expectedCloseDate,
  lostReason: r.lostReason,
  engagementId: r.engagementId,
  ownerUserId: r.ownerUserId,
  nextAction: r.nextAction,
  nextActionDue: r.nextActionDue,
  closedAt: isoN(r.closedAt),
  archivedAt: isoN(r.archivedAt),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
  lastActivityAt: isoN(r.lastActivityAt),
});

const mapOffering = (r: Row<typeof t.offerings>): Offering => ({
  id: r.id,
  name: r.name,
  type: r.type as Offering["type"],
  description: r.description,
  active: r.active,
  ownerUserId: r.ownerUserId,
  archivedAt: isoN(r.archivedAt),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapActivity = (r: Row<typeof t.activities>): Activity => ({
  id: r.id,
  kind: r.kind as Activity["kind"],
  displayId: r.displayId,
  title: r.title,
  body: r.body,
  companyId: r.companyId,
  personId: r.personId,
  engagementId: r.engagementId,
  dealId: r.dealId,
  dueAt: r.dueAt,
  assigneeUserId: r.assigneeUserId,
  completedAt: isoN(r.completedAt),
  actorType: r.actorType as Activity["actorType"],
  actorUserId: r.actorUserId,
  actorClientId: r.actorClientId,
  meta: (r.meta ?? null) as Activity["meta"],
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapStage = (r: Row<typeof t.stages>): Stage => ({
  id: r.id,
  pipelineId: r.pipelineId,
  name: r.name,
  color: r.color as SemanticColor,
  position: r.position,
  probability: r.probability,
  outcome: r.outcome as Stage["outcome"],
});

const mapTag = (r: Row<typeof t.tags>): Tag => ({
  id: r.id,
  name: r.name,
  color: r.color as SemanticColor,
  createdAt: iso(r.createdAt),
});

const mapList = (r: Row<typeof t.lists>): ContactList => ({
  id: r.id,
  name: r.name,
  description: r.description,
  color: r.color as SemanticColor,
  entityType: (r.entityType as ListableType | null) ?? null,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapCfd = (r: Row<typeof t.customFieldDefs>): CustomFieldDef => ({
  id: r.id,
  entityType: r.entityType as CustomFieldEntity,
  key: r.key,
  label: r.label,
  type: r.type as CustomFieldDef["type"],
  options: (r.options ?? null) as string[] | null,
  required: r.required,
  position: r.position,
  archivedAt: isoN(r.archivedAt),
});

const mapPending = (r: Row<typeof t.pendingActions>): PendingAction => ({
  id: r.id,
  operation: r.operation,
  input: (r.input ?? {}) as Record<string, unknown>,
  preview: (r.preview ?? null) as Record<string, unknown> | null,
  riskCategory: r.riskCategory,
  status: r.status as PendingStatus,
  requestedByType: r.requestedByType as PendingAction["requestedByType"],
  requestedByUserId: r.requestedByUserId,
  requestedByClientId: r.requestedByClientId,
  requestedAt: iso(r.requestedAt),
  reviewedByUserId: r.reviewedByUserId,
  reviewedAt: isoN(r.reviewedAt),
  reviewNote: r.reviewNote,
  result: (r.result ?? null) as Record<string, unknown> | null,
  expiresAt: iso(r.expiresAt),
});

const mapAudit = (r: Row<typeof t.auditEvents>): AuditEvent => ({
  id: r.id,
  operation: r.operation,
  entityType: r.entityType,
  entityId: r.entityId,
  summary: r.summary,
  meta: (r.meta ?? null) as Record<string, unknown> | null,
  actorType: r.actorType as AuditEvent["actorType"],
  actorUserId: r.actorUserId,
  actorClientId: r.actorClientId,
  surface: r.surface as AuditEvent["surface"],
  createdAt: iso(r.createdAt),
});

const mapMcpClient = (r: Row<typeof t.mcpClients>): McpClient => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.tokenPrefix,
  scopes: (r.scopes ?? []) as McpScope[],
  trust: r.trust as TrustProfile,
  createdByUserId: r.createdByUserId,
  createdAt: iso(r.createdAt),
  lastUsedAt: isoN(r.lastUsedAt),
  revokedAt: isoN(r.revokedAt),
});

// status/passwordMustChange are asserted through `as User` until the core
// domain type lands them (stream S1); the extra properties are exactly what
// operations/admin-ops.ts already reads (`user.status`).
const mapUser = (r: Row<typeof t.users>, role: Role): User =>
  ({
    id: r.id,
    email: r.email,
    name: r.name,
    role,
    hasPassword: r.passwordHash != null,
    status: r.status,
    passwordMustChange: r.passwordMustChange,
    disabledAt: isoN(r.disabledAt),
    createdAt: iso(r.createdAt),
  }) as User;

// ---------------------------------------------------------------------------

export function createPgPorts(db: PgDb, workspaceId: string): PgPorts {
  const ws = uid(workspaceId);

  /**
   * The ambient workspace transaction. Entering `run` outside a transaction
   * opens one and installs the workspace GUC before anything else; entering
   * it inside one joins it (and cannot change its workspace).
   */
  const als = new AsyncLocalStorage<PgDb>();
  const run = async <T>(fn: (x: PgDb) => Promise<T>): Promise<T> => {
    const ambient = als.getStore();
    if (ambient) return fn(ambient);
    return db.transaction(async (txx) => {
      const x = txx as unknown as PgDb;
      await x.execute(sql`select set_config('app.workspace_id', ${ws}, true)`);
      return als.run(x, () => fn(x));
    });
  };

  /** Normalized raw-SQL rows (node-postgres returns a QueryResult). */
  const execRows = async <T = Record<string, unknown>>(x: PgDb, q: SQL): Promise<T[]> => {
    const res = (await x.execute(q)) as unknown;
    if (Array.isArray(res)) return res as T[];
    return (((res as { rows?: unknown[] }).rows ?? []) as T[]);
  };

  const nextDisplayId = async (x: PgDb, entity: string): Promise<number> => {
    const rows = await x
      .insert(t.workspaceCounters)
      .values({ workspaceId: ws, entity, nextValue: 1 })
      .onConflictDoUpdate({
        target: [t.workspaceCounters.workspaceId, t.workspaceCounters.entity],
        set: { nextValue: sql`${t.workspaceCounters.nextValue} + 1` },
      })
      .returning({ nextValue: t.workspaceCounters.nextValue });
    return rows[0]!.nextValue;
  };

  const cutoffIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

  const settings = async (x: PgDb): Promise<WorkspaceSettings> => {
    const [row] = await x.select().from(t.workspaces).where(eq(t.workspaces.id, ws)).limit(1);
    return row
      ? { ...DEFAULT_WORKSPACE_SETTINGS, ...(row.settings as Partial<WorkspaceSettings>) }
      : DEFAULT_WORKSPACE_SETTINGS;
  };

  /** Batched id→name lookups used to denormalize list rows. */
  const companyNames = async (x: PgDb, ids: Array<string | null>): Promise<Map<string, string>> => {
    const wanted = [...new Set(ids.filter((v): v is string => v != null))];
    if (wanted.length === 0) return new Map();
    const rows = await x
      .select({ id: t.companies.id, name: t.companies.name })
      .from(t.companies)
      .where(and(eq(t.companies.workspaceId, ws), inArray(t.companies.id, uidList(wanted))));
    return new Map(rows.map((r) => [r.id, r.name]));
  };

  const personNames = async (x: PgDb, ids: Array<string | null>): Promise<Map<string, string>> => {
    const wanted = [...new Set(ids.filter((v): v is string => v != null))];
    if (wanted.length === 0) return new Map();
    const rows = await x
      .select({ id: t.people.id, name: t.people.name })
      .from(t.people)
      .where(and(eq(t.people.workspaceId, ws), inArray(t.people.id, uidList(wanted))));
    return new Map(rows.map((r) => [r.id, r.name]));
  };

  /** ANY-semantics tag condition via EXISTS on the typed tag table. */
  const tagCondition = (entityType: TaggableType, entityIdCol: SQL, tagIds: string[]): SQL => {
    const tt = t.TAG_LINK_TABLES[entityType];
    return sql`EXISTS (SELECT 1 FROM ${tt} tg WHERE tg.workspace_id = ${ws} AND tg.entity_id = ${entityIdCol} AND tg.tag_id IN (${sql.join(
      uidList(tagIds).map((id) => sql`${id}`),
      sql`, `,
    )}))`;
  };

  /** Contact-list membership condition via EXISTS on the typed member table. */
  const listCondition = (entityType: ListableType, entityIdCol: SQL, listId: string): SQL => {
    const mt = t.LIST_MEMBER_TABLES[entityType];
    return sql`EXISTS (SELECT 1 FROM ${mt} lm WHERE lm.workspace_id = ${ws} AND lm.entity_id = ${entityIdCol} AND lm.list_id = ${uid(listId)})`;
  };

  const offeringCondition = (entityType: "engagement" | "deal", entityIdCol: SQL, offeringId: string): SQL => {
    const ot = t.OFFERING_LINK_TABLES[entityType];
    return sql`EXISTS (SELECT 1 FROM ${ot} ol WHERE ol.workspace_id = ${ws} AND ol.entity_id = ${entityIdCol} AND ol.offering_id = ${uid(offeringId)})`;
  };

  const likeAll = (q: string, cols: SQL[]): SQL => {
    const pattern = `%${q.trim().toLowerCase()}%`;
    const conds = cols.map((c) => sql`lower(coalesce(${c}, '')) LIKE ${pattern}`);
    return sql`(${sql.join(conds, sql` OR `)})`;
  };

  const mapCompanyPersonLink = (r: Row<typeof t.companyPeople>): CompanyPersonLink => ({
    id: r.id,
    companyId: r.companyId,
    personId: r.personId,
    roleTitle: r.roleTitle,
    isPrimary: r.isPrimary,
    status: r.status as CompanyPersonLink["status"],
    createdAt: iso(r.createdAt),
  });

  const mapStakeholder = (r: Row<typeof t.dealStakeholders>): DealStakeholder => ({
    id: r.id,
    dealId: r.dealId,
    personId: r.personId,
    role: r.role,
    isPrimary: r.isPrimary,
    note: r.note,
  });

  const mapOfferingLink = (r: { id: string; offeringId: string; entityId: string; fit: string | null; note: string | null; isPrimary: boolean }, entityType: "engagement" | "deal"): OfferingLink => ({
    id: r.id,
    offeringId: r.offeringId,
    entityType,
    entityId: r.entityId,
    fit: r.fit,
    note: r.note,
    isPrimary: r.isPrimary,
  });

  const mapSavedView = (r: Row<typeof t.savedViews>): SavedView => ({
    id: r.id,
    name: r.name,
    entityType: r.entityType as SavedView["entityType"],
    filters: (r.filters ?? {}) as Record<string, unknown>,
    visibility: r.visibility as SavedView["visibility"],
    ownerUserId: r.ownerUserId,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });

  // --- workspace --------------------------------------------------------

  const workspacePort: AsyncPort<Ports["workspace"]> = {
    async get(): Promise<Workspace> {
      return run(async (x) => {
        const [row] = await x.select().from(t.workspaces).where(eq(t.workspaces.id, ws)).limit(1);
        if (!row) throw new OpError("internal", `Workspace ${ws} missing`);
        return {
          id: row.id,
          name: row.name,
          defaultCurrency: row.defaultCurrency,
          timezone: row.timezone,
          settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...(row.settings as Partial<WorkspaceSettings>) },
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        };
      });
    },
    async update(patch) {
      return run(async (x) => {
        const current = await workspacePort.get();
        await x
          .update(t.workspaces)
          .set({
            name: patch.name ?? current.name,
            defaultCurrency: patch.defaultCurrency ?? current.defaultCurrency,
            timezone: patch.timezone ?? current.timezone,
            settings: { ...(patch.settings ?? current.settings) } as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(t.workspaces.id, ws));
        return workspacePort.get();
      });
    },
  };

  // --- users -------------------------------------------------------------

  const roleOf = async (x: PgDb, userId: string): Promise<Role> => {
    const [m] = await x
      .select()
      .from(t.memberships)
      .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, uid(userId))))
      .limit(1);
    return (m?.role ?? "member") as Role;
  };

  const usersPort: AsyncPort<Ports["users"]> & PgUserAuthExtensions = {
    async list() {
      return run(async (x) => {
        const rows = await x
          .select({ user: t.users, role: t.memberships.role })
          .from(t.memberships)
          .innerJoin(t.users, and(eq(t.users.id, t.memberships.userId), eq(t.users.workspaceId, ws)))
          .where(eq(t.memberships.workspaceId, ws))
          .orderBy(asc(t.users.createdAt));
        return rows.map((r) => mapUser(r.user, r.role as Role));
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.users)
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, uid(id))))
          .limit(1);
        return row ? mapUser(row, await roleOf(x, id)) : null;
      });
    },
    async getByEmail(email) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.users)
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.email, email.toLowerCase())))
          .limit(1);
        if (!row) return null;
        return { ...mapUser(row, await roleOf(x, row.id)), passwordHash: row.passwordHash };
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        const now = new Date();
        await x.insert(t.users).values({
          id,
          workspaceId: ws,
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: input.passwordHash,
          status: "active",
          authSubject: null,
          passwordMustChange: false,
          createdAt: now,
          updatedAt: now,
        });
        await x.insert(t.memberships).values({ id: newId(), workspaceId: ws, userId: id, role: input.role, createdAt: now });
        return (await usersPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        if (patch.name !== undefined || patch.disabledAt !== undefined) {
          await x
            .update(t.users)
            .set({
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              // status stays coherent with disabledAt (users_status_disabled_ck):
              // disabling forces 'disabled'; re-enabling restores 'active' but
              // never resurrects a pre-activation 'pending' to 'active'.
              ...(patch.disabledAt !== undefined
                ? {
                    disabledAt: toDateN(patch.disabledAt),
                    status:
                      patch.disabledAt != null
                        ? "disabled"
                        : sql`CASE WHEN ${t.users.status} = 'disabled' THEN 'active' ELSE ${t.users.status} END`,
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, uid(id))));
        }
        if (patch.role !== undefined) {
          await x
            .update(t.memberships)
            .set({ role: patch.role })
            .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, uid(id))));
        }
        const user = await usersPort.get(id);
        if (!user) throw OpError.notFound("user", id);
        return user;
      });
    },
    async setPassword(id, passwordHash) {
      await run(async (x) => {
        await x
          .update(t.users)
          .set({ passwordHash, updatedAt: new Date() })
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, uid(id))));
      });
    },
    async count() {
      return run(async (x) => {
        const [row] = await x.select({ n: count() }).from(t.users).where(eq(t.users.workspaceId, ws));
        return row?.n ?? 0;
      });
    },
    async deleteSessions(userId) {
      // crm.sessions carries no runtime grants (schema.sql): the sweep goes through
      // the fixed SECURITY DEFINER path, workspace-guarded inside the function.
      return run(async (x) => {
        const rows = await execRows<{ n: number }>(
          x,
          sql`SELECT crm.delete_user_sessions(${uid(userId)}::uuid) AS n`,
        );
        return num(rows[0]?.n);
      });
    },
    async createPending(input) {
      return run(async (x) => {
        if (input.role === "owner") throw OpError.validation("There can only be one owner");
        const id = newId();
        const now = new Date();
        try {
          await x.insert(t.users).values({
            id,
            workspaceId: ws,
            email: input.email.toLowerCase(),
            name: input.name,
            passwordHash: null,
            status: "pending",
            authSubject: null,
            passwordMustChange: false,
            createdAt: now,
            updatedAt: now,
          });
        } catch (e) {
          // Deployment-global email uniqueness; never identify the other
          // workspace (isolation doc §Uniqueness and information disclosure).
          if (pgErrorCode(e) === "23505") throw new OpError("conflict", "That email is unavailable");
          throw e;
        }
        await x.insert(t.memberships).values({ id: newId(), workspaceId: ws, userId: id, role: input.role, createdAt: now });
        return { userId: id };
      });
    },
    async activate(id, authSubject) {
      return run(async (x) => {
        let updated: Array<{ id: string }>;
        try {
          updated = await x
            .update(t.users)
            .set({ authSubject, status: "active", updatedAt: new Date() })
            .where(
              and(
                eq(t.users.workspaceId, ws),
                eq(t.users.id, uid(id)),
                sql`${t.users.status} <> 'disabled'`,
                isNull(t.users.authSubject),
              ),
            )
            .returning({ id: t.users.id });
        } catch (e) {
          if (pgErrorCode(e) === "23505") {
            throw new OpError("conflict", "That login identity is already linked to another user");
          }
          throw e;
        }
        if (updated.length === 0) throw OpError.notFound("user", id);
        return (await usersPort.get(id))!;
      });
    },
    async deletePermanently(id) {
      await run(async (x) => {
        const target = uid(id);
        const [row] = await x
          .select({ id: t.users.id })
          .from(t.users)
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, target)))
          .limit(1);
        if (!row) throw OpError.notFound("user", id);
        if ((await roleOf(x, id)) === "owner") {
          throw OpError.validation("The owner cannot be deleted — transfer ownership first");
        }
        // 1. OpenAuth issuer state — refresh tokens and authorization rows
        //    keyed by the subject, password hash and email→subject binding
        //    keyed by the email (workspace-guarded SECURITY DEFINER; must run
        //    while the user row still exists).
        await execRows(x, sql`SELECT crm.purge_openauth_identity(${target}::uuid)`);
        // 2. Login sessions (same fixed path as deleteSessions).
        await execRows(x, sql`SELECT crm.delete_user_sessions(${target}::uuid)`);
        // 3. The user's MCP clients are credentials, not business records —
        //    they die with the user. History referencing them (activities,
        //    audit, pending actions) survives via ON DELETE SET NULL (col).
        await x
          .delete(t.mcpClients)
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.createdByUserId, target)));
        // 4. Private saved views are personal configuration; shared views
        //    survive with owner cleared by the FK.
        await x
          .delete(t.savedViews)
          .where(
            and(
              eq(t.savedViews.workspaceId, ws),
              eq(t.savedViews.ownerUserId, target),
              eq(t.savedViews.visibility, "private"),
            ),
          );
        // 5. The user row. FKs do the rest inside this transaction:
        //    memberships + auth_codes + sessions CASCADE (referential actions
        //    are exempt from RLS by design); every business reference
        //    (owner/assignee/actor/reviewer) is SET NULL (col) so records
        //    survive and render "Deleted user" — no email or name remains.
        await x.delete(t.users).where(and(eq(t.users.workspaceId, ws), eq(t.users.id, target)));
      });
    },
    async transferOwnership(fromUserId, toUserId) {
      await run(async (x) => {
        const from = uid(fromUserId);
        const to = uid(toUserId);
        if (from === to) throw OpError.validation("This user already owns the workspace");
        const [target] = await x
          .select({ id: t.users.id })
          .from(t.users)
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, to), eq(t.users.status, "active")))
          .limit(1);
        if (!target) throw OpError.notFound("user", toUserId);
        // Demote strictly from 'owner': a concurrent transfer that got there
        // first makes this hit 0 rows → conflict, transaction rolls back.
        const demoted = await x
          .update(t.memberships)
          .set({ role: "admin" })
          .where(
            and(
              eq(t.memberships.workspaceId, ws),
              eq(t.memberships.userId, from),
              eq(t.memberships.role, "owner"),
            ),
          )
          .returning({ id: t.memberships.id });
        if (demoted.length !== 1) {
          throw new OpError("conflict", "Workspace ownership changed concurrently — reload and retry");
        }
        const promoted = await x
          .update(t.memberships)
          .set({ role: "owner" })
          .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, to)))
          .returning({ id: t.memberships.id });
        if (promoted.length !== 1) throw OpError.notFound("user", toUserId);
        // memberships_one_owner_ux is the DB backstop: if another transaction
        // slipped an owner in between, the promote raised 23505 and everything
        // above rolled back — the workspace can never observe two owners.
      });
    },
  };

  // --- credentials (setup/reset codes; storage model in schema.sql) ------

  const credentialsPort: AsyncPort<Ports["credentials"]> = {
    async issueCode(userId, purpose) {
      if (purpose !== "setup" && purpose !== "reset") {
        throw OpError.validation(`Unknown credential code purpose: ${String(purpose)}`);
      }
      return run(async (x) => {
        // Same display format and normalized-hash form as the SQLite adapter
        // (packages/db/src/openauth.ts) so codes redeem identically on every
        // surface: XXXX-XXXX-XXXX shown once, SHA-256(normalized) at rest.
        const code = generateAuthCode();
        const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS[purpose]);
        // Workspace-guarded definer function: stores only the hash, deletes
        // the user's earlier codes of this purpose, NULL when the user is not
        // in this workspace (or disabled) — indistinguishable from random ids.
        const rows = await execRows<{ id: string | null }>(
          x,
          sql`SELECT crm.issue_auth_code(${uid(userId)}::uuid, ${purpose}, ${sha256Hex(normalizeAuthCode(code))}, ${expiresAt.toISOString()}::timestamptz) AS id`,
        );
        if (!rows[0]?.id) throw OpError.notFound("user", userId);
        if (purpose === "reset") {
          // user.resetPassword contract: issuing a reset code ends every
          // session, in the same transaction.
          await execRows(x, sql`SELECT crm.delete_user_sessions(${uid(userId)}::uuid)`);
        }
        return { code };
      });
    },
    async mustChangePassword(userId, mustChange) {
      await run(async (x) => {
        const rows = await x
          .update(t.users)
          .set({ passwordMustChange: mustChange, updatedAt: new Date() })
          .where(and(eq(t.users.workspaceId, ws), eq(t.users.id, uid(userId))))
          .returning({ id: t.users.id });
        if (rows.length === 0) throw OpError.notFound("user", userId);
      });
    },
  };

  // --- companies ----------------------------------------------------------

  const companiesPort: AsyncPort<Ports["companies"]> = {
    async list(filter: CompanyFilter): Promise<Page<CompanyListItem>> {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.companies.workspaceId, ws) as unknown as SQL];
        if (!filter.includeArchived) conds.push(isNull(t.companies.archivedAt) as unknown as SQL);
        if (filter.ownerUserId) conds.push(eq(t.companies.ownerUserId, uid(filter.ownerUserId)) as unknown as SQL);
        if (filter.country) conds.push(eq(t.companies.country, filter.country) as unknown as SQL);
        if (filter.industry) conds.push(eq(t.companies.industry, filter.industry) as unknown as SQL);
        if (filter.search) {
          conds.push(
            likeAll(filter.search, [
              sql`${t.companies.name}`,
              sql`${t.companies.industry}`,
              sql`${t.companies.hq}`,
              sql`${t.companies.country}`,
              sql`${t.companies.domain}`,
            ]),
          );
        }
        if (filter.tagIds?.length) conds.push(tagCondition("company", sql`${t.companies.id}`, filter.tagIds));
        if (filter.listId) conds.push(listCondition("company", sql`${t.companies.id}`, filter.listId));

        const where = and(...conds);
        const sortCol = {
          name: t.companies.name,
          createdAt: t.companies.createdAt,
          updatedAt: t.companies.updatedAt,
          displayId: t.companies.displayId,
        }[filter.sort];
        const [totalRow] = await x.select({ n: count() }).from(t.companies).where(where);
        const rows = await x
          .select()
          .from(t.companies)
          .where(where)
          .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
          .limit(filter.limit)
          .offset(filter.offset);
        const memberOf = await listsPort.forEntities("company", rows.map((r) => r.id));
        return { items: rows.map((r) => ({ ...mapCompany(r), lists: memberOf[r.id] ?? [] })), total: totalRow?.n ?? 0 };
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.companies)
          .where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, uid(id))))
          .limit(1);
        return row ? mapCompany(row) : null;
      });
    },
    async getByName(name) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.companies)
          .where(and(eq(t.companies.workspaceId, ws), sql`lower(${t.companies.name}) = ${name.trim().toLowerCase()}`))
          .limit(1);
        return row ? mapCompany(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = input.id ?? newId();
        const now = new Date();
        await x.insert(t.companies).values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? (await nextDisplayId(x, "company")),
          name: input.name,
          domain: input.domain ?? null,
          website: input.website ?? null,
          linkedin: input.linkedin ?? null,
          industry: input.industry ?? null,
          hq: input.hq ?? null,
          country: input.country ?? null,
          description: input.description ?? null,
          ownerUserId: input.ownerUserId ?? null,
          version: 1,
          createdAt: input.createdAt ? toDate(input.createdAt) : now,
          updatedAt: now,
        });
        return (await companiesPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.companies)
          .set({
            ...patchToDb(patch as Record<string, unknown>),
            version: sql`${t.companies.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, uid(id))));
        const row = await companiesPort.get(id);
        if (!row) throw OpError.notFound("company", id);
        return row;
      });
    },
    async setArchived(id, archived) {
      return companiesPort.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      await run(async (x) => {
        const cid = uid(id);
        await x.delete(t.companyPeople).where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, cid)));
        await x.delete(t.companyTags).where(and(eq(t.companyTags.workspaceId, ws), eq(t.companyTags.entityId, cid)));
        await x
          .delete(t.companyCustomFieldValues)
          .where(and(eq(t.companyCustomFieldValues.workspaceId, ws), eq(t.companyCustomFieldValues.entityId, cid)));
        await x
          .delete(t.companyListMembers)
          .where(and(eq(t.companyListMembers.workspaceId, ws), eq(t.companyListMembers.entityId, cid)));
        await x.update(t.engagements).set({ companyId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.companyId, cid)));
        await x.update(t.deals).set({ companyId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.companyId, cid)));
        await x.update(t.activities).set({ companyId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.companyId, cid)));
        await x.delete(t.companies).where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, cid)));
      });
    },
    async people(companyId) {
      return run(async (x) => {
        const rows = await x
          .select({ link: t.companyPeople, person: t.people })
          .from(t.companyPeople)
          .innerJoin(t.people, and(eq(t.people.id, t.companyPeople.personId), eq(t.people.workspaceId, ws)))
          .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, uid(companyId))))
          .orderBy(desc(t.companyPeople.isPrimary), asc(t.people.name));
        return rows.map((r) => ({ ...mapCompanyPersonLink(r.link), person: mapPerson(r.person) }));
      });
    },
  };

  // --- people --------------------------------------------------------------

  const peoplePort: AsyncPort<Ports["people"]> = {
    async list(filter: PersonFilter): Promise<Page<PersonListItem>> {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.people.workspaceId, ws) as unknown as SQL];
        if (!filter.includeArchived) conds.push(isNull(t.people.archivedAt) as unknown as SQL);
        if (filter.ownerUserId) conds.push(eq(t.people.ownerUserId, uid(filter.ownerUserId)) as unknown as SQL);
        if (filter.country) conds.push(eq(t.people.country, filter.country) as unknown as SQL);
        if (filter.companyId) {
          conds.push(
            sql`EXISTS (SELECT 1 FROM ${t.companyPeople} cp WHERE cp.workspace_id = ${ws} AND cp.person_id = ${t.people.id} AND cp.company_id = ${uid(filter.companyId)})`,
          );
        }
        if (filter.search) {
          conds.push(
            likeAll(filter.search, [
              sql`${t.people.name}`,
              sql`${t.people.title}`,
              sql`${t.people.email}`,
              sql`${t.people.location}`,
            ]),
          );
        }
        if (filter.tagIds?.length) conds.push(tagCondition("person", sql`${t.people.id}`, filter.tagIds));
        if (filter.listId) conds.push(listCondition("person", sql`${t.people.id}`, filter.listId));

        const where = and(...conds);
        const sortCol = {
          name: t.people.name,
          createdAt: t.people.createdAt,
          updatedAt: t.people.updatedAt,
          displayId: t.people.displayId,
        }[filter.sort];
        const [totalRow] = await x.select({ n: count() }).from(t.people).where(where);
        const rows = await x
          .select()
          .from(t.people)
          .where(where)
          .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
          .limit(filter.limit)
          .offset(filter.offset);
        const items = rows.map(mapPerson);
        const primaryCompany = new Map<string, string>();
        if (items.length > 0) {
          const links = await x
            .select({ personId: t.companyPeople.personId, companyId: t.companyPeople.companyId, isPrimary: t.companyPeople.isPrimary })
            .from(t.companyPeople)
            .where(and(eq(t.companyPeople.workspaceId, ws), inArray(t.companyPeople.personId, items.map((p) => p.id))));
          const cNames = await companyNames(x, links.map((l) => l.companyId));
          for (const link of links) {
            // Prefer the primary link; otherwise first seen wins.
            if (!primaryCompany.has(link.personId) || link.isPrimary) {
              const name = cNames.get(link.companyId);
              if (name) primaryCompany.set(link.personId, name);
            }
          }
        }
        const memberOf = await listsPort.forEntities("person", items.map((p) => p.id));
        return {
          items: items.map((p) => ({ ...p, primaryCompanyName: primaryCompany.get(p.id) ?? null, lists: memberOf[p.id] ?? [] })),
          total: totalRow?.n ?? 0,
        };
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.people)
          .where(and(eq(t.people.workspaceId, ws), eq(t.people.id, uid(id))))
          .limit(1);
        return row ? mapPerson(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = input.id ?? newId();
        const now = new Date();
        await x.insert(t.people).values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? (await nextDisplayId(x, "person")),
          name: input.name,
          title: input.title ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          linkedin: input.linkedin ?? null,
          location: input.location ?? null,
          country: input.country ?? null,
          ownerUserId: input.ownerUserId ?? null,
          version: 1,
          createdAt: input.createdAt ? toDate(input.createdAt) : now,
          updatedAt: now,
        });
        return (await peoplePort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.people)
          .set({ ...patchToDb(patch as Record<string, unknown>), version: sql`${t.people.version} + 1`, updatedAt: new Date() })
          .where(and(eq(t.people.workspaceId, ws), eq(t.people.id, uid(id))));
        const row = await peoplePort.get(id);
        if (!row) throw OpError.notFound("person", id);
        return row;
      });
    },
    async setArchived(id, archived) {
      return peoplePort.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      await run(async (x) => {
        const pid = uid(id);
        await x.delete(t.companyPeople).where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, pid)));
        await x.delete(t.personTags).where(and(eq(t.personTags.workspaceId, ws), eq(t.personTags.entityId, pid)));
        await x
          .delete(t.personCustomFieldValues)
          .where(and(eq(t.personCustomFieldValues.workspaceId, ws), eq(t.personCustomFieldValues.entityId, pid)));
        await x
          .delete(t.personListMembers)
          .where(and(eq(t.personListMembers.workspaceId, ws), eq(t.personListMembers.entityId, pid)));
        await x.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.personId, pid)));
        await x.update(t.engagements).set({ personId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.personId, pid)));
        await x.update(t.deals).set({ primaryPersonId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.primaryPersonId, pid)));
        await x.update(t.activities).set({ personId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.personId, pid)));
        await x.delete(t.people).where(and(eq(t.people.workspaceId, ws), eq(t.people.id, pid)));
      });
    },
    async companies(personId) {
      return run(async (x) => {
        const rows = await x
          .select({ link: t.companyPeople, company: t.companies })
          .from(t.companyPeople)
          .innerJoin(t.companies, and(eq(t.companies.id, t.companyPeople.companyId), eq(t.companies.workspaceId, ws)))
          .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, uid(personId))))
          .orderBy(desc(t.companyPeople.isPrimary));
        return rows.map((r) => ({ ...mapCompanyPersonLink(r.link), company: mapCompany(r.company) }));
      });
    },
    async link(input) {
      return run(async (x) => {
        const companyId = uid(input.companyId);
        const personId = uid(input.personId);
        const [existing] = await x
          .select()
          .from(t.companyPeople)
          .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, companyId), eq(t.companyPeople.personId, personId)))
          .limit(1);
        const now = new Date();
        if (input.isPrimary) {
          // Only one primary company per person.
          await x
            .update(t.companyPeople)
            .set({ isPrimary: false })
            .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, personId)));
        }
        if (existing) {
          await x
            .update(t.companyPeople)
            .set({
              roleTitle: input.roleTitle ?? existing.roleTitle,
              isPrimary: input.isPrimary ? true : existing.isPrimary,
              status: input.status ?? existing.status,
            })
            .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.id, existing.id)));
          const [updated] = await x
            .select()
            .from(t.companyPeople)
            .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.id, existing.id)))
            .limit(1);
          return mapCompanyPersonLink(updated!);
        }
        const id = newId();
        await x.insert(t.companyPeople).values({
          id,
          workspaceId: ws,
          companyId: input.companyId,
          personId: input.personId,
          roleTitle: input.roleTitle ?? null,
          isPrimary: input.isPrimary ?? false,
          status: input.status ?? "current",
          createdAt: now,
        });
        return {
          id,
          companyId: input.companyId,
          personId: input.personId,
          roleTitle: input.roleTitle ?? null,
          isPrimary: input.isPrimary ?? false,
          status: input.status ?? "current",
          createdAt: iso(now),
        };
      });
    },
    async unlink(companyId, personId) {
      await run(async (x) => {
        await x
          .delete(t.companyPeople)
          .where(
            and(
              eq(t.companyPeople.workspaceId, ws),
              eq(t.companyPeople.companyId, uid(companyId)),
              eq(t.companyPeople.personId, uid(personId)),
            ),
          );
      });
    },
  };

  // --- pipelines -------------------------------------------------------------

  const pipelinesPort: AsyncPort<Ports["pipelines"]> = {
    async list(type?: PipelineType): Promise<Pipeline[]> {
      return run(async (x) => {
        const conds = [eq(t.pipelines.workspaceId, ws)];
        if (type) conds.push(eq(t.pipelines.type, type));
        const rows = await x
          .select()
          .from(t.pipelines)
          .where(and(...conds))
          .orderBy(asc(t.pipelines.position), asc(t.pipelines.createdAt));
        if (rows.length === 0) return [];
        const stageRows = await x
          .select()
          .from(t.stages)
          .where(and(eq(t.stages.workspaceId, ws), inArray(t.stages.pipelineId, rows.map((p) => p.id))))
          .orderBy(asc(t.stages.position));
        const stagesBy = new Map<string, Stage[]>();
        for (const s of stageRows) {
          const list = stagesBy.get(s.pipelineId) ?? [];
          list.push(mapStage(s));
          stagesBy.set(s.pipelineId, list);
        }
        return rows.map((p) => ({
          id: p.id,
          type: p.type as PipelineType,
          name: p.name,
          isDefault: p.isDefault,
          position: p.position,
          stages: stagesBy.get(p.id) ?? [],
        }));
      });
    },
    async get(id) {
      return (await pipelinesPort.list()).find((p) => p.id === id) ?? null;
    },
    async getDefault(type) {
      const all = await pipelinesPort.list(type);
      return all.find((p) => p.isDefault) ?? all[0] ?? null;
    },
    async getStage(stageId) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.stages)
          .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, uid(stageId))))
          .limit(1);
        return row ? mapStage(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        const now = new Date();
        if (input.isDefault) {
          await x
            .update(t.pipelines)
            .set({ isDefault: false })
            .where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, input.type)));
        }
        const [maxRow] = await x
          .select({ n: sql<number>`COALESCE(MAX(${t.pipelines.position}), -1)` })
          .from(t.pipelines)
          .where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, input.type)));
        await x.insert(t.pipelines).values({
          id,
          workspaceId: ws,
          type: input.type,
          name: input.name,
          isDefault: input.isDefault,
          position: num(maxRow?.n ?? -1) + 1,
          createdAt: now,
        });
        if (input.stages.length > 0) {
          await x.insert(t.stages).values(
            input.stages.map((s, i) => ({
              id: newId(),
              workspaceId: ws,
              pipelineId: id,
              name: s.name,
              color: s.color,
              position: i,
              probability: s.probability ?? null,
              outcome: s.outcome ?? null,
            })),
          );
        }
        return (await pipelinesPort.get(id))!;
      });
    },
    async rename(id, name) {
      return run(async (x) => {
        await x.update(t.pipelines).set({ name }).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.id, uid(id))));
        return (await pipelinesPort.get(id))!;
      });
    },
    async setDefault(id) {
      await run(async (x) => {
        const pipeline = await pipelinesPort.get(id);
        if (!pipeline) throw OpError.notFound("pipeline", id);
        await x
          .update(t.pipelines)
          .set({ isDefault: false })
          .where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, pipeline.type)));
        await x
          .update(t.pipelines)
          .set({ isDefault: true })
          .where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.id, uid(id))));
      });
    },
    async delete(id) {
      await run(async (x) => {
        await x.delete(t.stages).where(and(eq(t.stages.workspaceId, ws), eq(t.stages.pipelineId, uid(id))));
        await x.delete(t.pipelines).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.id, uid(id))));
      });
    },
    async addStage(pipelineId, input) {
      return run(async (x) => {
        const id = newId();
        const [maxRow] = await x
          .select({ n: sql<number>`COALESCE(MAX(${t.stages.position}), -1)` })
          .from(t.stages)
          .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.pipelineId, uid(pipelineId))));
        await x.insert(t.stages).values({
          id,
          workspaceId: ws,
          pipelineId,
          name: input.name,
          color: input.color,
          position: num(maxRow?.n ?? -1) + 1,
          probability: input.probability ?? null,
          outcome: input.outcome ?? null,
        });
        return (await pipelinesPort.getStage(id))!;
      });
    },
    async updateStage(stageId, patch) {
      return run(async (x) => {
        await x
          .update(t.stages)
          .set(patch as Record<string, unknown>)
          .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, uid(stageId))));
        const s = await pipelinesPort.getStage(stageId);
        if (!s) throw OpError.notFound("stage", stageId);
        return s;
      });
    },
    async reorderStages(pipelineId, stageIds) {
      await run(async (x) => {
        for (const [i, sid] of stageIds.entries()) {
          await x
            .update(t.stages)
            .set({ position: i })
            .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.pipelineId, uid(pipelineId)), eq(t.stages.id, uid(sid))));
        }
      });
    },
    async deleteStage(stageId) {
      await run(async (x) => {
        await x.delete(t.stages).where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, uid(stageId))));
      });
    },
    async stageUsage(stageId) {
      return run(async (x) => {
        const [e] = await x
          .select({ n: count() })
          .from(t.engagements)
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.stageId, uid(stageId))));
        const [d] = await x
          .select({ n: count() })
          .from(t.deals)
          .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.stageId, uid(stageId))));
        return (e?.n ?? 0) + (d?.n ?? 0);
      });
    },
    async pipelineUsage(pipelineId) {
      return run(async (x) => {
        const [e] = await x
          .select({ n: count() })
          .from(t.engagements)
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.pipelineId, uid(pipelineId))));
        const [d] = await x
          .select({ n: count() })
          .from(t.deals)
          .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.pipelineId, uid(pipelineId))));
        return (e?.n ?? 0) + (d?.n ?? 0);
      });
    },
  };

  // --- engagements -------------------------------------------------------------

  const engagementsPort: AsyncPort<Ports["engagements"]> = {
    async list(filter: EngagementFilter): Promise<Page<EngagementListItem>> {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.engagements.workspaceId, ws) as unknown as SQL];
        if (!filter.includeArchived) conds.push(isNull(t.engagements.archivedAt) as unknown as SQL);
        if (filter.pipelineId) conds.push(eq(t.engagements.pipelineId, uid(filter.pipelineId)) as unknown as SQL);
        if (filter.stageId) conds.push(eq(t.engagements.stageId, uid(filter.stageId)) as unknown as SQL);
        if (filter.companyId) conds.push(eq(t.engagements.companyId, uid(filter.companyId)) as unknown as SQL);
        if (filter.personId) conds.push(eq(t.engagements.personId, uid(filter.personId)) as unknown as SQL);
        if (filter.ownerUserId) conds.push(eq(t.engagements.ownerUserId, uid(filter.ownerUserId)) as unknown as SQL);
        if (filter.channel) conds.push(eq(t.engagements.channel, filter.channel) as unknown as SQL);
        if (filter.stale) {
          const cutoff = cutoffIso((await settings(x)).staleEngagementDays);
          conds.push(sql`COALESCE(${t.engagements.lastActivityAt}, ${t.engagements.createdAt}) < ${cutoff}`);
          // Stale only matters for non-terminal stages.
          conds.push(
            sql`EXISTS (SELECT 1 FROM ${t.stages} s WHERE s.workspace_id = ${ws} AND s.id = ${t.engagements.stageId} AND s.outcome IS NULL)`,
          );
        }
        if (filter.search) {
          conds.push(
            likeAll(filter.search, [
              sql`${t.engagements.title}`,
              sql`${t.engagements.channel}`,
              sql`${t.engagements.source}`,
              sql`${t.engagements.nextAction}`,
            ]),
          );
        }
        if (filter.tagIds?.length) conds.push(tagCondition("engagement", sql`${t.engagements.id}`, filter.tagIds));
        if (filter.listId) conds.push(listCondition("engagement", sql`${t.engagements.id}`, filter.listId));
        if (filter.offeringId) conds.push(offeringCondition("engagement", sql`${t.engagements.id}`, filter.offeringId));

        const where = and(...conds);
        const sortCol = {
          displayId: t.engagements.displayId,
          title: t.engagements.title,
          createdAt: t.engagements.createdAt,
          updatedAt: t.engagements.updatedAt,
          lastActivityAt: t.engagements.lastActivityAt,
          nextActionDue: t.engagements.nextActionDue,
        }[filter.sort];
        const [totalRow] = await x.select({ n: count() }).from(t.engagements).where(where);
        const rows = await x
          .select()
          .from(t.engagements)
          .where(where)
          .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
          .limit(filter.limit)
          .offset(filter.offset);
        const items = rows.map(mapEngagement);
        const cNames = await companyNames(x, items.map((e) => e.companyId));
        const pNames = await personNames(x, items.map((e) => e.personId));
        const memberOf = await listsPort.forEntities("engagement", items.map((e) => e.id));
        const offeringsBy = await offeringsPort.linksForEntities("engagement", items.map((e) => e.id));
        return {
          items: items.map((e) => ({
            ...e,
            companyName: e.companyId ? (cNames.get(e.companyId) ?? null) : null,
            personName: e.personId ? (pNames.get(e.personId) ?? null) : null,
            lists: memberOf[e.id] ?? [],
            offerings: offeringsBy[e.id] ?? [],
          })),
          total: totalRow?.n ?? 0,
        };
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.engagements)
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, uid(id))))
          .limit(1);
        return row ? mapEngagement(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = input.id ?? newId();
        const now = new Date();
        await x.insert(t.engagements).values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? (await nextDisplayId(x, "engagement")),
          title: input.title,
          companyId: input.companyId ?? null,
          personId: input.personId ?? null,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          channel: input.channel ?? null,
          source: input.source ?? null,
          ownerUserId: input.ownerUserId ?? null,
          nextAction: input.nextAction ?? null,
          nextActionDue: input.nextActionDue ?? null,
          dealId: input.dealId ?? null,
          version: 1,
          createdAt: input.createdAt ? toDate(input.createdAt) : now,
          updatedAt: now,
          lastActivityAt: toDateN(input.lastActivityAt),
        });
        return (await engagementsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.engagements)
          .set({ ...patchToDb(patch as Record<string, unknown>), version: sql`${t.engagements.version} + 1`, updatedAt: new Date() })
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, uid(id))));
        const row = await engagementsPort.get(id);
        if (!row) throw OpError.notFound("engagement", id);
        return row;
      });
    },
    async setArchived(id, archived) {
      return engagementsPort.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      await run(async (x) => {
        const eid = uid(id);
        await x.delete(t.engagementTags).where(and(eq(t.engagementTags.workspaceId, ws), eq(t.engagementTags.entityId, eid)));
        await x
          .delete(t.engagementCustomFieldValues)
          .where(and(eq(t.engagementCustomFieldValues.workspaceId, ws), eq(t.engagementCustomFieldValues.entityId, eid)));
        await x
          .delete(t.engagementOfferingLinks)
          .where(and(eq(t.engagementOfferingLinks.workspaceId, ws), eq(t.engagementOfferingLinks.entityId, eid)));
        await x
          .delete(t.engagementListMembers)
          .where(and(eq(t.engagementListMembers.workspaceId, ws), eq(t.engagementListMembers.entityId, eid)));
        await x.update(t.activities).set({ engagementId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.engagementId, eid)));
        await x.update(t.deals).set({ engagementId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.engagementId, eid)));
        await x.delete(t.engagements).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, eid)));
      });
    },
    async countByStage(pipelineId) {
      return run(async (x) => {
        const rows = await x
          .select({ stageId: t.engagements.stageId, n: count() })
          .from(t.engagements)
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.pipelineId, uid(pipelineId)), isNull(t.engagements.archivedAt)))
          .groupBy(t.engagements.stageId);
        return rows.map((r) => ({ stageId: r.stageId, count: r.n }));
      });
    },
  };

  // --- deals ---------------------------------------------------------------

  const dealsPort: AsyncPort<Ports["deals"]> = {
    async list(filter: DealFilter): Promise<Page<DealListItem>> {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.deals.workspaceId, ws) as unknown as SQL];
        if (!filter.includeArchived) conds.push(isNull(t.deals.archivedAt) as unknown as SQL);
        if (filter.pipelineId) conds.push(eq(t.deals.pipelineId, uid(filter.pipelineId)) as unknown as SQL);
        if (filter.stageId) conds.push(eq(t.deals.stageId, uid(filter.stageId)) as unknown as SQL);
        if (filter.status) conds.push(eq(t.deals.status, filter.status) as unknown as SQL);
        if (filter.companyId) conds.push(eq(t.deals.companyId, uid(filter.companyId)) as unknown as SQL);
        if (filter.ownerUserId) conds.push(eq(t.deals.ownerUserId, uid(filter.ownerUserId)) as unknown as SQL);
        if (filter.personId) {
          const pid = uid(filter.personId);
          conds.push(
            sql`(${t.deals.primaryPersonId} = ${pid} OR EXISTS (SELECT 1 FROM ${t.dealStakeholders} dsh WHERE dsh.workspace_id = ${ws} AND dsh.deal_id = ${t.deals.id} AND dsh.person_id = ${pid}))`,
          );
        }
        if (filter.stale) {
          const cutoff = cutoffIso((await settings(x)).staleDealDays);
          conds.push(sql`COALESCE(${t.deals.lastActivityAt}, ${t.deals.createdAt}) < ${cutoff}`);
        }
        if (filter.search) {
          conds.push(likeAll(filter.search, [sql`${t.deals.title}`, sql`${t.deals.lostReason}`, sql`${t.deals.nextAction}`]));
        }
        if (filter.tagIds?.length) conds.push(tagCondition("deal", sql`${t.deals.id}`, filter.tagIds));
        if (filter.listId) conds.push(listCondition("deal", sql`${t.deals.id}`, filter.listId));
        if (filter.offeringId) conds.push(offeringCondition("deal", sql`${t.deals.id}`, filter.offeringId));

        const where = and(...conds);
        const sortCol = {
          displayId: t.deals.displayId,
          title: t.deals.title,
          amountMinor: t.deals.amountMinor,
          expectedCloseDate: t.deals.expectedCloseDate,
          createdAt: t.deals.createdAt,
          updatedAt: t.deals.updatedAt,
          lastActivityAt: t.deals.lastActivityAt,
        }[filter.sort];
        const [totalRow] = await x.select({ n: count() }).from(t.deals).where(where);
        const rows = await x
          .select()
          .from(t.deals)
          .where(where)
          .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
          .limit(filter.limit)
          .offset(filter.offset);
        const items = rows.map(mapDeal);
        const cNames = await companyNames(x, items.map((d) => d.companyId));
        const pNames = await personNames(x, items.map((d) => d.primaryPersonId));
        const memberOf = await listsPort.forEntities("deal", items.map((d) => d.id));
        const offeringsBy = await offeringsPort.linksForEntities("deal", items.map((d) => d.id));
        return {
          items: items.map((d) => ({
            ...d,
            companyName: d.companyId ? (cNames.get(d.companyId) ?? null) : null,
            primaryPersonName: d.primaryPersonId ? (pNames.get(d.primaryPersonId) ?? null) : null,
            lists: memberOf[d.id] ?? [],
            offerings: offeringsBy[d.id] ?? [],
          })),
          total: totalRow?.n ?? 0,
        };
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.deals)
          .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, uid(id))))
          .limit(1);
        return row ? mapDeal(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = input.id ?? newId();
        const now = new Date();
        await x.insert(t.deals).values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? (await nextDisplayId(x, "deal")),
          title: input.title,
          companyId: input.companyId ?? null,
          primaryPersonId: input.primaryPersonId ?? null,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          status: input.status ?? "open",
          amountMinor: input.amountMinor ?? null,
          currency: input.currency,
          probability: input.probability ?? null,
          expectedCloseDate: input.expectedCloseDate ?? null,
          lostReason: input.lostReason ?? null,
          engagementId: input.engagementId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          nextAction: input.nextAction ?? null,
          nextActionDue: input.nextActionDue ?? null,
          version: 1,
          createdAt: input.createdAt ? toDate(input.createdAt) : now,
          updatedAt: now,
          lastActivityAt: toDateN(input.lastActivityAt),
        });
        return (await dealsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.deals)
          .set({ ...patchToDb(patch as Record<string, unknown>), version: sql`${t.deals.version} + 1`, updatedAt: new Date() })
          .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, uid(id))));
        const row = await dealsPort.get(id);
        if (!row) throw OpError.notFound("deal", id);
        return row;
      });
    },
    async setArchived(id, archived) {
      return dealsPort.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      await run(async (x) => {
        const did = uid(id);
        await x.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, did)));
        await x.delete(t.dealTags).where(and(eq(t.dealTags.workspaceId, ws), eq(t.dealTags.entityId, did)));
        await x
          .delete(t.dealCustomFieldValues)
          .where(and(eq(t.dealCustomFieldValues.workspaceId, ws), eq(t.dealCustomFieldValues.entityId, did)));
        await x.delete(t.dealOfferingLinks).where(and(eq(t.dealOfferingLinks.workspaceId, ws), eq(t.dealOfferingLinks.entityId, did)));
        await x.delete(t.dealListMembers).where(and(eq(t.dealListMembers.workspaceId, ws), eq(t.dealListMembers.entityId, did)));
        await x.update(t.activities).set({ dealId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.dealId, did)));
        await x.update(t.engagements).set({ dealId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.dealId, did)));
        await x.delete(t.deals).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, did)));
      });
    },
    async stakeholders(dealId) {
      return run(async (x) => {
        const rows = await x
          .select({ sh: t.dealStakeholders, person: t.people })
          .from(t.dealStakeholders)
          .innerJoin(t.people, and(eq(t.people.id, t.dealStakeholders.personId), eq(t.people.workspaceId, ws)))
          .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, uid(dealId))))
          .orderBy(desc(t.dealStakeholders.isPrimary), asc(t.people.name));
        return rows.map((r) => ({ ...mapStakeholder(r.sh), person: mapPerson(r.person) }));
      });
    },
    async getStakeholder(id) {
      return run(async (x) => {
        const [r] = await x
          .select()
          .from(t.dealStakeholders)
          .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.id, uid(id))))
          .limit(1);
        return r ? mapStakeholder(r) : null;
      });
    },
    async addStakeholder(input) {
      return run(async (x) => {
        const [existing] = await x
          .select()
          .from(t.dealStakeholders)
          .where(
            and(
              eq(t.dealStakeholders.workspaceId, ws),
              eq(t.dealStakeholders.dealId, uid(input.dealId)),
              eq(t.dealStakeholders.personId, uid(input.personId)),
            ),
          )
          .limit(1);
        if (existing) {
          return dealsPort.updateStakeholder(existing.id, { role: input.role, isPrimary: input.isPrimary, note: input.note });
        }
        const id = newId();
        if (input.isPrimary) {
          await x
            .update(t.dealStakeholders)
            .set({ isPrimary: false })
            .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, uid(input.dealId))));
        }
        await x.insert(t.dealStakeholders).values({
          id,
          workspaceId: ws,
          dealId: input.dealId,
          personId: input.personId,
          role: input.role ?? null,
          isPrimary: input.isPrimary ?? false,
          note: input.note ?? null,
        });
        return (await dealsPort.getStakeholder(id))!;
      });
    },
    async updateStakeholder(id, patch) {
      return run(async (x) => {
        const existing = await dealsPort.getStakeholder(id);
        if (!existing) throw OpError.notFound("stakeholder", id);
        if (patch.isPrimary) {
          await x
            .update(t.dealStakeholders)
            .set({ isPrimary: false })
            .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, existing.dealId)));
        }
        await x
          .update(t.dealStakeholders)
          .set({
            ...(patch.role !== undefined ? { role: patch.role } : {}),
            ...(patch.isPrimary !== undefined ? { isPrimary: !!patch.isPrimary } : {}),
            ...(patch.note !== undefined ? { note: patch.note } : {}),
          })
          .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.id, uid(id))));
        return (await dealsPort.getStakeholder(id))!;
      });
    },
    async removeStakeholder(id) {
      await run(async (x) => {
        await x.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.id, uid(id))));
      });
    },
    async stageStats(pipelineId) {
      return run(async (x) => {
        const rows = await execRows<{ stageId: string; currency: string; n: unknown; total: unknown; weighted: unknown }>(
          x,
          sql`SELECT d.stage_id AS "stageId", d.currency AS currency, COUNT(*)::int AS n,
                     SUM(COALESCE(d.amount_minor, 0)) AS total,
                     SUM(COALESCE(d.amount_minor, 0) * COALESCE(d.probability, s.probability, 0) / 100.0) AS weighted
              FROM ${t.deals} d JOIN ${t.stages} s ON s.id = d.stage_id AND s.workspace_id = d.workspace_id
              WHERE d.workspace_id = ${ws} AND d.pipeline_id = ${uid(pipelineId)} AND d.archived_at IS NULL
              GROUP BY d.stage_id, d.currency`,
        );
        const byStage = new Map<string, { stageId: string; count: number; sums: Record<string, number>; weighted: Record<string, number> }>();
        for (const r of rows) {
          const entry = byStage.get(r.stageId) ?? { stageId: r.stageId, count: 0, sums: {}, weighted: {} };
          const total = num(r.total);
          const weighted = num(r.weighted);
          entry.count += num(r.n);
          if (total > 0) entry.sums[r.currency] = (entry.sums[r.currency] ?? 0) + total;
          if (weighted > 0) entry.weighted[r.currency] = (entry.weighted[r.currency] ?? 0) + Math.round(weighted);
          byStage.set(r.stageId, entry);
        }
        return [...byStage.values()];
      });
    },
  };

  // --- offerings -------------------------------------------------------------

  const offeringsPort: AsyncPort<Ports["offerings"]> = {
    async list(includeArchived) {
      return run(async (x) => {
        const conds = [eq(t.offerings.workspaceId, ws)];
        if (!includeArchived) conds.push(isNull(t.offerings.archivedAt));
        const rows = await x
          .select()
          .from(t.offerings)
          .where(and(...conds))
          .orderBy(asc(t.offerings.name));
        return rows.map(mapOffering);
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.offerings)
          .where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, uid(id))))
          .limit(1);
        return row ? mapOffering(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        const now = new Date();
        await x.insert(t.offerings).values({
          id,
          workspaceId: ws,
          name: input.name,
          type: input.type,
          description: input.description ?? null,
          active: input.active !== false,
          ownerUserId: input.ownerUserId ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        return (await offeringsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        const { active, ...rest } = patch;
        await x
          .update(t.offerings)
          .set({
            ...patchToDb(rest as Record<string, unknown>),
            ...(active === undefined ? {} : { active: !!active }),
            version: sql`${t.offerings.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, uid(id))));
        const row = await offeringsPort.get(id);
        if (!row) throw OpError.notFound("offering", id);
        return row;
      });
    },
    async setArchived(id, archived) {
      return offeringsPort.update(id, { archivedAt: archived ? nowIso() : null } as Partial<Offering>);
    },
    async hardDelete(id) {
      await run(async (x) => {
        const oid = uid(id);
        await x
          .delete(t.engagementOfferingLinks)
          .where(and(eq(t.engagementOfferingLinks.workspaceId, ws), eq(t.engagementOfferingLinks.offeringId, oid)));
        await x
          .delete(t.dealOfferingLinks)
          .where(and(eq(t.dealOfferingLinks.workspaceId, ws), eq(t.dealOfferingLinks.offeringId, oid)));
        await x
          .delete(t.offeringCustomFieldValues)
          .where(and(eq(t.offeringCustomFieldValues.workspaceId, ws), eq(t.offeringCustomFieldValues.entityId, oid)));
        await x.delete(t.offerings).where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, oid)));
      });
    },
    async links(entityType, entityId) {
      return run(async (x) => {
        const lt = t.OFFERING_LINK_TABLES[entityType];
        const rows = await x
          .select({ link: lt, offering: t.offerings })
          .from(lt)
          .innerJoin(t.offerings, and(eq(t.offerings.id, lt.offeringId), eq(t.offerings.workspaceId, ws)))
          .where(and(eq(lt.workspaceId, ws), eq(lt.entityId, uid(entityId))));
        return rows.map((r) => ({ ...mapOfferingLink(r.link, entityType), offering: mapOffering(r.offering) }));
      });
    },
    async linksForOffering(offeringId) {
      return run(async (x) => {
        const out: OfferingLink[] = [];
        for (const entityType of ["engagement", "deal"] as const) {
          const lt = t.OFFERING_LINK_TABLES[entityType];
          const rows = await x
            .select()
            .from(lt)
            .where(and(eq(lt.workspaceId, ws), eq(lt.offeringId, uid(offeringId))));
          out.push(...rows.map((r) => mapOfferingLink(r, entityType)));
        }
        return out;
      });
    },
    async linksForEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      return run(async (x) => {
        const lt = t.OFFERING_LINK_TABLES[entityType];
        const rows = await x
          .select({ link: lt, offering: t.offerings })
          .from(lt)
          .innerJoin(t.offerings, and(eq(t.offerings.id, lt.offeringId), eq(t.offerings.workspaceId, ws)))
          .where(and(eq(lt.workspaceId, ws), inArray(lt.entityId, uidList(entityIds))));
        const out: Record<string, Array<{ id: string; name: string; isPrimary: boolean }>> = {};
        for (const r of rows) {
          (out[r.link.entityId] ??= []).push({ id: r.offering.id, name: r.offering.name, isPrimary: r.link.isPrimary });
        }
        return out;
      });
    },
    async link(input) {
      return run(async (x) => {
        const lt = t.OFFERING_LINK_TABLES[input.entityType];
        const [existing] = await x
          .select()
          .from(lt)
          .where(and(eq(lt.workspaceId, ws), eq(lt.offeringId, uid(input.offeringId)), eq(lt.entityId, uid(input.entityId))))
          .limit(1);
        if (existing) {
          await x
            .update(lt)
            .set({
              fit: input.fit ?? existing.fit,
              note: input.note ?? existing.note,
              isPrimary: input.isPrimary ? true : existing.isPrimary,
            })
            .where(and(eq(lt.workspaceId, ws), eq(lt.id, existing.id)));
          const [r] = await x.select().from(lt).where(and(eq(lt.workspaceId, ws), eq(lt.id, existing.id))).limit(1);
          return mapOfferingLink(r!, input.entityType);
        }
        const id = newId();
        await x.insert(lt).values({
          id,
          workspaceId: ws,
          offeringId: input.offeringId,
          entityId: input.entityId,
          fit: input.fit ?? null,
          note: input.note ?? null,
          isPrimary: input.isPrimary ?? false,
        });
        return {
          id,
          offeringId: input.offeringId,
          entityType: input.entityType,
          entityId: input.entityId,
          fit: input.fit ?? null,
          note: input.note ?? null,
          isPrimary: input.isPrimary ?? false,
        };
      });
    },
    async unlink(offeringId, entityType, entityId) {
      await run(async (x) => {
        const lt = t.OFFERING_LINK_TABLES[entityType];
        await x
          .delete(lt)
          .where(and(eq(lt.workspaceId, ws), eq(lt.offeringId, uid(offeringId)), eq(lt.entityId, uid(entityId))));
      });
    },
  };

  // --- activities ------------------------------------------------------------

  const activitiesPort: AsyncPort<Ports["activities"]> = {
    async list(filter: ActivityFilter): Promise<Page<Activity>> {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.activities.workspaceId, ws) as unknown as SQL];
        const kinds = filter.kinds ?? (filter.kind ? [filter.kind] : null);
        if (kinds?.length) conds.push(inArray(t.activities.kind, kinds) as unknown as SQL);
        if (filter.companyId) conds.push(eq(t.activities.companyId, uid(filter.companyId)) as unknown as SQL);
        if (filter.personId) conds.push(eq(t.activities.personId, uid(filter.personId)) as unknown as SQL);
        if (filter.engagementId) conds.push(eq(t.activities.engagementId, uid(filter.engagementId)) as unknown as SQL);
        if (filter.dealId) conds.push(eq(t.activities.dealId, uid(filter.dealId)) as unknown as SQL);
        if (filter.actorType) conds.push(eq(t.activities.actorType, filter.actorType) as unknown as SQL);
        if (filter.assigneeUserId) conds.push(eq(t.activities.assigneeUserId, uid(filter.assigneeUserId)) as unknown as SQL);
        if (filter.open) {
          conds.push(eq(t.activities.kind, "task") as unknown as SQL);
          conds.push(isNull(t.activities.completedAt) as unknown as SQL);
        }
        const today = todayIso();
        if (filter.overdue) {
          conds.push(sql`${t.activities.dueAt} IS NOT NULL AND substr(${t.activities.dueAt}, 1, 10) < ${today}`);
        }
        if (filter.dueWithinDays !== undefined) {
          const until = new Date(Date.now() + filter.dueWithinDays * 86_400_000).toISOString().slice(0, 10);
          conds.push(
            sql`${t.activities.dueAt} IS NOT NULL AND substr(${t.activities.dueAt}, 1, 10) >= ${today} AND substr(${t.activities.dueAt}, 1, 10) <= ${until}`,
          );
        }
        const where = and(...conds);
        const [totalRow] = await x.select({ n: count() }).from(t.activities).where(where);
        const orderBy =
          filter.open || filter.overdue || filter.dueWithinDays !== undefined
            ? [sql`${t.activities.dueAt} IS NULL`, asc(t.activities.dueAt)]
            : [desc(t.activities.createdAt)];
        const rows = await x
          .select()
          .from(t.activities)
          .where(where)
          .orderBy(...(orderBy as [SQL]))
          .limit(filter.limit)
          .offset(filter.offset);
        return { items: rows.map(mapActivity), total: totalRow?.n ?? 0 };
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.activities)
          .where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, uid(id))))
          .limit(1);
        return row ? mapActivity(row) : null;
      });
    },
    async create(input, actor: ActorStamp) {
      return run(async (x) => {
        const id = input.id ?? newId();
        const now = new Date();
        await x.insert(t.activities).values({
          id,
          workspaceId: ws,
          kind: input.kind,
          displayId: input.kind === "task" ? await nextDisplayId(x, "task") : null,
          title: input.title ?? null,
          body: input.body ?? null,
          companyId: input.companyId ?? null,
          personId: input.personId ?? null,
          engagementId: input.engagementId ?? null,
          dealId: input.dealId ?? null,
          dueAt: input.dueAt ?? null,
          assigneeUserId: input.assigneeUserId ?? null,
          completedAt: toDateN(input.completedAt),
          actorType: actor.actorType,
          actorUserId: actor.actorUserId,
          actorClientId: actor.actorClientId,
          meta: input.meta ?? null,
          createdAt: input.createdAt ? toDate(input.createdAt) : now,
          updatedAt: now,
        });
        return (await activitiesPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        const { meta, ...rest } = patch;
        await x
          .update(t.activities)
          .set({
            ...patchToDb(rest as Record<string, unknown>),
            ...(meta === undefined ? {} : { meta: meta ?? null }),
            updatedAt: new Date(),
          })
          .where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, uid(id))));
        const row = await activitiesPort.get(id);
        if (!row) throw OpError.notFound("activity", id);
        return row;
      });
    },
    async hardDelete(id) {
      await run(async (x) => {
        await x.delete(t.activities).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, uid(id))));
      });
    },
    async touchLinked(activity, at) {
      await run(async (x) => {
        if (activity.engagementId) {
          await x
            .update(t.engagements)
            .set({ lastActivityAt: toDate(at) })
            .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, uid(activity.engagementId))));
        }
        if (activity.dealId) {
          await x
            .update(t.deals)
            .set({ lastActivityAt: toDate(at) })
            .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, uid(activity.dealId))));
        }
      });
    },
  };

  // --- tags --------------------------------------------------------------------

  const tagsPort: AsyncPort<Ports["tags"]> = {
    async list() {
      return run(async (x) => {
        const rows = await x.select().from(t.tags).where(eq(t.tags.workspaceId, ws)).orderBy(asc(t.tags.name));
        const usage = await execRows<{ tagId: string; n: unknown }>(
          x,
          sql`SELECT tag_id AS "tagId", COUNT(*)::int AS n FROM (
                SELECT tag_id FROM ${t.companyTags} WHERE workspace_id = ${ws}
                UNION ALL SELECT tag_id FROM ${t.personTags} WHERE workspace_id = ${ws}
                UNION ALL SELECT tag_id FROM ${t.engagementTags} WHERE workspace_id = ${ws}
                UNION ALL SELECT tag_id FROM ${t.dealTags} WHERE workspace_id = ${ws}
              ) u GROUP BY tag_id`,
        );
        const usageMap = new Map(usage.map((u) => [u.tagId, num(u.n)]));
        return rows.map((r) => ({ ...mapTag(r), usage: usageMap.get(r.id) ?? 0 }));
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.tags)
          .where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, uid(id))))
          .limit(1);
        return row ? mapTag(row) : null;
      });
    },
    async getByName(name) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.tags)
          .where(and(eq(t.tags.workspaceId, ws), sql`lower(${t.tags.name}) = ${name.trim().toLowerCase()}`))
          .limit(1);
        return row ? mapTag(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        await x.insert(t.tags).values({ id, workspaceId: ws, name: input.name, color: input.color, createdAt: new Date() });
        return (await tagsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.tags)
          .set(patch as Record<string, unknown>)
          .where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, uid(id))));
        const row = await tagsPort.get(id);
        if (!row) throw OpError.notFound("tag", id);
        return row;
      });
    },
    async delete(id) {
      await run(async (x) => {
        const tid = uid(id);
        for (const entityType of ["company", "person", "engagement", "deal"] as const) {
          const tt = t.TAG_LINK_TABLES[entityType];
          await x.delete(tt).where(and(eq(tt.workspaceId, ws), eq(tt.tagId, tid)));
        }
        await x.delete(t.tags).where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, tid)));
      });
    },
    async apply(tagId, entityType, entityId) {
      await run(async (x) => {
        const tt = t.TAG_LINK_TABLES[entityType];
        await x
          .insert(tt)
          .values({ id: newId(), workspaceId: ws, tagId, entityId })
          .onConflictDoNothing({ target: [tt.workspaceId, tt.tagId, tt.entityId] });
      });
    },
    async remove(tagId, entityType, entityId) {
      await run(async (x) => {
        const tt = t.TAG_LINK_TABLES[entityType];
        await x
          .delete(tt)
          .where(and(eq(tt.workspaceId, ws), eq(tt.tagId, uid(tagId)), eq(tt.entityId, uid(entityId))));
      });
    },
    async forEntity(entityType, entityId) {
      return run(async (x) => {
        const tt = t.TAG_LINK_TABLES[entityType];
        const rows = await x
          .select({ tag: t.tags })
          .from(tt)
          .innerJoin(t.tags, and(eq(t.tags.id, tt.tagId), eq(t.tags.workspaceId, ws)))
          .where(and(eq(tt.workspaceId, ws), eq(tt.entityId, uid(entityId))))
          .orderBy(asc(t.tags.name));
        return rows.map((r) => mapTag(r.tag));
      });
    },
    async forEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      return run(async (x) => {
        const tt = t.TAG_LINK_TABLES[entityType];
        const rows = await x
          .select({ tag: t.tags, entityId: tt.entityId })
          .from(tt)
          .innerJoin(t.tags, and(eq(t.tags.id, tt.tagId), eq(t.tags.workspaceId, ws)))
          .where(and(eq(tt.workspaceId, ws), inArray(tt.entityId, uidList(entityIds))));
        const out: Record<string, Tag[]> = {};
        for (const r of rows) (out[r.entityId] ??= []).push(mapTag(r.tag));
        return out;
      });
    },
  };

  // --- contact lists ------------------------------------------------------

  const listMemberCounts = async (x: PgDb): Promise<Array<{ listId: string; entityType: string; n: number }>> => {
    const rows = await execRows<{ listId: string; entityType: string; n: unknown }>(
      x,
      sql`SELECT list_id AS "listId", 'company' AS "entityType", COUNT(*)::int AS n FROM ${t.companyListMembers} WHERE workspace_id = ${ws} GROUP BY list_id
          UNION ALL SELECT list_id, 'person', COUNT(*)::int FROM ${t.personListMembers} WHERE workspace_id = ${ws} GROUP BY list_id
          UNION ALL SELECT list_id, 'engagement', COUNT(*)::int FROM ${t.engagementListMembers} WHERE workspace_id = ${ws} GROUP BY list_id
          UNION ALL SELECT list_id, 'deal', COUNT(*)::int FROM ${t.dealListMembers} WHERE workspace_id = ${ws} GROUP BY list_id`,
    );
    return rows.map((r) => ({ listId: r.listId, entityType: r.entityType, n: num(r.n) }));
  };

  const listsPort: AsyncPort<Ports["lists"]> = {
    async list() {
      return run(async (x) => {
        const rows = await x.select().from(t.lists).where(eq(t.lists.workspaceId, ws)).orderBy(asc(t.lists.name));
        const counts = await listMemberCounts(x);
        const byList = new Map<string, { people: number; companies: number; engagements: number; deals: number }>();
        for (const c of counts) {
          const entry = byList.get(c.listId) ?? { people: 0, companies: 0, engagements: 0, deals: 0 };
          if (c.entityType === "person") entry.people = c.n;
          if (c.entityType === "company") entry.companies = c.n;
          if (c.entityType === "engagement") entry.engagements = c.n;
          if (c.entityType === "deal") entry.deals = c.n;
          byList.set(c.listId, entry);
        }
        return rows.map((r) => ({
          ...mapList(r),
          ...(byList.get(r.id) ?? { people: 0, companies: 0, engagements: 0, deals: 0 }),
        }));
      });
    },
    async get(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.lists)
          .where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, uid(id))))
          .limit(1);
        return row ? mapList(row) : null;
      });
    },
    async getByName(name) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.lists)
          .where(and(eq(t.lists.workspaceId, ws), sql`lower(${t.lists.name}) = ${name.trim().toLowerCase()}`))
          .limit(1);
        return row ? mapList(row) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        const now = new Date();
        await x.insert(t.lists).values({
          id,
          workspaceId: ws,
          name: input.name,
          description: input.description ?? null,
          color: input.color,
          entityType: input.entityType ?? null,
          createdAt: now,
          updatedAt: now,
        });
        return (await listsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.lists)
          .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
          .where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, uid(id))));
        const row = await listsPort.get(id);
        if (!row) throw OpError.notFound("list", id);
        return row;
      });
    },
    async delete(id) {
      await run(async (x) => {
        const lid = uid(id);
        for (const entityType of ["company", "person", "engagement", "deal"] as const) {
          const mt = t.LIST_MEMBER_TABLES[entityType];
          await x.delete(mt).where(and(eq(mt.workspaceId, ws), eq(mt.listId, lid)));
        }
        await x.delete(t.lists).where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, lid)));
      });
    },
    async memberTypeCounts(listId) {
      return run(async (x) => {
        const counts = await listMemberCounts(x);
        const out: Record<string, number> = {};
        for (const c of counts) {
          if (c.listId === uid(listId) && c.n > 0) out[c.entityType] = c.n;
        }
        return out;
      });
    },
    async addMembers(listId, entityType, entityIds) {
      if (entityIds.length === 0) return 0;
      return run(async (x) => {
        const mt = t.LIST_MEMBER_TABLES[entityType];
        const now = new Date();
        const inserted = await x
          .insert(mt)
          .values(entityIds.map((entityId) => ({ id: newId(), workspaceId: ws, listId, entityId, createdAt: now })))
          .onConflictDoNothing({ target: [mt.workspaceId, mt.listId, mt.entityId] })
          .returning({ id: mt.id });
        return inserted.length;
      });
    },
    async removeMembers(listId, entityType, entityIds) {
      if (entityIds.length === 0) return 0;
      return run(async (x) => {
        const mt = t.LIST_MEMBER_TABLES[entityType];
        const removed = await x
          .delete(mt)
          .where(and(eq(mt.workspaceId, ws), eq(mt.listId, uid(listId)), inArray(mt.entityId, uidList(entityIds))))
          .returning({ id: mt.id });
        return removed.length;
      });
    },
    async forEntity(entityType, entityId) {
      return run(async (x) => {
        const mt = t.LIST_MEMBER_TABLES[entityType];
        const rows = await x
          .select({ list: t.lists })
          .from(mt)
          .innerJoin(t.lists, and(eq(t.lists.id, mt.listId), eq(t.lists.workspaceId, ws)))
          .where(and(eq(mt.workspaceId, ws), eq(mt.entityId, uid(entityId))))
          .orderBy(asc(t.lists.name));
        return rows.map((r) => mapList(r.list));
      });
    },
    async forEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      return run(async (x) => {
        const mt = t.LIST_MEMBER_TABLES[entityType];
        const rows = await x
          .select({ list: t.lists, entityId: mt.entityId })
          .from(mt)
          .innerJoin(t.lists, and(eq(t.lists.id, mt.listId), eq(t.lists.workspaceId, ws)))
          .where(and(eq(mt.workspaceId, ws), inArray(mt.entityId, uidList(entityIds))));
        const out: Record<string, ContactList[]> = {};
        for (const r of rows) (out[r.entityId] ??= []).push(mapList(r.list));
        return out;
      });
    },
  };

  // --- custom fields ------------------------------------------------------------

  const customFieldsPort: AsyncPort<Ports["customFields"]> = {
    async listDefs(entityType, includeArchived = false) {
      return run(async (x) => {
        const conds = [eq(t.customFieldDefs.workspaceId, ws)];
        if (entityType) conds.push(eq(t.customFieldDefs.entityType, entityType));
        if (!includeArchived) conds.push(isNull(t.customFieldDefs.archivedAt));
        const rows = await x
          .select()
          .from(t.customFieldDefs)
          .where(and(...conds))
          .orderBy(asc(t.customFieldDefs.position), asc(t.customFieldDefs.createdAt));
        return rows.map(mapCfd);
      });
    },
    async getDef(id) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.customFieldDefs)
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, uid(id))))
          .limit(1);
        return row ? mapCfd(row) : null;
      });
    },
    async getDefByKey(entityType, key) {
      return run(async (x) => {
        const [row] = await x
          .select()
          .from(t.customFieldDefs)
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.entityType, entityType), eq(t.customFieldDefs.key, key)))
          .limit(1);
        return row ? mapCfd(row) : null;
      });
    },
    async createDef(input) {
      return run(async (x) => {
        const id = newId();
        const [maxRow] = await x
          .select({ n: sql<number>`COALESCE(MAX(${t.customFieldDefs.position}), -1)` })
          .from(t.customFieldDefs)
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.entityType, input.entityType)));
        await x.insert(t.customFieldDefs).values({
          id,
          workspaceId: ws,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          options: input.options ?? null,
          required: input.required,
          position: num(maxRow?.n ?? -1) + 1,
          createdAt: new Date(),
        });
        return (await customFieldsPort.getDef(id))!;
      });
    },
    async updateDef(id, patch) {
      return run(async (x) => {
        await x
          .update(t.customFieldDefs)
          .set({
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.options !== undefined ? { options: patch.options ?? null } : {}),
            ...(patch.required !== undefined ? { required: patch.required } : {}),
          })
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, uid(id))));
        const def = await customFieldsPort.getDef(id);
        if (!def) throw OpError.notFound("custom field", id);
        return def;
      });
    },
    async setDefArchived(id, archived) {
      return run(async (x) => {
        await x
          .update(t.customFieldDefs)
          .set({ archivedAt: archived ? new Date() : null })
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, uid(id))));
        const def = await customFieldsPort.getDef(id);
        if (!def) throw OpError.notFound("custom field", id);
        return def;
      });
    },
    async setValue(fieldId, entityType, entityId, value) {
      await run(async (x) => {
        const vt = t.CUSTOM_FIELD_VALUE_TABLES[entityType];
        if (value === null) {
          await x
            .delete(vt)
            .where(and(eq(vt.workspaceId, ws), eq(vt.fieldId, uid(fieldId)), eq(vt.entityId, uid(entityId))));
          return;
        }
        await x
          .insert(vt)
          .values({ id: newId(), workspaceId: ws, fieldId, entityId, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [vt.workspaceId, vt.fieldId, vt.entityId],
            set: { value, updatedAt: new Date() },
          });
      });
    },
    async values(entityType, entityId) {
      return run(async (x) => {
        const vt = t.CUSTOM_FIELD_VALUE_TABLES[entityType];
        const rows = await x
          .select({ value: vt.value, key: t.customFieldDefs.key })
          .from(vt)
          .innerJoin(
            t.customFieldDefs,
            and(eq(t.customFieldDefs.id, vt.fieldId), eq(t.customFieldDefs.workspaceId, ws)),
          )
          .where(and(eq(vt.workspaceId, ws), eq(vt.entityId, uid(entityId)), isNull(t.customFieldDefs.archivedAt)));
        const out: Record<string, CustomFieldValue> = {};
        for (const r of rows) out[r.key] = (r.value ?? null) as CustomFieldValue;
        return out;
      });
    },
  };

  // --- saved views ----------------------------------------------------------------

  const savedViewsPort: AsyncPort<Ports["savedViews"]> = {
    async list(userId) {
      return run(async (x) => {
        const rows = await x
          .select()
          .from(t.savedViews)
          .where(
            and(
              eq(t.savedViews.workspaceId, ws),
              or(
                inArray(t.savedViews.visibility, ["shared", "system"]),
                userId ? eq(t.savedViews.ownerUserId, uid(userId)) : sql`false`,
              ),
            ),
          )
          .orderBy(asc(t.savedViews.name));
        return rows.map(mapSavedView);
      });
    },
    async get(id) {
      return run(async (x) => {
        const [r] = await x
          .select()
          .from(t.savedViews)
          .where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, uid(id))))
          .limit(1);
        return r ? mapSavedView(r) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        const now = new Date();
        await x.insert(t.savedViews).values({
          id,
          workspaceId: ws,
          name: input.name,
          entityType: input.entityType,
          filters: input.filters,
          visibility: input.visibility,
          ownerUserId: input.ownerUserId,
          createdAt: now,
          updatedAt: now,
        });
        return (await savedViewsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.savedViews)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
            ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, uid(id))));
        const v = await savedViewsPort.get(id);
        if (!v) throw OpError.notFound("saved view", id);
        return v;
      });
    },
    async delete(id) {
      await run(async (x) => {
        await x.delete(t.savedViews).where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, uid(id))));
      });
    },
  };

  // --- pending actions ----------------------------------------------------------

  const pendingPort: AsyncPort<Ports["pendingActions"]> = {
    async list(status) {
      return run(async (x) => {
        const conds = [eq(t.pendingActions.workspaceId, ws)];
        if (status) conds.push(eq(t.pendingActions.status, status));
        const rows = await x
          .select()
          .from(t.pendingActions)
          .where(and(...conds))
          .orderBy(desc(t.pendingActions.requestedAt))
          .limit(200);
        return rows.map(mapPending);
      });
    },
    async get(id) {
      return run(async (x) => {
        const [r] = await x
          .select()
          .from(t.pendingActions)
          .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.id, uid(id))))
          .limit(1);
        return r ? mapPending(r) : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        await x.insert(t.pendingActions).values({
          id,
          workspaceId: ws,
          operation: input.operation,
          input: input.input,
          preview: input.preview ?? null,
          riskCategory: input.riskCategory,
          status: "pending",
          requestedByType: input.actor.actorType,
          requestedByUserId: input.actor.actorUserId,
          requestedByClientId: input.actor.actorClientId,
          requestedAt: new Date(),
          expiresAt: toDate(input.expiresAt),
        });
        return (await pendingPort.get(id))!;
      });
    },
    async setStatus(id, patch) {
      return run(async (x) => {
        await x
          .update(t.pendingActions)
          .set({
            status: patch.status,
            reviewedByUserId: patch.reviewedByUserId ?? null,
            reviewedAt: new Date(),
            reviewNote: patch.reviewNote ?? null,
            result: patch.result ?? null,
          })
          .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.id, uid(id))));
        const pa = await pendingPort.get(id);
        if (!pa) throw OpError.notFound("pending action", id);
        return pa;
      });
    },
    async countPending() {
      return run(async (x) => {
        const [row] = await x
          .select({ n: count() })
          .from(t.pendingActions)
          .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.status, "pending")));
        return row?.n ?? 0;
      });
    },
  };

  // --- audit ---------------------------------------------------------------------

  const auditPort: AsyncPort<Ports["audit"]> = {
    async record(input: AuditInput, actor: ActorStamp) {
      return run(async (x) => {
        const id = newId();
        await x.insert(t.auditEvents).values({
          id,
          workspaceId: ws,
          operation: input.operation,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          summary: input.summary,
          meta: input.meta ?? null,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId,
          actorClientId: actor.actorClientId,
          surface: actor.surface,
          createdAt: new Date(),
        });
        const [row] = await x
          .select()
          .from(t.auditEvents)
          .where(and(eq(t.auditEvents.workspaceId, ws), eq(t.auditEvents.id, id)))
          .limit(1);
        return mapAudit(row!);
      });
    },
    async list(filter) {
      return run(async (x) => {
        const conds: SQL[] = [eq(t.auditEvents.workspaceId, ws) as unknown as SQL];
        if (filter.actorType) conds.push(eq(t.auditEvents.actorType, filter.actorType) as unknown as SQL);
        if (filter.operation) conds.push(like(t.auditEvents.operation, `${filter.operation}%`) as unknown as SQL);
        if (filter.entityType) conds.push(eq(t.auditEvents.entityType, filter.entityType) as unknown as SQL);
        if (filter.entityId) conds.push(eq(t.auditEvents.entityId, filter.entityId) as unknown as SQL);
        const where = and(...conds);
        const [totalRow] = await x.select({ n: count() }).from(t.auditEvents).where(where);
        const rows = await x
          .select()
          .from(t.auditEvents)
          .where(where)
          .orderBy(desc(t.auditEvents.createdAt))
          .limit(filter.limit)
          .offset(filter.offset);
        return { items: rows.map(mapAudit), total: totalRow?.n ?? 0 };
      });
    },
  };

  // --- MCP clients ------------------------------------------------------------------

  const mcpClientsPort: AsyncPort<Ports["mcpClients"]> & { revokeAllForUser(userId: string): Promise<number> } = {
    async list() {
      return run(async (x) => {
        const rows = await x
          .select()
          .from(t.mcpClients)
          .where(eq(t.mcpClients.workspaceId, ws))
          .orderBy(desc(t.mcpClients.createdAt));
        return rows.map(mapMcpClient);
      });
    },
    async get(id) {
      return run(async (x) => {
        const [r] = await x
          .select()
          .from(t.mcpClients)
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, uid(id))))
          .limit(1);
        return r ? mapMcpClient(r) : null;
      });
    },
    async getByTokenHash(hash) {
      // Workspace-scoped on purpose: global key resolution belongs to the
      // narrow SECURITY DEFINER resolver (crm.resolve_mcp_key), not a port.
      return run(async (x) => {
        const [r] = await x
          .select()
          .from(t.mcpClients)
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.tokenHash, hash)))
          .limit(1);
        return r ? { ...mapMcpClient(r), workspaceId: r.workspaceId } : null;
      });
    },
    async create(input) {
      return run(async (x) => {
        const id = newId();
        await x.insert(t.mcpClients).values({
          id,
          workspaceId: ws,
          name: input.name,
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          scopes: input.scopes,
          trust: input.trust,
          createdByUserId: input.createdByUserId,
          createdAt: new Date(),
        });
        return (await mcpClientsPort.get(id))!;
      });
    },
    async update(id, patch) {
      return run(async (x) => {
        await x
          .update(t.mcpClients)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
            ...(patch.trust !== undefined ? { trust: patch.trust } : {}),
          })
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, uid(id))));
        const c = await mcpClientsPort.get(id);
        if (!c) throw OpError.notFound("MCP client", id);
        return c;
      });
    },
    async revoke(id) {
      return run(async (x) => {
        await x
          .update(t.mcpClients)
          .set({ revokedAt: new Date() })
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, uid(id))));
        const c = await mcpClientsPort.get(id);
        if (!c) throw OpError.notFound("MCP client", id);
        return c;
      });
    },
    async revokeAllForUser(userId) {
      // Disable-revocation (docs/issues/0022): same semantics as revoke() —
      // flag with revokedAt, never delete — and only still-active clients, so
      // earlier revocation timestamps survive. Returns the number revoked.
      return run(async (x) => {
        const rows = await x
          .update(t.mcpClients)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(t.mcpClients.workspaceId, ws),
              eq(t.mcpClients.createdByUserId, uid(userId)),
              isNull(t.mcpClients.revokedAt),
            ),
          )
          .returning({ id: t.mcpClients.id });
        return rows.length;
      });
    },
    async touchLastUsed(id) {
      await run(async (x) => {
        await x
          .update(t.mcpClients)
          .set({ lastUsedAt: new Date() })
          .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, uid(id))));
      });
    },
  };

  // --- search -------------------------------------------------------------------

  const searchPort: AsyncPort<Ports["search"]> = {
    async global(query, limit): Promise<SearchHit[]> {
      return run(async (x) => {
        const prefixes = (await settings(x)).prefixes;
        const q = `%${query.trim().toLowerCase()}%`;
        const hits: SearchHit[] = [];

        const companies = await execRows<{ id: string; displayId: number; name: string; industry: string | null; archived: boolean }>(
          x,
          sql`SELECT id, display_id AS "displayId", name, industry, (archived_at IS NOT NULL) AS archived
              FROM ${t.companies}
              WHERE workspace_id = ${ws} AND (lower(name) LIKE ${q} OR lower(coalesce(industry, '')) LIKE ${q})
              ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ${limit}`,
        );
        hits.push(
          ...companies.map((c) => ({
            entityType: "company" as const,
            id: c.id,
            ref: `${prefixes["company"] ?? "COMPANY"}-${c.displayId}`,
            title: c.name,
            subtitle: c.industry,
            archived: c.archived,
          })),
        );

        const people = await execRows<{
          id: string;
          displayId: number;
          name: string;
          title: string | null;
          email: string | null;
          archived: boolean;
        }>(
          x,
          sql`SELECT id, display_id AS "displayId", name, title, email, (archived_at IS NOT NULL) AS archived
              FROM ${t.people}
              WHERE workspace_id = ${ws}
                AND (lower(name) LIKE ${q} OR lower(coalesce(email, '')) LIKE ${q} OR lower(coalesce(title, '')) LIKE ${q})
              ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ${limit}`,
        );
        hits.push(
          ...people.map((p) => ({
            entityType: "person" as const,
            id: p.id,
            ref: `${prefixes["person"] ?? "PERSON"}-${p.displayId}`,
            title: p.name,
            subtitle: p.title ?? p.email,
            archived: p.archived,
          })),
        );

        const engagements = await execRows<{ id: string; displayId: number; title: string; channel: string | null; archived: boolean }>(
          x,
          sql`SELECT id, display_id AS "displayId", title, channel, (archived_at IS NOT NULL) AS archived
              FROM ${t.engagements}
              WHERE workspace_id = ${ws} AND (lower(title) LIKE ${q} OR lower(coalesce(source, '')) LIKE ${q})
              ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ${limit}`,
        );
        hits.push(
          ...engagements.map((e) => ({
            entityType: "engagement" as const,
            id: e.id,
            ref: `${prefixes["engagement"] ?? "LEAD"}-${e.displayId}`,
            title: e.title,
            subtitle: e.channel,
            archived: e.archived,
          })),
        );

        const deals = await execRows<{ id: string; displayId: number; title: string; status: string; archived: boolean }>(
          x,
          sql`SELECT id, display_id AS "displayId", title, status, (archived_at IS NOT NULL) AS archived
              FROM ${t.deals}
              WHERE workspace_id = ${ws} AND lower(title) LIKE ${q}
              ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ${limit}`,
        );
        hits.push(
          ...deals.map((d) => ({
            entityType: "deal" as const,
            id: d.id,
            ref: `${prefixes["deal"] ?? "DEAL"}-${d.displayId}`,
            title: d.title,
            subtitle: d.status,
            archived: d.archived,
          })),
        );

        const notes = await execRows<{ id: string; kind: string; title: string | null; body: string | null }>(
          x,
          sql`SELECT id, kind, title, body
              FROM ${t.activities}
              WHERE workspace_id = ${ws} AND kind IN ('note', 'call', 'email', 'meeting')
                AND lower(coalesce(body, '') || ' ' || coalesce(title, '')) LIKE ${q}
              ORDER BY created_at DESC LIMIT ${Math.min(limit, 10)}`,
        );
        hits.push(
          ...notes.map((n) => ({
            entityType: "activity" as const,
            id: n.id,
            ref: null,
            title: n.title ?? (n.body ?? "").slice(0, 80),
            subtitle: n.kind,
            archived: false,
          })),
        );

        return hits.slice(0, limit * 4);
      });
    },
  };

  // --- maintenance -----------------------------------------------------------------

  const maintenancePort: AsyncPort<Ports["maintenance"]> = {
    async backup() {
      // Hosted physical backups run only through private operational
      // credentials — never a web/API/MCP surface (isolation doc §backup).
      throw new OpError(
        "forbidden",
        "Database backups for hosted PostgreSQL are managed by the operator and are not available from the application.",
      );
    },
    async counts() {
      return run(async (x) => {
        const one = async (table: typeof t.companies | typeof t.people | typeof t.engagements | typeof t.deals, extra?: SQL): Promise<number> => {
          const conds: SQL[] = [
            eq(table.workspaceId, ws) as unknown as SQL,
            isNull(table.archivedAt) as unknown as SQL,
          ];
          if (extra) conds.push(extra);
          const [row] = await x.select({ n: count() }).from(table).where(and(...conds));
          return row?.n ?? 0;
        };
        return {
          companies: await one(t.companies),
          people: await one(t.people),
          engagements: await one(t.engagements),
          deals: await one(t.deals),
          openDeals: await one(t.deals, eq(t.deals.status, "open") as unknown as SQL),
        };
      });
    },
  };

  // --- transactions -------------------------------------------------------------------

  // TS cannot relate T to Awaited<T> for an unconstrained generic across the
  // run() boundary; the runtime shape is exactly the declared surface.
  const tx = ((fn: () => unknown) => run(async () => await fn())) as PgPorts["tx"];

  return {
    workspace: workspacePort,
    users: usersPort,
    credentials: credentialsPort,
    companies: companiesPort,
    people: peoplePort,
    pipelines: pipelinesPort,
    engagements: engagementsPort,
    deals: dealsPort,
    offerings: offeringsPort,
    activities: activitiesPort,
    tags: tagsPort,
    lists: listsPort,
    customFields: customFieldsPort,
    savedViews: savedViewsPort,
    pendingActions: pendingPort,
    audit: auditPort,
    mcpClients: mcpClientsPort,
    search: searchPort,
    maintenance: maintenancePort,
    tx,
  };
}
