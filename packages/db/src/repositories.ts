/**
 * Port implementations (Drizzle + better-sqlite3), constructed per request and
 * scoped to one workspace. The port contract is async (Promise-returning) —
 * see packages/core/src/ports.ts — but this adapter fulfils it with purely
 * synchronous better-sqlite3 work inside async-signature methods. Do not add
 * real awaits (network I/O, timers) inside these methods: the transaction
 * helper at the bottom of this file relies on every port call completing its
 * database work synchronously.
 */
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  type UserStatus,
  type Workspace,
  type WorkspaceSettings,
} from "@emcp/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { endUserSessions, issueAuthCode, removeOpenAuthCredential, invalidateSubjectRefreshTokens } from "./openauth.ts";

type Row<T> = T extends { $inferSelect: infer R } ? R : never;

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bool(v: number | boolean): boolean {
  return v === 1 || v === true;
}

/**
 * One promise-chain lock per SQLite connection: serializes top-level
 * transactions across all Ports instances sharing that connection.
 * See the transaction section at the bottom of createPorts.
 */
const txLock = new WeakMap<object, Promise<void>>();

// ---------------------------------------------------------------------------
// Row mappers
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
  archivedAt: r.archivedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
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
  archivedAt: r.archivedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
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
  archivedAt: r.archivedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  lastActivityAt: r.lastActivityAt,
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
  closedAt: r.closedAt,
  archivedAt: r.archivedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  lastActivityAt: r.lastActivityAt,
});

const mapOffering = (r: Row<typeof t.offerings>): Offering => ({
  id: r.id,
  name: r.name,
  type: r.type as Offering["type"],
  description: r.description,
  active: bool(r.active),
  ownerUserId: r.ownerUserId,
  archivedAt: r.archivedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
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
  completedAt: r.completedAt,
  actorType: r.actorType as Activity["actorType"],
  actorUserId: r.actorUserId,
  actorClientId: r.actorClientId,
  meta: json(r.meta, null),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
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
  createdAt: r.createdAt,
});

const mapList = (r: Row<typeof t.lists>): ContactList => ({
  id: r.id,
  name: r.name,
  description: r.description,
  color: r.color as SemanticColor,
  entityType: (r.entityType as ListableType | null) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const mapCfd = (r: Row<typeof t.customFieldDefs>): CustomFieldDef => ({
  id: r.id,
  entityType: r.entityType as CustomFieldEntity,
  key: r.key,
  label: r.label,
  type: r.type as CustomFieldDef["type"],
  options: json<string[] | null>(r.options, null),
  required: bool(r.required),
  position: r.position,
  archivedAt: r.archivedAt,
});

const mapPending = (r: Row<typeof t.pendingActions>): PendingAction => ({
  id: r.id,
  operation: r.operation,
  input: json(r.input, {}),
  preview: json(r.preview, null),
  riskCategory: r.riskCategory,
  status: r.status as PendingStatus,
  requestedByType: r.requestedByType as PendingAction["requestedByType"],
  requestedByUserId: r.requestedByUserId,
  requestedByClientId: r.requestedByClientId,
  requestedAt: r.requestedAt,
  reviewedByUserId: r.reviewedByUserId,
  reviewedAt: r.reviewedAt,
  reviewNote: r.reviewNote,
  result: json(r.result, null),
  expiresAt: r.expiresAt,
});

const mapAudit = (r: Row<typeof t.auditEvents>): AuditEvent => ({
  id: r.id,
  operation: r.operation,
  entityType: r.entityType,
  entityId: r.entityId,
  summary: r.summary,
  meta: json(r.meta, null),
  actorType: r.actorType as AuditEvent["actorType"],
  actorUserId: r.actorUserId,
  actorClientId: r.actorClientId,
  surface: r.surface as AuditEvent["surface"],
  createdAt: r.createdAt,
});

const mapMcpClient = (r: Row<typeof t.mcpClients>): McpClient => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.tokenPrefix,
  scopes: json<McpScope[]>(r.scopes, []),
  trust: r.trust as TrustProfile,
  createdByUserId: r.createdByUserId,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

const mapUser = (r: Row<typeof t.users>, role: Role): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role,
  status: r.status as UserStatus,
  // Pre-OpenAuth column; a bound auth subject means a live OpenAuth credential.
  hasPassword: r.passwordHash != null || r.authSubject != null,
  disabledAt: r.disabledAt,
  createdAt: r.createdAt,
});

// ---------------------------------------------------------------------------

export function createPorts(db: Db, workspaceId: string): Ports {
  const ws = workspaceId;
  const sqlite = db.$client;

  const nextDisplayId = (entity: string): number => {
    const row = sqlite
      .prepare(
        `INSERT INTO workspace_counters (workspace_id, entity, next_value) VALUES (?, ?, 1)
         ON CONFLICT(workspace_id, entity) DO UPDATE SET next_value = next_value + 1
         RETURNING next_value`,
      )
      .get(ws, entity) as { next_value: number };
    return row.next_value;
  };

  const cutoffIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

  const settings = (): WorkspaceSettings => {
    const row = db.select().from(t.workspaces).where(eq(t.workspaces.id, ws)).get();
    return row ? { ...DEFAULT_WORKSPACE_SETTINGS, ...json<Partial<WorkspaceSettings>>(row.settings, {}) } : DEFAULT_WORKSPACE_SETTINGS;
  };

  /** Batched id→name lookups used to denormalize list rows. */
  const companyNames = (ids: Array<string | null>): Map<string, string> => {
    const wanted = [...new Set(ids.filter((x): x is string => x != null))];
    if (wanted.length === 0) return new Map();
    const rows = db
      .select({ id: t.companies.id, name: t.companies.name })
      .from(t.companies)
      .where(and(eq(t.companies.workspaceId, ws), inArray(t.companies.id, wanted)))
      .all();
    return new Map(rows.map((r) => [r.id, r.name]));
  };

  const personNames = (ids: Array<string | null>): Map<string, string> => {
    const wanted = [...new Set(ids.filter((x): x is string => x != null))];
    if (wanted.length === 0) return new Map();
    const rows = db
      .select({ id: t.people.id, name: t.people.name })
      .from(t.people)
      .where(and(eq(t.people.workspaceId, ws), inArray(t.people.id, wanted)))
      .all();
    return new Map(rows.map((r) => [r.id, r.name]));
  };

  /** ANY-semantics tag condition via EXISTS. */
  const tagCondition = (entityType: TaggableType, entityIdCol: SQL, tagIds: string[]): SQL =>
    sql`EXISTS (SELECT 1 FROM taggings tg WHERE tg.entity_type = ${entityType} AND tg.entity_id = ${entityIdCol} AND tg.tag_id IN (${sql.join(
      tagIds.map((id) => sql`${id}`),
      sql`, `,
    )}))`;

  /** Contact-list membership condition via EXISTS. */
  const listCondition = (entityType: ListableType, entityIdCol: SQL, listId: string): SQL =>
    sql`EXISTS (SELECT 1 FROM list_members lm WHERE lm.entity_type = ${entityType} AND lm.entity_id = ${entityIdCol} AND lm.list_id = ${listId})`;

  const likeAll = (q: string, cols: SQL[]): SQL => {
    const pattern = `%${q.trim().toLowerCase()}%`;
    const conds = cols.map((c) => sql`lower(coalesce(${c}, '')) LIKE ${pattern}`);
    return sql`(${sql.join(conds, sql` OR `)})`;
  };

  // --- workspace --------------------------------------------------------

  const workspacePort: Ports["workspace"] = {
    async get() {
      const row = db.select().from(t.workspaces).where(eq(t.workspaces.id, ws)).get();
      if (!row) throw new OpError("internal", `Workspace ${ws} missing`);
      return {
        id: row.id,
        name: row.name,
        defaultCurrency: row.defaultCurrency,
        timezone: row.timezone,
        settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...json<Partial<WorkspaceSettings>>(row.settings, {}) },
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
    async update(patch) {
      const current = await this.get();
      db.update(t.workspaces)
        .set({
          name: patch.name ?? current.name,
          defaultCurrency: patch.defaultCurrency ?? current.defaultCurrency,
          timezone: patch.timezone ?? current.timezone,
          settings: JSON.stringify(patch.settings ?? current.settings),
          updatedAt: nowIso(),
        })
        .where(eq(t.workspaces.id, ws))
        .run();
      return this.get();
    },
  };

  // --- users -------------------------------------------------------------

  const roleOf = (userId: string): Role => {
    const m = db
      .select()
      .from(t.memberships)
      .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, userId)))
      .get();
    return (m?.role ?? "member") as Role;
  };

  const usersPort: Ports["users"] = {
    async list() {
      const rows = db
        .select({ user: t.users, role: t.memberships.role })
        .from(t.memberships)
        .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
        .where(eq(t.memberships.workspaceId, ws))
        .orderBy(asc(t.users.createdAt))
        .all();
      return rows.map((r) => mapUser(r.user, r.role as Role));
    },
    async get(id) {
      const row = db.select().from(t.users).where(eq(t.users.id, id)).get();
      return row ? mapUser(row, roleOf(id)) : null;
    },
    async getByEmail(email) {
      const row = db.select().from(t.users).where(eq(t.users.email, email.toLowerCase())).get();
      if (!row) return null;
      return { ...mapUser(row, roleOf(row.id)), passwordHash: row.passwordHash };
    },
    async create(input) {
      const id = newId();
      const now = nowIso();
      db.insert(t.users)
        .values({
          id,
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: input.passwordHash,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(t.memberships).values({ id: newId(), workspaceId: ws, userId: id, role: input.role, createdAt: now }).run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      const now = nowIso();
      if (patch.name !== undefined || patch.disabledAt !== undefined) {
        const current = patch.disabledAt !== undefined ? db.select().from(t.users).where(eq(t.users.id, id)).get() : null;
        db.update(t.users)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.disabledAt !== undefined
              ? {
                  disabledAt: patch.disabledAt,
                  // Keep status in lockstep: disabling wins; re-enabling goes
                  // back to active only once an auth subject was ever bound,
                  // otherwise the user is still pending setup.
                  status: patch.disabledAt != null ? "disabled" : current?.authSubject ? "active" : "pending",
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(t.users.id, id))
          .run();
      }
      if (patch.role !== undefined) {
        db.update(t.memberships)
          .set({ role: patch.role })
          .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, id)))
          .run();
      }
      const user = await this.get(id);
      if (!user) throw OpError.notFound("user", id);
      return user;
    },
    async setPassword(id, passwordHash) {
      db.update(t.users).set({ passwordHash, updatedAt: nowIso() }).where(eq(t.users.id, id)).run();
    },
    async count() {
      return db.select({ n: count() }).from(t.users).get()?.n ?? 0;
    },
    async deleteSessions(userId) {
      // Hard delete: a disabled user's sessions (and the OpenAuth refresh
      // tokens behind them) are gone for good — re-enabling the user restores
      // nothing (docs/issues/0022).
      return endUserSessions(db, userId);
    },
    // Creates a `pending` user + membership (no credential); email must be free; role may not be owner.
    async createPending(input) {
      const email = input.email.trim().toLowerCase();
      if (input.role === "owner") {
        throw OpError.validation("A pending user cannot be created as owner — transfer ownership after activation");
      }
      if (db.select().from(t.users).where(eq(t.users.email, email)).get()) {
        throw new OpError("conflict", `A user with email ${email} already exists`);
      }
      const id = newId();
      const now = nowIso();
      return tx(async () => {
        db.insert(t.users)
          .values({ id, email, name: input.name, passwordHash: null, status: "pending", createdAt: now, updatedAt: now })
          .run();
        db.insert(t.memberships).values({ id: newId(), workspaceId: ws, userId: id, role: input.role, createdAt: now }).run();
        return { userId: id };
      });
    },
    // Permanent deletion cascade (docs/issues/0022): user, credentials/subject
    // link, sessions, memberships, MCP clients, private saved views; business
    // records remain (actors render as "Deleted user"); ownerships/tasks unassigned.
    async deletePermanently(userId) {
      const user = db.select().from(t.users).where(eq(t.users.id, userId)).get();
      if (!user) throw OpError.notFound("user", userId);
      const membership = db.select().from(t.memberships).where(eq(t.memberships.userId, userId)).get();
      if (membership?.role === "owner") {
        throw new OpError("invalid_state", "The workspace owner cannot be deleted — transfer ownership first");
      }
      await tx(async () => {
        endUserSessions(db, userId);
        db.delete(t.mcpClients).where(eq(t.mcpClients.createdByUserId, userId)).run();
        db.delete(t.memberships).where(eq(t.memberships.userId, userId)).run();
        db.delete(t.authCodes).where(eq(t.authCodes.userId, userId)).run();
        // Private saved views go; shared ones survive without an owner.
        db.delete(t.savedViews).where(and(eq(t.savedViews.ownerUserId, userId), eq(t.savedViews.visibility, "private"))).run();
        db.update(t.savedViews).set({ ownerUserId: null }).where(eq(t.savedViews.ownerUserId, userId)).run();
        // Unassign ownerships and task assignments; historical actor ids stay
        // and render as "Deleted user" (no name/email is retained anywhere).
        db.update(t.companies).set({ ownerUserId: null }).where(eq(t.companies.ownerUserId, userId)).run();
        db.update(t.people).set({ ownerUserId: null }).where(eq(t.people.ownerUserId, userId)).run();
        db.update(t.engagements).set({ ownerUserId: null }).where(eq(t.engagements.ownerUserId, userId)).run();
        db.update(t.deals).set({ ownerUserId: null }).where(eq(t.deals.ownerUserId, userId)).run();
        db.update(t.offerings).set({ ownerUserId: null }).where(eq(t.offerings.ownerUserId, userId)).run();
        db.update(t.activities).set({ assigneeUserId: null }).where(eq(t.activities.assigneeUserId, userId)).run();
        // OpenAuth credential + subject binding + refresh tokens.
        await removeOpenAuthCredential(db, user.email);
        if (user.authSubject) await invalidateSubjectRefreshTokens(db, user.authSubject);
        db.delete(t.users).where(eq(t.users.id, userId)).run();
      });
    },
    // Atomic owner transfer: target must be an active same-workspace user;
    // previous owner becomes admin; exactly one owner holds throughout.
    async transferOwnership(fromUserId, toUserId) {
      await tx(async () => {
        const from = db
          .select()
          .from(t.memberships)
          .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, fromUserId)))
          .get();
        if (!from || from.role !== "owner") {
          throw new OpError("invalid_state", "Ownership can only be transferred from the current owner");
        }
        const to = db
          .select()
          .from(t.memberships)
          .where(and(eq(t.memberships.workspaceId, ws), eq(t.memberships.userId, toUserId)))
          .get();
        if (!to) throw OpError.notFound("user", toUserId);
        const target = db.select().from(t.users).where(eq(t.users.id, toUserId)).get();
        if (!target || target.status !== "active" || target.disabledAt) {
          throw new OpError("invalid_state", "Ownership can only be transferred to an active user");
        }
        // Demote first so the one-owner-per-workspace unique index holds.
        db.update(t.memberships).set({ role: "admin" }).where(eq(t.memberships.id, from.id)).run();
        db.update(t.memberships).set({ role: "owner" }).where(eq(t.memberships.id, to.id)).run();
      });
    },
  };

  // --- credentials ---------------------------------------------------------

  const credentialsPort: Ports["credentials"] = {
    // Issues a hashed single-use setup/reset code (invalidates prior codes of
    // that purpose; reset also ends the user's sessions). Raw code returned once.
    async issueCode(userId, purpose) {
      const { code } = await issueAuthCode(db, { userId, purpose });
      return { code };
    },
    // Sets/clears password_must_change; the op layer refuses everything except
    // password change/logout/whoami while set (password_change_required).
    async mustChangePassword(userId, flag) {
      const changed = db
        .update(t.users)
        .set({ passwordMustChange: flag ? 1 : 0, updatedAt: nowIso() })
        .where(eq(t.users.id, userId))
        .run().changes;
      if (changed === 0) throw OpError.notFound("user", userId);
    },
  };

  // --- companies ----------------------------------------------------------

  const companiesPort: Ports["companies"] = {
    async list(filter: CompanyFilter) {
      const conds: SQL[] = [eq(t.companies.workspaceId, ws) as unknown as SQL];
      if (!filter.includeArchived) conds.push(isNull(t.companies.archivedAt) as unknown as SQL);
      if (filter.ownerUserId) conds.push(eq(t.companies.ownerUserId, filter.ownerUserId) as unknown as SQL);
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
      const total = db.select({ n: count() }).from(t.companies).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(t.companies)
        .where(where)
        .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      const memberOf = await listsPort.forEntities("company", rows.map((r) => r.id));
      return { items: rows.map((r) => ({ ...mapCompany(r), lists: memberOf[r.id] ?? [] })), total };
    },
    async get(id) {
      const row = db
        .select()
        .from(t.companies)
        .where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, id)))
        .get();
      return row ? mapCompany(row) : null;
    },
    async getByName(name) {
      const row = db
        .select()
        .from(t.companies)
        .where(and(eq(t.companies.workspaceId, ws), sql`lower(${t.companies.name}) = ${name.trim().toLowerCase()}`))
        .get();
      return row ? mapCompany(row) : null;
    },
    async create(input) {
      const id = input.id ?? newId();
      const now = nowIso();
      db.insert(t.companies)
        .values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? nextDisplayId("company"),
          name: input.name,
          domain: input.domain ?? null,
          website: input.website ?? null,
          linkedin: input.linkedin ?? null,
          industry: input.industry ?? null,
          hq: input.hq ?? null,
          country: input.country ?? null,
          description: input.description ?? null,
          ownerUserId: input.ownerUserId ?? null,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.companies)
        .set({
          ...(patch as Record<string, unknown>),
          version: sql`${t.companies.version} + 1`,
          updatedAt: nowIso(),
        })
        .where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("company", id);
      return row;
    },
    async setArchived(id, archived) {
      return this.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      db.delete(t.companyPeople).where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, id))).run();
      db.delete(t.taggings).where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, "company"), eq(t.taggings.entityId, id))).run();
      db.delete(t.customFieldValues)
        .where(and(eq(t.customFieldValues.workspaceId, ws), eq(t.customFieldValues.entityType, "company"), eq(t.customFieldValues.entityId, id)))
        .run();
      db.update(t.engagements).set({ companyId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.companyId, id))).run();
      db.update(t.deals).set({ companyId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.companyId, id))).run();
      db.update(t.activities).set({ companyId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.companyId, id))).run();
      db.delete(t.companies).where(and(eq(t.companies.workspaceId, ws), eq(t.companies.id, id))).run();
    },
    async people(companyId) {
      const rows = db
        .select({ link: t.companyPeople, person: t.people })
        .from(t.companyPeople)
        .innerJoin(t.people, eq(t.people.id, t.companyPeople.personId))
        .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, companyId)))
        .orderBy(desc(t.companyPeople.isPrimary), asc(t.people.name))
        .all();
      return rows.map((r) => ({
        id: r.link.id,
        companyId: r.link.companyId,
        personId: r.link.personId,
        roleTitle: r.link.roleTitle,
        isPrimary: bool(r.link.isPrimary),
        status: r.link.status as CompanyPersonLink["status"],
        createdAt: r.link.createdAt,
        person: mapPerson(r.person),
      }));
    },
  };

  // --- people --------------------------------------------------------------

  const peoplePort: Ports["people"] = {
    async list(filter: PersonFilter) {
      const conds: SQL[] = [eq(t.people.workspaceId, ws) as unknown as SQL];
      if (!filter.includeArchived) conds.push(isNull(t.people.archivedAt) as unknown as SQL);
      if (filter.ownerUserId) conds.push(eq(t.people.ownerUserId, filter.ownerUserId) as unknown as SQL);
      if (filter.country) conds.push(eq(t.people.country, filter.country) as unknown as SQL);
      if (filter.companyId) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM company_people cp WHERE cp.person_id = ${t.people.id} AND cp.company_id = ${filter.companyId})`,
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
      const total = db.select({ n: count() }).from(t.people).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(t.people)
        .where(where)
        .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      const items = rows.map(mapPerson);
      const primaryCompany = new Map<string, string>();
      if (items.length > 0) {
        const links = db
          .select({ personId: t.companyPeople.personId, companyId: t.companyPeople.companyId, isPrimary: t.companyPeople.isPrimary })
          .from(t.companyPeople)
          .where(and(eq(t.companyPeople.workspaceId, ws), inArray(t.companyPeople.personId, items.map((p) => p.id))))
          .all();
        const cNames = companyNames(links.map((l) => l.companyId));
        for (const link of links) {
          // Prefer the primary link; otherwise first seen wins.
          if (!primaryCompany.has(link.personId) || bool(link.isPrimary)) {
            const name = cNames.get(link.companyId);
            if (name) primaryCompany.set(link.personId, name);
          }
        }
      }
      const memberOf = await listsPort.forEntities("person", items.map((p) => p.id));
      return {
        items: items.map((p) => ({ ...p, primaryCompanyName: primaryCompany.get(p.id) ?? null, lists: memberOf[p.id] ?? [] })),
        total,
      };
    },
    async get(id) {
      const row = db
        .select()
        .from(t.people)
        .where(and(eq(t.people.workspaceId, ws), eq(t.people.id, id)))
        .get();
      return row ? mapPerson(row) : null;
    },
    async create(input) {
      const id = input.id ?? newId();
      const now = nowIso();
      db.insert(t.people)
        .values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? nextDisplayId("person"),
          name: input.name,
          title: input.title ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          linkedin: input.linkedin ?? null,
          location: input.location ?? null,
          country: input.country ?? null,
          ownerUserId: input.ownerUserId ?? null,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.people)
        .set({ ...(patch as Record<string, unknown>), version: sql`${t.people.version} + 1`, updatedAt: nowIso() })
        .where(and(eq(t.people.workspaceId, ws), eq(t.people.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("person", id);
      return row;
    },
    async setArchived(id, archived) {
      return this.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      db.delete(t.companyPeople).where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, id))).run();
      db.delete(t.taggings).where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, "person"), eq(t.taggings.entityId, id))).run();
      db.delete(t.customFieldValues)
        .where(and(eq(t.customFieldValues.workspaceId, ws), eq(t.customFieldValues.entityType, "person"), eq(t.customFieldValues.entityId, id)))
        .run();
      db.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.personId, id))).run();
      db.update(t.engagements).set({ personId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.personId, id))).run();
      db.update(t.deals).set({ primaryPersonId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.primaryPersonId, id))).run();
      db.update(t.activities).set({ personId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.personId, id))).run();
      db.delete(t.people).where(and(eq(t.people.workspaceId, ws), eq(t.people.id, id))).run();
    },
    async companies(personId) {
      const rows = db
        .select({ link: t.companyPeople, company: t.companies })
        .from(t.companyPeople)
        .innerJoin(t.companies, eq(t.companies.id, t.companyPeople.companyId))
        .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, personId)))
        .orderBy(desc(t.companyPeople.isPrimary))
        .all();
      return rows.map((r) => ({
        id: r.link.id,
        companyId: r.link.companyId,
        personId: r.link.personId,
        roleTitle: r.link.roleTitle,
        isPrimary: bool(r.link.isPrimary),
        status: r.link.status as CompanyPersonLink["status"],
        createdAt: r.link.createdAt,
        company: mapCompany(r.company),
      }));
    },
    async link(input) {
      const existing = db
        .select()
        .from(t.companyPeople)
        .where(and(eq(t.companyPeople.companyId, input.companyId), eq(t.companyPeople.personId, input.personId)))
        .get();
      const now = nowIso();
      if (input.isPrimary) {
        // Only one primary company per person.
        db.update(t.companyPeople)
          .set({ isPrimary: 0 })
          .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.personId, input.personId)))
          .run();
      }
      if (existing) {
        db.update(t.companyPeople)
          .set({
            roleTitle: input.roleTitle ?? existing.roleTitle,
            isPrimary: input.isPrimary ? 1 : existing.isPrimary,
            status: input.status ?? existing.status,
          })
          .where(eq(t.companyPeople.id, existing.id))
          .run();
        const updated = db.select().from(t.companyPeople).where(eq(t.companyPeople.id, existing.id)).get()!;
        return {
          id: updated.id,
          companyId: updated.companyId,
          personId: updated.personId,
          roleTitle: updated.roleTitle,
          isPrimary: bool(updated.isPrimary),
          status: updated.status as CompanyPersonLink["status"],
          createdAt: updated.createdAt,
        };
      }
      const id = newId();
      db.insert(t.companyPeople)
        .values({
          id,
          workspaceId: ws,
          companyId: input.companyId,
          personId: input.personId,
          roleTitle: input.roleTitle ?? null,
          isPrimary: input.isPrimary ? 1 : 0,
          status: input.status ?? "current",
          createdAt: now,
        })
        .run();
      return {
        id,
        companyId: input.companyId,
        personId: input.personId,
        roleTitle: input.roleTitle ?? null,
        isPrimary: input.isPrimary ?? false,
        status: input.status ?? "current",
        createdAt: now,
      };
    },
    async unlink(companyId, personId) {
      db.delete(t.companyPeople)
        .where(and(eq(t.companyPeople.workspaceId, ws), eq(t.companyPeople.companyId, companyId), eq(t.companyPeople.personId, personId)))
        .run();
    },
  };

  // --- pipelines -------------------------------------------------------------

  const pipelinesPort: Ports["pipelines"] = {
    async list(type?: PipelineType) {
      const conds = [eq(t.pipelines.workspaceId, ws)];
      if (type) conds.push(eq(t.pipelines.type, type));
      const rows = db
        .select()
        .from(t.pipelines)
        .where(and(...conds))
        .orderBy(asc(t.pipelines.position), asc(t.pipelines.createdAt))
        .all();
      return rows.map((p) => ({
        id: p.id,
        type: p.type as PipelineType,
        name: p.name,
        isDefault: bool(p.isDefault),
        position: p.position,
        stages: db
          .select()
          .from(t.stages)
          .where(eq(t.stages.pipelineId, p.id))
          .orderBy(asc(t.stages.position))
          .all()
          .map(mapStage),
      }));
    },
    async get(id) {
      return (await this.list()).find((p) => p.id === id) ?? null;
    },
    async getDefault(type) {
      const all = await this.list(type);
      return all.find((p) => p.isDefault) ?? all[0] ?? null;
    },
    async getStage(stageId) {
      const row = db
        .select()
        .from(t.stages)
        .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, stageId)))
        .get();
      return row ? mapStage(row) : null;
    },
    async create(input) {
      const id = newId();
      const now = nowIso();
      if (input.isDefault) {
        db.update(t.pipelines).set({ isDefault: 0 }).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, input.type))).run();
      }
      const maxPos =
        db
          .select({ n: sql<number>`COALESCE(MAX(${t.pipelines.position}), -1)` })
          .from(t.pipelines)
          .where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, input.type)))
          .get()?.n ?? -1;
      db.insert(t.pipelines)
        .values({ id, workspaceId: ws, type: input.type, name: input.name, isDefault: input.isDefault ? 1 : 0, position: maxPos + 1, createdAt: now })
        .run();
      input.stages.forEach((s, i) => {
        db.insert(t.stages)
          .values({
            id: newId(),
            workspaceId: ws,
            pipelineId: id,
            name: s.name,
            color: s.color,
            position: i,
            probability: s.probability ?? null,
            outcome: s.outcome ?? null,
          })
          .run();
      });
      return (await this.get(id))!;
    },
    async rename(id, name) {
      db.update(t.pipelines).set({ name }).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.id, id))).run();
      return (await this.get(id))!;
    },
    async setDefault(id) {
      const pipeline = await this.get(id);
      if (!pipeline) throw OpError.notFound("pipeline", id);
      db.update(t.pipelines).set({ isDefault: 0 }).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.type, pipeline.type))).run();
      db.update(t.pipelines).set({ isDefault: 1 }).where(eq(t.pipelines.id, id)).run();
    },
    async delete(id) {
      db.delete(t.stages).where(and(eq(t.stages.workspaceId, ws), eq(t.stages.pipelineId, id))).run();
      db.delete(t.pipelines).where(and(eq(t.pipelines.workspaceId, ws), eq(t.pipelines.id, id))).run();
    },
    async addStage(pipelineId, input) {
      const id = newId();
      const maxPos =
        db
          .select({ n: sql<number>`COALESCE(MAX(${t.stages.position}), -1)` })
          .from(t.stages)
          .where(eq(t.stages.pipelineId, pipelineId))
          .get()?.n ?? -1;
      db.insert(t.stages)
        .values({
          id,
          workspaceId: ws,
          pipelineId,
          name: input.name,
          color: input.color,
          position: maxPos + 1,
          probability: input.probability ?? null,
          outcome: input.outcome ?? null,
        })
        .run();
      return (await this.getStage(id))!;
    },
    async updateStage(stageId, patch) {
      db.update(t.stages)
        .set(patch as Record<string, unknown>)
        .where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, stageId)))
        .run();
      const s = await this.getStage(stageId);
      if (!s) throw OpError.notFound("stage", stageId);
      return s;
    },
    async reorderStages(pipelineId, stageIds) {
      stageIds.forEach((sid, i) => {
        db.update(t.stages)
          .set({ position: i })
          .where(and(eq(t.stages.pipelineId, pipelineId), eq(t.stages.id, sid)))
          .run();
      });
    },
    async deleteStage(stageId) {
      db.delete(t.stages).where(and(eq(t.stages.workspaceId, ws), eq(t.stages.id, stageId))).run();
    },
    async stageUsage(stageId) {
      const e = db.select({ n: count() }).from(t.engagements).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.stageId, stageId))).get()?.n ?? 0;
      const d = db.select({ n: count() }).from(t.deals).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.stageId, stageId))).get()?.n ?? 0;
      return e + d;
    },
    async pipelineUsage(pipelineId) {
      const e =
        db.select({ n: count() }).from(t.engagements).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.pipelineId, pipelineId))).get()?.n ?? 0;
      const d = db.select({ n: count() }).from(t.deals).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.pipelineId, pipelineId))).get()?.n ?? 0;
      return e + d;
    },
  };

  // --- engagements -------------------------------------------------------------

  const engagementsPort: Ports["engagements"] = {
    async list(filter: EngagementFilter) {
      const conds: SQL[] = [eq(t.engagements.workspaceId, ws) as unknown as SQL];
      if (!filter.includeArchived) conds.push(isNull(t.engagements.archivedAt) as unknown as SQL);
      if (filter.pipelineId) conds.push(eq(t.engagements.pipelineId, filter.pipelineId) as unknown as SQL);
      if (filter.stageId) conds.push(eq(t.engagements.stageId, filter.stageId) as unknown as SQL);
      if (filter.companyId) conds.push(eq(t.engagements.companyId, filter.companyId) as unknown as SQL);
      if (filter.personId) conds.push(eq(t.engagements.personId, filter.personId) as unknown as SQL);
      if (filter.ownerUserId) conds.push(eq(t.engagements.ownerUserId, filter.ownerUserId) as unknown as SQL);
      if (filter.channel) conds.push(eq(t.engagements.channel, filter.channel) as unknown as SQL);
      if (filter.stale) {
        const cutoff = cutoffIso(settings().staleEngagementDays);
        conds.push(sql`COALESCE(${t.engagements.lastActivityAt}, ${t.engagements.createdAt}) < ${cutoff}`);
        // Stale only matters for non-terminal stages.
        conds.push(
          sql`EXISTS (SELECT 1 FROM stages s WHERE s.id = ${t.engagements.stageId} AND s.outcome IS NULL)`,
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
      if (filter.offeringId) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM offering_links ol WHERE ol.entity_type = 'engagement' AND ol.entity_id = ${t.engagements.id} AND ol.offering_id = ${filter.offeringId})`,
        );
      }

      const where = and(...conds);
      const sortCol = {
        displayId: t.engagements.displayId,
        title: t.engagements.title,
        createdAt: t.engagements.createdAt,
        updatedAt: t.engagements.updatedAt,
        lastActivityAt: t.engagements.lastActivityAt,
        nextActionDue: t.engagements.nextActionDue,
      }[filter.sort];
      const total = db.select({ n: count() }).from(t.engagements).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(t.engagements)
        .where(where)
        .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      const items = rows.map(mapEngagement);
      const cNames = companyNames(items.map((e) => e.companyId));
      const pNames = personNames(items.map((e) => e.personId));
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
        total,
      };
    },
    async get(id) {
      const row = db
        .select()
        .from(t.engagements)
        .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, id)))
        .get();
      return row ? mapEngagement(row) : null;
    },
    async create(input) {
      const id = input.id ?? newId();
      const now = nowIso();
      db.insert(t.engagements)
        .values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? nextDisplayId("engagement"),
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
          createdAt: input.createdAt ?? now,
          updatedAt: now,
          lastActivityAt: input.lastActivityAt ?? null,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.engagements)
        .set({ ...(patch as Record<string, unknown>), version: sql`${t.engagements.version} + 1`, updatedAt: nowIso() })
        .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("engagement", id);
      return row;
    },
    async setArchived(id, archived) {
      return this.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      db.delete(t.taggings).where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, "engagement"), eq(t.taggings.entityId, id))).run();
      db.delete(t.customFieldValues)
        .where(
          and(eq(t.customFieldValues.workspaceId, ws), eq(t.customFieldValues.entityType, "engagement"), eq(t.customFieldValues.entityId, id)),
        )
        .run();
      db.delete(t.offeringLinks)
        .where(and(eq(t.offeringLinks.workspaceId, ws), eq(t.offeringLinks.entityType, "engagement"), eq(t.offeringLinks.entityId, id)))
        .run();
      db.delete(t.listMembers)
        .where(and(eq(t.listMembers.workspaceId, ws), eq(t.listMembers.entityType, "engagement"), eq(t.listMembers.entityId, id)))
        .run();
      db.update(t.activities).set({ engagementId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.engagementId, id))).run();
      db.update(t.deals).set({ engagementId: null }).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.engagementId, id))).run();
      db.delete(t.engagements).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, id))).run();
    },
    async countByStage(pipelineId) {
      const rows = db
        .select({ stageId: t.engagements.stageId, n: count() })
        .from(t.engagements)
        .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.pipelineId, pipelineId), isNull(t.engagements.archivedAt)))
        .groupBy(t.engagements.stageId)
        .all();
      return rows.map((r) => ({ stageId: r.stageId, count: r.n }));
    },
  };

  // --- deals ---------------------------------------------------------------

  const dealsPort: Ports["deals"] = {
    async list(filter: DealFilter) {
      const conds: SQL[] = [eq(t.deals.workspaceId, ws) as unknown as SQL];
      if (!filter.includeArchived) conds.push(isNull(t.deals.archivedAt) as unknown as SQL);
      if (filter.pipelineId) conds.push(eq(t.deals.pipelineId, filter.pipelineId) as unknown as SQL);
      if (filter.stageId) conds.push(eq(t.deals.stageId, filter.stageId) as unknown as SQL);
      if (filter.status) conds.push(eq(t.deals.status, filter.status) as unknown as SQL);
      if (filter.companyId) conds.push(eq(t.deals.companyId, filter.companyId) as unknown as SQL);
      if (filter.ownerUserId) conds.push(eq(t.deals.ownerUserId, filter.ownerUserId) as unknown as SQL);
      if (filter.personId) {
        conds.push(
          sql`(${t.deals.primaryPersonId} = ${filter.personId} OR EXISTS (SELECT 1 FROM deal_stakeholders dsh WHERE dsh.deal_id = ${t.deals.id} AND dsh.person_id = ${filter.personId}))`,
        );
      }
      if (filter.stale) {
        const cutoff = cutoffIso(settings().staleDealDays);
        conds.push(sql`COALESCE(${t.deals.lastActivityAt}, ${t.deals.createdAt}) < ${cutoff}`);
      }
      if (filter.search) {
        conds.push(likeAll(filter.search, [sql`${t.deals.title}`, sql`${t.deals.lostReason}`, sql`${t.deals.nextAction}`]));
      }
      if (filter.tagIds?.length) conds.push(tagCondition("deal", sql`${t.deals.id}`, filter.tagIds));
      if (filter.listId) conds.push(listCondition("deal", sql`${t.deals.id}`, filter.listId));
      if (filter.offeringId) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM offering_links ol WHERE ol.entity_type = 'deal' AND ol.entity_id = ${t.deals.id} AND ol.offering_id = ${filter.offeringId})`,
        );
      }

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
      const total = db.select({ n: count() }).from(t.deals).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(t.deals)
        .where(where)
        .orderBy(filter.dir === "asc" ? asc(sortCol) : desc(sortCol))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      const items = rows.map(mapDeal);
      const cNames = companyNames(items.map((d) => d.companyId));
      const pNames = personNames(items.map((d) => d.primaryPersonId));
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
        total,
      };
    },
    async get(id) {
      const row = db
        .select()
        .from(t.deals)
        .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, id)))
        .get();
      return row ? mapDeal(row) : null;
    },
    async create(input) {
      const id = input.id ?? newId();
      const now = nowIso();
      db.insert(t.deals)
        .values({
          id,
          workspaceId: ws,
          displayId: input.displayId ?? nextDisplayId("deal"),
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
          createdAt: input.createdAt ?? now,
          updatedAt: now,
          lastActivityAt: input.lastActivityAt ?? null,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.deals)
        .set({ ...(patch as Record<string, unknown>), version: sql`${t.deals.version} + 1`, updatedAt: nowIso() })
        .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("deal", id);
      return row;
    },
    async setArchived(id, archived) {
      return this.update(id, { archivedAt: archived ? nowIso() : null });
    },
    async hardDelete(id) {
      db.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, id))).run();
      db.delete(t.taggings).where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, "deal"), eq(t.taggings.entityId, id))).run();
      db.delete(t.customFieldValues)
        .where(and(eq(t.customFieldValues.workspaceId, ws), eq(t.customFieldValues.entityType, "deal"), eq(t.customFieldValues.entityId, id)))
        .run();
      db.delete(t.offeringLinks)
        .where(and(eq(t.offeringLinks.workspaceId, ws), eq(t.offeringLinks.entityType, "deal"), eq(t.offeringLinks.entityId, id)))
        .run();
      db.delete(t.listMembers)
        .where(and(eq(t.listMembers.workspaceId, ws), eq(t.listMembers.entityType, "deal"), eq(t.listMembers.entityId, id)))
        .run();
      db.update(t.activities).set({ dealId: null }).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.dealId, id))).run();
      db.update(t.engagements).set({ dealId: null }).where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.dealId, id))).run();
      db.delete(t.deals).where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, id))).run();
    },
    async stakeholders(dealId) {
      const rows = db
        .select({ sh: t.dealStakeholders, person: t.people })
        .from(t.dealStakeholders)
        .innerJoin(t.people, eq(t.people.id, t.dealStakeholders.personId))
        .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, dealId)))
        .orderBy(desc(t.dealStakeholders.isPrimary), asc(t.people.name))
        .all();
      return rows.map((r) => ({
        id: r.sh.id,
        dealId: r.sh.dealId,
        personId: r.sh.personId,
        role: r.sh.role,
        isPrimary: bool(r.sh.isPrimary),
        note: r.sh.note,
        person: mapPerson(r.person),
      }));
    },
    async getStakeholder(id) {
      const r = db
        .select()
        .from(t.dealStakeholders)
        .where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.id, id)))
        .get();
      return r ? { id: r.id, dealId: r.dealId, personId: r.personId, role: r.role, isPrimary: bool(r.isPrimary), note: r.note } : null;
    },
    async addStakeholder(input) {
      const existing = db
        .select()
        .from(t.dealStakeholders)
        .where(and(eq(t.dealStakeholders.dealId, input.dealId), eq(t.dealStakeholders.personId, input.personId)))
        .get();
      if (existing) {
        return this.updateStakeholder(existing.id, { role: input.role, isPrimary: input.isPrimary, note: input.note });
      }
      const id = newId();
      if (input.isPrimary) {
        db.update(t.dealStakeholders).set({ isPrimary: 0 }).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, input.dealId))).run();
      }
      db.insert(t.dealStakeholders)
        .values({
          id,
          workspaceId: ws,
          dealId: input.dealId,
          personId: input.personId,
          role: input.role ?? null,
          isPrimary: input.isPrimary ? 1 : 0,
          note: input.note ?? null,
        })
        .run();
      return (await this.getStakeholder(id))!;
    },
    async updateStakeholder(id, patch) {
      const existing = await this.getStakeholder(id);
      if (!existing) throw OpError.notFound("stakeholder", id);
      if (patch.isPrimary) {
        db.update(t.dealStakeholders).set({ isPrimary: 0 }).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.dealId, existing.dealId))).run();
      }
      db.update(t.dealStakeholders)
        .set({
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary ? 1 : 0 } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        })
        .where(eq(t.dealStakeholders.id, id))
        .run();
      return (await this.getStakeholder(id))!;
    },
    async removeStakeholder(id) {
      db.delete(t.dealStakeholders).where(and(eq(t.dealStakeholders.workspaceId, ws), eq(t.dealStakeholders.id, id))).run();
    },
    async stageStats(pipelineId) {
      const rows = sqlite
        .prepare(
          `SELECT d.stage_id AS stageId, d.currency AS currency, COUNT(*) AS n,
                  SUM(COALESCE(d.amount_minor, 0)) AS total,
                  SUM(COALESCE(d.amount_minor, 0) * COALESCE(d.probability, s.probability, 0) / 100.0) AS weighted
           FROM deals d JOIN stages s ON s.id = d.stage_id
           WHERE d.workspace_id = ? AND d.pipeline_id = ? AND d.archived_at IS NULL
           GROUP BY d.stage_id, d.currency`,
        )
        .all(ws, pipelineId) as Array<{ stageId: string; currency: string; n: number; total: number; weighted: number }>;
      const byStage = new Map<string, { stageId: string; count: number; sums: Record<string, number>; weighted: Record<string, number> }>();
      for (const r of rows) {
        const entry = byStage.get(r.stageId) ?? { stageId: r.stageId, count: 0, sums: {}, weighted: {} };
        entry.count += r.n;
        if (r.total > 0) entry.sums[r.currency] = (entry.sums[r.currency] ?? 0) + r.total;
        if (r.weighted > 0) entry.weighted[r.currency] = (entry.weighted[r.currency] ?? 0) + Math.round(r.weighted);
        byStage.set(r.stageId, entry);
      }
      return [...byStage.values()];
    },
  };

  // --- offerings -------------------------------------------------------------

  const offeringsPort: Ports["offerings"] = {
    async list(includeArchived) {
      const conds = [eq(t.offerings.workspaceId, ws)];
      if (!includeArchived) conds.push(isNull(t.offerings.archivedAt));
      return db
        .select()
        .from(t.offerings)
        .where(and(...conds))
        .orderBy(asc(t.offerings.name))
        .all()
        .map(mapOffering);
    },
    async get(id) {
      const row = db
        .select()
        .from(t.offerings)
        .where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, id)))
        .get();
      return row ? mapOffering(row) : null;
    },
    async create(input) {
      const id = newId();
      const now = nowIso();
      db.insert(t.offerings)
        .values({
          id,
          workspaceId: ws,
          name: input.name,
          type: input.type,
          description: input.description ?? null,
          active: input.active === false ? 0 : 1,
          ownerUserId: input.ownerUserId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      const { active, ...rest } = patch;
      db.update(t.offerings)
        .set({
          ...(rest as Record<string, unknown>),
          ...(active === undefined ? {} : { active: active ? 1 : 0 }),
          version: sql`${t.offerings.version} + 1`,
          updatedAt: nowIso(),
        })
        .where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("offering", id);
      return row;
    },
    async setArchived(id, archived) {
      return this.update(id, { archivedAt: archived ? nowIso() : null } as Partial<Offering>);
    },
    async hardDelete(id) {
      db.delete(t.offeringLinks).where(and(eq(t.offeringLinks.workspaceId, ws), eq(t.offeringLinks.offeringId, id))).run();
      db.delete(t.customFieldValues)
        .where(and(eq(t.customFieldValues.workspaceId, ws), eq(t.customFieldValues.entityType, "offering"), eq(t.customFieldValues.entityId, id)))
        .run();
      db.delete(t.offerings).where(and(eq(t.offerings.workspaceId, ws), eq(t.offerings.id, id))).run();
    },
    async links(entityType, entityId) {
      const rows = db
        .select({ link: t.offeringLinks, offering: t.offerings })
        .from(t.offeringLinks)
        .innerJoin(t.offerings, eq(t.offerings.id, t.offeringLinks.offeringId))
        .where(and(eq(t.offeringLinks.workspaceId, ws), eq(t.offeringLinks.entityType, entityType), eq(t.offeringLinks.entityId, entityId)))
        .all();
      return rows.map((r) => ({
        id: r.link.id,
        offeringId: r.link.offeringId,
        entityType: r.link.entityType as OfferingLink["entityType"],
        entityId: r.link.entityId,
        fit: r.link.fit,
        note: r.link.note,
        isPrimary: bool(r.link.isPrimary),
        offering: mapOffering(r.offering),
      }));
    },
    async linksForOffering(offeringId) {
      return db
        .select()
        .from(t.offeringLinks)
        .where(and(eq(t.offeringLinks.workspaceId, ws), eq(t.offeringLinks.offeringId, offeringId)))
        .all()
        .map((r) => ({
          id: r.id,
          offeringId: r.offeringId,
          entityType: r.entityType as OfferingLink["entityType"],
          entityId: r.entityId,
          fit: r.fit,
          note: r.note,
          isPrimary: bool(r.isPrimary),
        }));
    },
    async linksForEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      const rows = db
        .select({ link: t.offeringLinks, offering: t.offerings })
        .from(t.offeringLinks)
        .innerJoin(t.offerings, eq(t.offerings.id, t.offeringLinks.offeringId))
        .where(
          and(
            eq(t.offeringLinks.workspaceId, ws),
            eq(t.offeringLinks.entityType, entityType),
            inArray(t.offeringLinks.entityId, entityIds),
          ),
        )
        .all();
      const out: Record<string, Array<{ id: string; name: string; isPrimary: boolean }>> = {};
      for (const r of rows) {
        (out[r.link.entityId] ??= []).push({
          id: r.offering.id,
          name: r.offering.name,
          isPrimary: bool(r.link.isPrimary),
        });
      }
      return out;
    },
    async link(input) {
      const existing = db
        .select()
        .from(t.offeringLinks)
        .where(
          and(
            eq(t.offeringLinks.offeringId, input.offeringId),
            eq(t.offeringLinks.entityType, input.entityType),
            eq(t.offeringLinks.entityId, input.entityId),
          ),
        )
        .get();
      if (existing) {
        db.update(t.offeringLinks)
          .set({
            fit: input.fit ?? existing.fit,
            note: input.note ?? existing.note,
            isPrimary: input.isPrimary ? 1 : existing.isPrimary,
          })
          .where(eq(t.offeringLinks.id, existing.id))
          .run();
        const r = db.select().from(t.offeringLinks).where(eq(t.offeringLinks.id, existing.id)).get()!;
        return {
          id: r.id,
          offeringId: r.offeringId,
          entityType: r.entityType as OfferingLink["entityType"],
          entityId: r.entityId,
          fit: r.fit,
          note: r.note,
          isPrimary: bool(r.isPrimary),
        };
      }
      const id = newId();
      db.insert(t.offeringLinks)
        .values({
          id,
          workspaceId: ws,
          offeringId: input.offeringId,
          entityType: input.entityType,
          entityId: input.entityId,
          fit: input.fit ?? null,
          note: input.note ?? null,
          isPrimary: input.isPrimary ? 1 : 0,
        })
        .run();
      return {
        id,
        offeringId: input.offeringId,
        entityType: input.entityType,
        entityId: input.entityId,
        fit: input.fit ?? null,
        note: input.note ?? null,
        isPrimary: input.isPrimary ?? false,
      };
    },
    async unlink(offeringId, entityType, entityId) {
      db.delete(t.offeringLinks)
        .where(
          and(
            eq(t.offeringLinks.workspaceId, ws),
            eq(t.offeringLinks.offeringId, offeringId),
            eq(t.offeringLinks.entityType, entityType),
            eq(t.offeringLinks.entityId, entityId),
          ),
        )
        .run();
    },
  };

  // --- activities ------------------------------------------------------------

  const activitiesPort: Ports["activities"] = {
    async list(filter: ActivityFilter) {
      const conds: SQL[] = [eq(t.activities.workspaceId, ws) as unknown as SQL];
      const kinds = filter.kinds ?? (filter.kind ? [filter.kind] : null);
      if (kinds?.length) conds.push(inArray(t.activities.kind, kinds) as unknown as SQL);
      if (filter.companyId) conds.push(eq(t.activities.companyId, filter.companyId) as unknown as SQL);
      if (filter.personId) conds.push(eq(t.activities.personId, filter.personId) as unknown as SQL);
      if (filter.engagementId) conds.push(eq(t.activities.engagementId, filter.engagementId) as unknown as SQL);
      if (filter.dealId) conds.push(eq(t.activities.dealId, filter.dealId) as unknown as SQL);
      if (filter.actorType) conds.push(eq(t.activities.actorType, filter.actorType) as unknown as SQL);
      if (filter.assigneeUserId) conds.push(eq(t.activities.assigneeUserId, filter.assigneeUserId) as unknown as SQL);
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
      const total = db.select({ n: count() }).from(t.activities).where(where).get()?.n ?? 0;
      const orderBy =
        filter.open || filter.overdue || filter.dueWithinDays !== undefined
          ? [sql`${t.activities.dueAt} IS NULL`, asc(t.activities.dueAt)]
          : [desc(t.activities.createdAt)];
      const rows = db
        .select()
        .from(t.activities)
        .where(where)
        .orderBy(...(orderBy as [SQL]))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      return { items: rows.map(mapActivity), total };
    },
    async get(id) {
      const row = db
        .select()
        .from(t.activities)
        .where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, id)))
        .get();
      return row ? mapActivity(row) : null;
    },
    async create(input, actor: ActorStamp) {
      const id = input.id ?? newId();
      const now = nowIso();
      db.insert(t.activities)
        .values({
          id,
          workspaceId: ws,
          kind: input.kind,
          displayId: input.kind === "task" ? nextDisplayId("task") : null,
          title: input.title ?? null,
          body: input.body ?? null,
          companyId: input.companyId ?? null,
          personId: input.personId ?? null,
          engagementId: input.engagementId ?? null,
          dealId: input.dealId ?? null,
          dueAt: input.dueAt ?? null,
          assigneeUserId: input.assigneeUserId ?? null,
          completedAt: input.completedAt ?? null,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId,
          actorClientId: actor.actorClientId,
          meta: input.meta ? JSON.stringify(input.meta) : null,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      const { meta, ...rest } = patch;
      db.update(t.activities)
        .set({
          ...(rest as Record<string, unknown>),
          ...(meta === undefined ? {} : { meta: meta ? JSON.stringify(meta) : null }),
          updatedAt: nowIso(),
        })
        .where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("activity", id);
      return row;
    },
    async hardDelete(id) {
      db.delete(t.activities).where(and(eq(t.activities.workspaceId, ws), eq(t.activities.id, id))).run();
    },
    async touchLinked(activity, at) {
      if (activity.engagementId) {
        db.update(t.engagements)
          .set({ lastActivityAt: at })
          .where(and(eq(t.engagements.workspaceId, ws), eq(t.engagements.id, activity.engagementId)))
          .run();
      }
      if (activity.dealId) {
        db.update(t.deals)
          .set({ lastActivityAt: at })
          .where(and(eq(t.deals.workspaceId, ws), eq(t.deals.id, activity.dealId)))
          .run();
      }
    },
  };

  // --- tags --------------------------------------------------------------------

  const tagsPort: Ports["tags"] = {
    async list() {
      const rows = db.select().from(t.tags).where(eq(t.tags.workspaceId, ws)).orderBy(asc(t.tags.name)).all();
      const usage = sqlite
        .prepare(`SELECT tag_id AS tagId, COUNT(*) AS n FROM taggings WHERE workspace_id = ? GROUP BY tag_id`)
        .all(ws) as Array<{ tagId: string; n: number }>;
      const usageMap = new Map(usage.map((u) => [u.tagId, u.n]));
      return rows.map((r) => ({ ...mapTag(r), usage: usageMap.get(r.id) ?? 0 }));
    },
    async get(id) {
      const row = db
        .select()
        .from(t.tags)
        .where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, id)))
        .get();
      return row ? mapTag(row) : null;
    },
    async getByName(name) {
      const row = db
        .select()
        .from(t.tags)
        .where(and(eq(t.tags.workspaceId, ws), sql`lower(${t.tags.name}) = ${name.trim().toLowerCase()}`))
        .get();
      return row ? mapTag(row) : null;
    },
    async create(input) {
      const id = newId();
      db.insert(t.tags).values({ id, workspaceId: ws, name: input.name, color: input.color, createdAt: nowIso() }).run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.tags)
        .set(patch as Record<string, unknown>)
        .where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("tag", id);
      return row;
    },
    async delete(id) {
      db.delete(t.taggings).where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.tagId, id))).run();
      db.delete(t.tags).where(and(eq(t.tags.workspaceId, ws), eq(t.tags.id, id))).run();
    },
    async apply(tagId, entityType, entityId) {
      sqlite
        .prepare(
          `INSERT INTO taggings (id, workspace_id, tag_id, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(tag_id, entity_type, entity_id) DO NOTHING`,
        )
        .run(newId(), ws, tagId, entityType, entityId);
    },
    async remove(tagId, entityType, entityId) {
      db.delete(t.taggings)
        .where(
          and(eq(t.taggings.workspaceId, ws), eq(t.taggings.tagId, tagId), eq(t.taggings.entityType, entityType), eq(t.taggings.entityId, entityId)),
        )
        .run();
    },
    async forEntity(entityType, entityId) {
      const rows = db
        .select({ tag: t.tags })
        .from(t.taggings)
        .innerJoin(t.tags, eq(t.tags.id, t.taggings.tagId))
        .where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, entityType), eq(t.taggings.entityId, entityId)))
        .orderBy(asc(t.tags.name))
        .all();
      return rows.map((r) => mapTag(r.tag));
    },
    async forEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      const rows = db
        .select({ tag: t.tags, entityId: t.taggings.entityId })
        .from(t.taggings)
        .innerJoin(t.tags, eq(t.tags.id, t.taggings.tagId))
        .where(and(eq(t.taggings.workspaceId, ws), eq(t.taggings.entityType, entityType), inArray(t.taggings.entityId, entityIds)))
        .all();
      const out: Record<string, Tag[]> = {};
      for (const r of rows) (out[r.entityId] ??= []).push(mapTag(r.tag));
      return out;
    },
  };

  // --- contact lists ------------------------------------------------------

  const listsPort: Ports["lists"] = {
    async list() {
      const rows = db.select().from(t.lists).where(eq(t.lists.workspaceId, ws)).orderBy(asc(t.lists.name)).all();
      const counts = sqlite
        .prepare(`SELECT list_id AS listId, entity_type AS entityType, COUNT(*) AS n FROM list_members WHERE workspace_id = ? GROUP BY list_id, entity_type`)
        .all(ws) as Array<{ listId: string; entityType: string; n: number }>;
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
    },
    async get(id) {
      const row = db
        .select()
        .from(t.lists)
        .where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, id)))
        .get();
      return row ? mapList(row) : null;
    },
    async getByName(name) {
      const row = db
        .select()
        .from(t.lists)
        .where(and(eq(t.lists.workspaceId, ws), sql`lower(${t.lists.name}) = ${name.trim().toLowerCase()}`))
        .get();
      return row ? mapList(row) : null;
    },
    async create(input) {
      const id = newId();
      const now = nowIso();
      db.insert(t.lists)
        .values({
          id,
          workspaceId: ws,
          name: input.name,
          description: input.description ?? null,
          color: input.color,
          entityType: input.entityType ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.lists)
        .set({ ...(patch as Record<string, unknown>), updatedAt: nowIso() })
        .where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, id)))
        .run();
      const row = await this.get(id);
      if (!row) throw OpError.notFound("list", id);
      return row;
    },
    async delete(id) {
      db.delete(t.listMembers).where(and(eq(t.listMembers.workspaceId, ws), eq(t.listMembers.listId, id))).run();
      db.delete(t.lists).where(and(eq(t.lists.workspaceId, ws), eq(t.lists.id, id))).run();
    },
    async memberTypeCounts(listId) {
      const rows = sqlite
        .prepare(`SELECT entity_type AS entityType, COUNT(*) AS n FROM list_members WHERE workspace_id = ? AND list_id = ? GROUP BY entity_type`)
        .all(ws, listId) as Array<{ entityType: string; n: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.entityType] = r.n;
      return out;
    },
    async addMembers(listId, entityType, entityIds) {
      const stmt = sqlite.prepare(
        `INSERT INTO list_members (id, workspace_id, list_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(list_id, entity_type, entity_id) DO NOTHING`,
      );
      const now = nowIso();
      let added = 0;
      for (const entityId of entityIds) {
        added += stmt.run(newId(), ws, listId, entityType, entityId, now).changes;
      }
      return added;
    },
    async removeMembers(listId, entityType, entityIds) {
      if (entityIds.length === 0) return 0;
      const res = db
        .delete(t.listMembers)
        .where(
          and(
            eq(t.listMembers.workspaceId, ws),
            eq(t.listMembers.listId, listId),
            eq(t.listMembers.entityType, entityType),
            inArray(t.listMembers.entityId, entityIds),
          ),
        )
        .run();
      return res.changes;
    },
    async forEntity(entityType, entityId) {
      const rows = db
        .select({ list: t.lists })
        .from(t.listMembers)
        .innerJoin(t.lists, eq(t.lists.id, t.listMembers.listId))
        .where(and(eq(t.listMembers.workspaceId, ws), eq(t.listMembers.entityType, entityType), eq(t.listMembers.entityId, entityId)))
        .orderBy(asc(t.lists.name))
        .all();
      return rows.map((r) => mapList(r.list));
    },
    async forEntities(entityType, entityIds) {
      if (entityIds.length === 0) return {};
      const rows = db
        .select({ list: t.lists, entityId: t.listMembers.entityId })
        .from(t.listMembers)
        .innerJoin(t.lists, eq(t.lists.id, t.listMembers.listId))
        .where(and(eq(t.listMembers.workspaceId, ws), eq(t.listMembers.entityType, entityType), inArray(t.listMembers.entityId, entityIds)))
        .all();
      const out: Record<string, ContactList[]> = {};
      for (const r of rows) (out[r.entityId] ??= []).push(mapList(r.list));
      return out;
    },
  };

  // --- custom fields ------------------------------------------------------------

  const customFieldsPort: Ports["customFields"] = {
    async listDefs(entityType, includeArchived = false) {
      const conds = [eq(t.customFieldDefs.workspaceId, ws)];
      if (entityType) conds.push(eq(t.customFieldDefs.entityType, entityType));
      if (!includeArchived) conds.push(isNull(t.customFieldDefs.archivedAt));
      return db
        .select()
        .from(t.customFieldDefs)
        .where(and(...conds))
        .orderBy(asc(t.customFieldDefs.position), asc(t.customFieldDefs.createdAt))
        .all()
        .map(mapCfd);
    },
    async getDef(id) {
      const row = db
        .select()
        .from(t.customFieldDefs)
        .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, id)))
        .get();
      return row ? mapCfd(row) : null;
    },
    async getDefByKey(entityType, key) {
      const row = db
        .select()
        .from(t.customFieldDefs)
        .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.entityType, entityType), eq(t.customFieldDefs.key, key)))
        .get();
      return row ? mapCfd(row) : null;
    },
    async createDef(input) {
      const id = newId();
      const maxPos =
        db
          .select({ n: sql<number>`COALESCE(MAX(${t.customFieldDefs.position}), -1)` })
          .from(t.customFieldDefs)
          .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.entityType, input.entityType)))
          .get()?.n ?? -1;
      db.insert(t.customFieldDefs)
        .values({
          id,
          workspaceId: ws,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          options: input.options ? JSON.stringify(input.options) : null,
          required: input.required ? 1 : 0,
          position: maxPos + 1,
          createdAt: nowIso(),
        })
        .run();
      return (await this.getDef(id))!;
    },
    async updateDef(id, patch) {
      db.update(t.customFieldDefs)
        .set({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.options !== undefined ? { options: patch.options ? JSON.stringify(patch.options) : null } : {}),
          ...(patch.required !== undefined ? { required: patch.required ? 1 : 0 } : {}),
        })
        .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, id)))
        .run();
      const def = await this.getDef(id);
      if (!def) throw OpError.notFound("custom field", id);
      return def;
    },
    async setDefArchived(id, archived) {
      db.update(t.customFieldDefs)
        .set({ archivedAt: archived ? nowIso() : null })
        .where(and(eq(t.customFieldDefs.workspaceId, ws), eq(t.customFieldDefs.id, id)))
        .run();
      const def = await this.getDef(id);
      if (!def) throw OpError.notFound("custom field", id);
      return def;
    },
    async setValue(fieldId, entityType, entityId, value) {
      if (value === null) {
        db.delete(t.customFieldValues)
          .where(and(eq(t.customFieldValues.fieldId, fieldId), eq(t.customFieldValues.entityId, entityId)))
          .run();
        return;
      }
      sqlite
        .prepare(
          `INSERT INTO custom_field_values (id, workspace_id, field_id, entity_type, entity_id, value, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(field_id, entity_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(newId(), ws, fieldId, entityType, entityId, JSON.stringify(value), nowIso());
    },
    async values(entityType, entityId) {
      const rows = db
        .select({ value: t.customFieldValues.value, key: t.customFieldDefs.key })
        .from(t.customFieldValues)
        .innerJoin(t.customFieldDefs, eq(t.customFieldDefs.id, t.customFieldValues.fieldId))
        .where(
          and(
            eq(t.customFieldValues.workspaceId, ws),
            eq(t.customFieldValues.entityType, entityType),
            eq(t.customFieldValues.entityId, entityId),
            isNull(t.customFieldDefs.archivedAt),
          ),
        )
        .all();
      const out: Record<string, CustomFieldValue> = {};
      for (const r of rows) out[r.key] = json<CustomFieldValue>(r.value, null);
      return out;
    },
  };

  // --- saved views ----------------------------------------------------------------

  const savedViewsPort: Ports["savedViews"] = {
    async list(userId) {
      const rows = db
        .select()
        .from(t.savedViews)
        .where(
          and(
            eq(t.savedViews.workspaceId, ws),
            or(
              inArray(t.savedViews.visibility, ["shared", "system"]),
              userId ? eq(t.savedViews.ownerUserId, userId) : sql`0`,
            ),
          ),
        )
        .orderBy(asc(t.savedViews.name))
        .all();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        entityType: r.entityType as SavedView["entityType"],
        filters: json(r.filters, {}),
        visibility: r.visibility as SavedView["visibility"],
        ownerUserId: r.ownerUserId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
    async get(id) {
      const r = db
        .select()
        .from(t.savedViews)
        .where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, id)))
        .get();
      return r
        ? {
            id: r.id,
            name: r.name,
            entityType: r.entityType as SavedView["entityType"],
            filters: json(r.filters, {}),
            visibility: r.visibility as SavedView["visibility"],
            ownerUserId: r.ownerUserId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }
        : null;
    },
    async create(input) {
      const id = newId();
      const now = nowIso();
      db.insert(t.savedViews)
        .values({
          id,
          workspaceId: ws,
          name: input.name,
          entityType: input.entityType,
          filters: JSON.stringify(input.filters),
          visibility: input.visibility,
          ownerUserId: input.ownerUserId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.savedViews)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.filters !== undefined ? { filters: JSON.stringify(patch.filters) } : {}),
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, id)))
        .run();
      const v = await this.get(id);
      if (!v) throw OpError.notFound("saved view", id);
      return v;
    },
    async delete(id) {
      db.delete(t.savedViews).where(and(eq(t.savedViews.workspaceId, ws), eq(t.savedViews.id, id))).run();
    },
  };

  // --- pending actions ----------------------------------------------------------

  const pendingPort: Ports["pendingActions"] = {
    async list(status) {
      const conds = [eq(t.pendingActions.workspaceId, ws)];
      if (status) conds.push(eq(t.pendingActions.status, status));
      return db
        .select()
        .from(t.pendingActions)
        .where(and(...conds))
        .orderBy(desc(t.pendingActions.requestedAt))
        .limit(200)
        .all()
        .map(mapPending);
    },
    async get(id) {
      const r = db
        .select()
        .from(t.pendingActions)
        .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.id, id)))
        .get();
      return r ? mapPending(r) : null;
    },
    async create(input) {
      const id = newId();
      db.insert(t.pendingActions)
        .values({
          id,
          workspaceId: ws,
          operation: input.operation,
          input: JSON.stringify(input.input),
          preview: input.preview ? JSON.stringify(input.preview) : null,
          riskCategory: input.riskCategory,
          status: "pending",
          requestedByType: input.actor.actorType,
          requestedByUserId: input.actor.actorUserId,
          requestedByClientId: input.actor.actorClientId,
          requestedAt: nowIso(),
          expiresAt: input.expiresAt,
        })
        .run();
      return (await this.get(id))!;
    },
    async setStatus(id, patch) {
      db.update(t.pendingActions)
        .set({
          status: patch.status,
          reviewedByUserId: patch.reviewedByUserId ?? null,
          reviewedAt: nowIso(),
          reviewNote: patch.reviewNote ?? null,
          result: patch.result ? JSON.stringify(patch.result) : null,
        })
        .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.id, id)))
        .run();
      const pa = await this.get(id);
      if (!pa) throw OpError.notFound("pending action", id);
      return pa;
    },
    async countPending() {
      return (
        db
          .select({ n: count() })
          .from(t.pendingActions)
          .where(and(eq(t.pendingActions.workspaceId, ws), eq(t.pendingActions.status, "pending")))
          .get()?.n ?? 0
      );
    },
  };

  // --- audit ---------------------------------------------------------------------

  const auditPort: Ports["audit"] = {
    async record(input: AuditInput, actor: ActorStamp) {
      const id = newId();
      db.insert(t.auditEvents)
        .values({
          id,
          workspaceId: ws,
          operation: input.operation,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          summary: input.summary,
          meta: input.meta ? JSON.stringify(input.meta) : null,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId,
          actorClientId: actor.actorClientId,
          surface: actor.surface,
          createdAt: nowIso(),
        })
        .run();
      return mapAudit(db.select().from(t.auditEvents).where(eq(t.auditEvents.id, id)).get()!);
    },
    async list(filter) {
      const conds: SQL[] = [eq(t.auditEvents.workspaceId, ws) as unknown as SQL];
      if (filter.actorType) conds.push(eq(t.auditEvents.actorType, filter.actorType) as unknown as SQL);
      if (filter.operation) conds.push(like(t.auditEvents.operation, `${filter.operation}%`) as unknown as SQL);
      if (filter.entityType) conds.push(eq(t.auditEvents.entityType, filter.entityType) as unknown as SQL);
      if (filter.entityId) conds.push(eq(t.auditEvents.entityId, filter.entityId) as unknown as SQL);
      const where = and(...conds);
      const total = db.select({ n: count() }).from(t.auditEvents).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(t.auditEvents)
        .where(where)
        .orderBy(desc(t.auditEvents.createdAt))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();
      return { items: rows.map(mapAudit), total };
    },
  };

  // --- MCP clients ------------------------------------------------------------------

  const mcpClientsPort: Ports["mcpClients"] = {
    async list() {
      return db
        .select()
        .from(t.mcpClients)
        .where(eq(t.mcpClients.workspaceId, ws))
        .orderBy(desc(t.mcpClients.createdAt))
        .all()
        .map(mapMcpClient);
    },
    async get(id) {
      const r = db
        .select()
        .from(t.mcpClients)
        .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, id)))
        .get();
      return r ? mapMcpClient(r) : null;
    },
    async getByTokenHash(hash) {
      const r = db.select().from(t.mcpClients).where(eq(t.mcpClients.tokenHash, hash)).get();
      return r ? { ...mapMcpClient(r), workspaceId: r.workspaceId } : null;
    },
    async create(input) {
      const id = newId();
      db.insert(t.mcpClients)
        .values({
          id,
          workspaceId: ws,
          name: input.name,
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          scopes: JSON.stringify(input.scopes),
          trust: input.trust,
          createdByUserId: input.createdByUserId,
          createdAt: nowIso(),
        })
        .run();
      return (await this.get(id))!;
    },
    async update(id, patch) {
      db.update(t.mcpClients)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.scopes !== undefined ? { scopes: JSON.stringify(patch.scopes) } : {}),
          ...(patch.trust !== undefined ? { trust: patch.trust } : {}),
        })
        .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, id)))
        .run();
      const c = await this.get(id);
      if (!c) throw OpError.notFound("MCP client", id);
      return c;
    },
    async revoke(id) {
      db.update(t.mcpClients)
        .set({ revokedAt: nowIso() })
        .where(and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.id, id)))
        .run();
      const c = await this.get(id);
      if (!c) throw OpError.notFound("MCP client", id);
      return c;
    },
    async revokeAllForUser(userId) {
      // Same semantics as revoke(): flag with revokedAt, never delete. Only
      // touches still-active clients so earlier revocation timestamps survive.
      return db
        .update(t.mcpClients)
        .set({ revokedAt: nowIso() })
        .where(
          and(eq(t.mcpClients.workspaceId, ws), eq(t.mcpClients.createdByUserId, userId), isNull(t.mcpClients.revokedAt)),
        )
        .run().changes;
    },
    async touchLastUsed(id) {
      db.update(t.mcpClients).set({ lastUsedAt: nowIso() }).where(eq(t.mcpClients.id, id)).run();
    },
  };

  // --- search -------------------------------------------------------------------

  const searchPort: Ports["search"] = {
    async global(query, limit) {
      const prefixes = settings().prefixes;
      const q = `%${query.trim().toLowerCase()}%`;
      const hits: SearchHit[] = [];

      const companies = sqlite
        .prepare(
          `SELECT id, display_id, name, industry, archived_at FROM companies
           WHERE workspace_id = ? AND (lower(name) LIKE ? OR lower(coalesce(industry,'')) LIKE ?)
           ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?`,
        )
        .all(ws, q, q, limit) as Array<{ id: string; display_id: number; name: string; industry: string | null; archived_at: string | null }>;
      hits.push(
        ...companies.map((c) => ({
          entityType: "company" as const,
          id: c.id,
          ref: `${prefixes["company"] ?? "COMPANY"}-${c.display_id}`,
          title: c.name,
          subtitle: c.industry,
          archived: c.archived_at != null,
        })),
      );

      const people = sqlite
        .prepare(
          `SELECT id, display_id, name, title, email, archived_at FROM people
           WHERE workspace_id = ? AND (lower(name) LIKE ? OR lower(coalesce(email,'')) LIKE ? OR lower(coalesce(title,'')) LIKE ?)
           ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?`,
        )
        .all(ws, q, q, q, limit) as Array<{
        id: string;
        display_id: number;
        name: string;
        title: string | null;
        email: string | null;
        archived_at: string | null;
      }>;
      hits.push(
        ...people.map((p) => ({
          entityType: "person" as const,
          id: p.id,
          ref: `${prefixes["person"] ?? "PERSON"}-${p.display_id}`,
          title: p.name,
          subtitle: p.title ?? p.email,
          archived: p.archived_at != null,
        })),
      );

      const engagements = sqlite
        .prepare(
          `SELECT id, display_id, title, channel, archived_at FROM engagements
           WHERE workspace_id = ? AND (lower(title) LIKE ? OR lower(coalesce(source,'')) LIKE ?)
           ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?`,
        )
        .all(ws, q, q, limit) as Array<{ id: string; display_id: number; title: string; channel: string | null; archived_at: string | null }>;
      hits.push(
        ...engagements.map((e) => ({
          entityType: "engagement" as const,
          id: e.id,
          ref: `${prefixes["engagement"] ?? "LEAD"}-${e.display_id}`,
          title: e.title,
          subtitle: e.channel,
          archived: e.archived_at != null,
        })),
      );

      const deals = sqlite
        .prepare(
          `SELECT id, display_id, title, status, archived_at FROM deals
           WHERE workspace_id = ? AND lower(title) LIKE ?
           ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?`,
        )
        .all(ws, q, limit) as Array<{ id: string; display_id: number; title: string; status: string; archived_at: string | null }>;
      hits.push(
        ...deals.map((d) => ({
          entityType: "deal" as const,
          id: d.id,
          ref: `${prefixes["deal"] ?? "DEAL"}-${d.display_id}`,
          title: d.title,
          subtitle: d.status,
          archived: d.archived_at != null,
        })),
      );

      const notes = sqlite
        .prepare(
          `SELECT id, kind, title, body, archived_at FROM (
             SELECT id, kind, title, body, NULL AS archived_at, created_at FROM activities
             WHERE workspace_id = ? AND kind IN ('note','call','email','meeting') AND lower(coalesce(body,'') || ' ' || coalesce(title,'')) LIKE ?
           ) ORDER BY created_at DESC LIMIT ?`,
        )
        .all(ws, q, Math.min(limit, 10)) as Array<{ id: string; kind: string; title: string | null; body: string | null; archived_at: null }>;
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
    },
  };

  // --- maintenance -----------------------------------------------------------------

  const maintenancePort: Ports["maintenance"] = {
    async backup() {
      const dbPath = (sqlite as unknown as { name: string }).name;
      const dir = join(dirname(dbPath), "backups");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = join(dir, `emcp-${stamp}.db`);
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      sqlite.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      return dest;
    },
    async counts() {
      const one = (table: string, extra = ""): number =>
        (sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace_id = ? AND archived_at IS NULL ${extra}`).get(ws) as { n: number }).n;
      return {
        companies: one("companies"),
        people: one("people"),
        engagements: one("engagements"),
        deals: one("deals"),
        openDeals: one("deals", "AND status = 'open'"),
      };
    },
  };

  // --- transactions -------------------------------------------------------------------
  //
  // better-sqlite3 transactions are SYNCHRONOUS: `sqlite.transaction(fn)()`
  // commits the moment fn RETURNS. An async fn returns a pending Promise at
  // its first await, so passing one would commit mid-flight and run the rest
  // of the handler outside the transaction. Therefore: NEVER await inside a
  // better-sqlite3 transaction callback. Because operation handlers are async,
  // this adapter instead manages BEGIN/COMMIT/ROLLBACK manually around the
  // awaited fn. That is safe here because of two invariants:
  //
  //   1. Every port method in this adapter is async-signature but internally
  //      synchronous — awaits between statements only yield microtasks, never
  //      real I/O, so a transaction still completes promptly.
  //   2. txLock (per database connection, module scope) serializes top-level
  //      transactions. The fully-sync adapter serialized them implicitly by
  //      blocking the event loop; with async handlers two in-flight requests
  //      could otherwise interleave BEGINs on the shared connection.
  //
  // Nested tx() calls join the outer transaction, exactly as before (the
  // depth counter is per-Ports instance; a request runs on one instance, so
  // its nested calls see depth > 0 while other requests queue on txLock).
  //
  // Async-capable adapters (e.g. a future Postgres one) should NOT copy this
  // shape — they can use real client transactions (BEGIN…COMMIT on a
  // dedicated connection, awaits welcome) behind the same port signature.

  let txDepth = 0;
  const tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (txDepth > 0) return fn(); // nested: join the outer transaction
    const previous = txLock.get(sqlite) ?? Promise.resolve();
    let release!: () => void;
    txLock.set(
      sqlite,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    txDepth++;
    try {
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
        throw e;
      }
    } finally {
      txDepth--;
      release();
    }
  };

  return {
    workspace: workspacePort,
    users: usersPort,
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
    credentials: credentialsPort,
    search: searchPort,
    maintenance: maintenancePort,
    tx,
  };
}
