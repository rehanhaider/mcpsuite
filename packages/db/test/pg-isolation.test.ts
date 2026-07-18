/**
 * Hostile two-workspace isolation tests + behavioral parity checks for the
 * PostgreSQL adapter (src/pg/repositories.ts), per
 * docs/architecture/postgres-tenant-isolation.md.
 *
 * ── How to run (once the `pg` driver install is signed off) ────────────────
 *
 *   1. Install the driver (NOT yet a dependency — awaiting signoff):
 *        mise exec -- pnpm --filter @emcp/db add pg
 *   2. Start a disposable PostgreSQL 17 (any free local port; 55432 below
 *      avoids every port this repo uses):
 *        docker run --rm -d --name emcp-pg-test \
 *          -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 \
 *          postgres:17-alpine
 *   3. Run just this suite:
 *        cd packages/db && PG_TESTS=1 \
 *          DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *          mise exec -- pnpm vitest run pg-isolation
 *   4. Tear down:  docker rm -f emcp-pg-test
 *
 * DATABASE_URL must be a superuser/deployment credential: the harness drops +
 * re-applies the crm schema and sets a throwaway password on the crm_app
 * role. The adapter under test then connects AS crm_app — the isolation
 * assertions are meaningless under a superuser (it bypasses RLS), which is
 * why the doc requires testing with the real runtime role.
 *
 * Without PG_TESTS=1 and DATABASE_URL the whole file self-skips, so the
 * default `make test` suite ignores it (and never needs the pg driver).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpError, type ActorStamp } from "@emcp/core";
import {
  connectPg,
  createPgPorts,
  provisionPgWorkspace,
  type PgHandle,
  type PgPorts,
  type PgPoolClientLike,
} from "../src/pg/repositories.ts";
import { applyPgMigrations } from "../src/pg/migrate.ts";

const enabled = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;

const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw";
const RANDOM_ID = "01890000-0000-7000-8000-00000000dead"; // valid uuid, never inserted
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Must stay identical to the policy registry in src/pg/migrations/0003_rls.sql. */
const WORKSPACE_OWNED_TABLES = [
  "users",
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
  "engagement_offering_links",
  "deal_offering_links",
  "activities",
  "tags",
  "company_tags",
  "person_tags",
  "engagement_tags",
  "deal_tags",
  "lists",
  "company_list_members",
  "person_list_members",
  "engagement_list_members",
  "deal_list_members",
  "custom_field_definitions",
  "company_custom_field_values",
  "person_custom_field_values",
  "engagement_custom_field_values",
  "deal_custom_field_values",
  "offering_custom_field_values",
  "saved_views",
  "pending_actions",
  "audit_events",
];
/** RLS'd via `id` instead of `workspace_id`. */
const WORKSPACE_ROOT_TABLE = "workspaces";
/** RLS on, no policy, no grants: unreachable by runtime roles. */
const DENIED_TABLES = ["sessions", "schema_migrations"];

describe.runIf(enabled)("postgres workspace isolation (crm_app under forced RLS)", () => {
  let admin: PgHandle;
  let app: PgHandle;
  let wsA: string;
  let wsB: string;
  let portsA: PgPorts;
  let portsB: PgPorts;

  // Seeded records per workspace.
  interface Seed {
    userId: string;
    email: string;
    companyId: string;
    personId: string;
    engagementPipelineId: string;
    engagementStageIds: string[];
    dealPipelineId: string;
    dealStageIds: string[];
    engagementId: string;
    dealId: string;
    tagId: string;
    listId: string;
    offeringId: string;
    fieldId: string;
    taskId: string;
    savedViewId: string;
    pendingId: string;
    clientId: string;
    clientTokenHash: string;
  }
  let A: Seed;
  let B: Seed;

  const actor = (userId: string): ActorStamp => ({
    actorType: "human",
    actorUserId: userId,
    actorClientId: null,
    surface: "web",
  });

  async function seedWorkspace(ports: PgPorts, label: string): Promise<Seed> {
    const user = await ports.users.create({
      name: `${label} Owner`,
      email: `${label.toLowerCase()}-owner@example.test`,
      role: "owner",
      passwordHash: null,
    });
    const ePipe = await ports.pipelines.create({
      type: "engagement",
      name: `${label} Outreach`,
      isDefault: true,
      stages: [
        { name: "New", color: "ghost" },
        { name: "Engaged", color: "primary" },
        { name: "Declined", color: "error", outcome: "lost" },
      ],
    });
    const dPipe = await ports.pipelines.create({
      type: "deal",
      name: `${label} Sales`,
      isDefault: true,
      stages: [
        { name: "Discovery", color: "info", probability: 10 },
        { name: "Won", color: "success", probability: 100, outcome: "won" },
      ],
    });
    const company = await ports.companies.create({ name: `${label} Co`, industry: "SaaS", country: "UK" });
    const person = await ports.people.create({ name: `${label} Person`, email: `${label.toLowerCase()}@people.test` });
    await ports.people.link({ companyId: company.id, personId: person.id, isPrimary: true, roleTitle: "CTO" });
    const engagement = await ports.engagements.create({
      title: `${label} lead`,
      pipelineId: ePipe.id,
      stageId: ePipe.stages[0]!.id,
      companyId: company.id,
      personId: person.id,
      channel: "Email",
    });
    const deal = await ports.deals.create({
      title: `${label} deal`,
      pipelineId: dPipe.id,
      stageId: dPipe.stages[0]!.id,
      currency: "USD",
      amountMinor: 500_000,
      companyId: company.id,
      engagementId: engagement.id,
    });
    const tag = await ports.tags.create({ name: `${label}-hot`, color: "error" });
    await ports.tags.apply(tag.id, "company", company.id);
    const list = await ports.lists.create({ name: `${label} audience`, color: "info" });
    await ports.lists.addMembers(list.id, "person", [person.id]);
    const offering = await ports.offerings.create({ name: `${label} Offering`, type: "product" });
    await ports.offerings.link({ offeringId: offering.id, entityType: "engagement", entityId: engagement.id, isPrimary: true });
    const field = await ports.customFields.createDef({
      entityType: "company",
      key: "confidence",
      label: "Confidence",
      type: "select",
      options: ["High", "Low"],
      required: false,
    });
    await ports.customFields.setValue(field.id, "company", company.id, "High");
    const task = await ports.activities.create(
      { kind: "task", title: `${label} follow up`, dueAt: "2020-01-01", engagementId: engagement.id },
      actor(user.id),
    );
    await ports.activities.touchLinked({ engagementId: engagement.id, dealId: null }, new Date().toISOString());
    const view = await ports.savedViews.create({
      name: `${label} view`,
      entityType: "engagement",
      filters: { search: label.toLowerCase() },
      visibility: "private",
      ownerUserId: user.id,
    });
    const pending = await ports.pendingActions.create({
      operation: "company.delete",
      input: { id: company.id },
      preview: null,
      riskCategory: "destructive",
      actor: actor(user.id),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const tokenHash = `${label.toLowerCase()}-token-hash-${Math.random().toString(36).slice(2)}`;
    const client = await ports.mcpClients.create({
      name: `${label} agent`,
      tokenHash,
      tokenPrefix: "emcp_test",
      scopes: ["read", "write"],
      trust: "review_risky_actions",
      createdByUserId: user.id,
    });
    await ports.audit.record(
      { operation: "company.create", entityType: "company", entityId: company.id, summary: `${label} seeded` },
      actor(user.id),
    );
    return {
      userId: user.id,
      email: user.email,
      companyId: company.id,
      personId: person.id,
      engagementPipelineId: ePipe.id,
      engagementStageIds: ePipe.stages.map((s) => s.id),
      dealPipelineId: dPipe.id,
      dealStageIds: dPipe.stages.map((s) => s.id),
      engagementId: engagement.id,
      dealId: deal.id,
      tagId: tag.id,
      listId: list.id,
      offeringId: offering.id,
      fieldId: field.id,
      taskId: task.id,
      savedViewId: view.id,
      pendingId: pending.id,
      clientId: client.id,
      clientTokenHash: tokenHash,
    };
  }

  /** Run statements on one dedicated app-role connection (for BEGIN/SET LOCAL sequences). */
  async function withAppClient<T>(fn: (c: PgPoolClientLike) => Promise<T>): Promise<T> {
    const client = await app.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL!;
    admin = await connectPg({ databaseUrl: adminUrl, max: 2 });

    // Fresh schema every run; roles are cluster-global and guarded in 0002.
    await admin.pool.query("DROP SCHEMA IF EXISTS crm CASCADE");
    await applyPgMigrations(admin.pool);
    await admin.pool.query(`ALTER ROLE crm_app WITH PASSWORD '${APP_ROLE_TEST_PASSWORD}'`);

    const appUrl = new URL(adminUrl);
    appUrl.username = "crm_app";
    appUrl.password = APP_ROLE_TEST_PASSWORD;
    app = await connectPg({ databaseUrl: appUrl.toString(), max: 2 });

    // Everything below runs as crm_app — including workspace provisioning
    // (generate the id first, install it, insert: the WITH CHECK path).
    wsA = await provisionPgWorkspace(app.db, { name: "Workspace A" });
    wsB = await provisionPgWorkspace(app.db, { name: "Workspace B" });
    portsA = createPgPorts(app.db, wsA);
    portsB = createPgPorts(app.db, wsB);
    A = await seedWorkspace(portsA, "Alpha");
    B = await seedWorkspace(portsB, "Beta");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  // ── 1. Schema + privilege audit (doc test matrix §1) ──────────────────────

  it("classifies every crm table; none may exist outside the registry", async () => {
    const res = await admin.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'crm' ORDER BY tablename");
    const live = res.rows.map((r) => String(r.tablename)).sort();
    const expected = [...WORKSPACE_OWNED_TABLES, WORKSPACE_ROOT_TABLE, ...DENIED_TABLES].sort();
    expect(live).toEqual(expected);
  });

  it("every table has RLS enabled AND forced", async () => {
    const res = await admin.pool.query(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'crm' AND c.relkind = 'r'`,
    );
    for (const row of res.rows) {
      expect(row.rls, `RLS enabled on ${row.name}`).toBe(true);
      expect(row.forced, `RLS forced on ${row.name}`).toBe(true);
    }
  });

  it("workspace_isolation policies carry both USING and WITH CHECK", async () => {
    const res = await admin.pool.query(
      `SELECT tablename, qual, with_check FROM pg_policies
       WHERE schemaname = 'crm' AND policyname = 'workspace_isolation'`,
    );
    const covered = new Set(res.rows.map((r) => String(r.tablename)));
    for (const table of [...WORKSPACE_OWNED_TABLES, WORKSPACE_ROOT_TABLE]) {
      expect(covered.has(table), `policy exists on ${table}`).toBe(true);
    }
    for (const row of res.rows) {
      expect(row.qual, `USING on ${row.tablename}`).toBeTruthy();
      expect(row.with_check, `WITH CHECK on ${row.tablename}`).toBeTruthy();
    }
  });

  it("crm_app is not superuser/BYPASSRLS and owns no crm table", async () => {
    const role = await admin.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'crm_app'");
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const owners = await admin.pool.query("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'crm'");
    expect(owners.rows.map((r) => r.tableowner)).toEqual(["crm_schema_owner"]);
  });

  it("crm_app cannot create tables or read auth/deployment tables", async () => {
    await expect(app.pool.query("CREATE TABLE crm.evil (id int)")).rejects.toThrow(/permission denied/i);
    await expect(app.pool.query("SELECT * FROM crm.sessions")).rejects.toThrow(/permission denied/i);
    await expect(app.pool.query("SELECT * FROM crm.schema_migrations")).rejects.toThrow(/permission denied/i);
  });

  it("identity resolvers: fixed shape for crm_app, no PUBLIC execute, no table access needed", async () => {
    // Without workspace context crm_app sees zero users…
    const direct = await app.pool.query("SELECT count(*)::int AS n FROM crm.users");
    expect(direct.rows[0]?.n).toBe(0);
    // …but the narrow resolver returns exactly the fixed identity fields.
    const resolved = await app.pool.query("SELECT * FROM crm.resolve_user_identity($1)", [A.email]);
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]).toMatchObject({ user_id: A.userId, workspace_id: wsA, role: "owner", enabled: true });
    expect(Object.keys(resolved.rows[0]!).sort()).toEqual(["enabled", "role", "user_id", "workspace_id"]);
    const unknown = await app.pool.query("SELECT * FROM crm.resolve_user_identity($1)", ["nobody@example.test"]);
    expect(unknown.rows).toHaveLength(0);

    const key = await app.pool.query("SELECT * FROM crm.resolve_mcp_key($1)", [B.clientTokenHash]);
    expect(key.rows[0]).toMatchObject({ client_id: B.clientId, workspace_id: wsB, enabled: true });

    // PUBLIC must hold no EXECUTE grant (an acl entry starting with "=").
    const acl = await admin.pool.query(
      `SELECT proname, coalesce(proacl::text, '') AS acl FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'crm' AND proname IN ('resolve_user_identity', 'resolve_mcp_key', 'current_workspace_id')`,
    );
    expect(acl.rows).toHaveLength(3);
    for (const row of acl.rows) {
      const entries = String(row.acl).replace(/[{}]/g, "").split(",").filter(Boolean);
      expect(entries.length, `${row.proname} has explicit acl`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsWith("="), `${row.proname} grants nothing to PUBLIC`).toBe(false);
      }
    }
  });

  // ── 2. Session-GUC contract (doc test matrix §2) ──────────────────────────

  it("no workspace context → zero rows, even though data exists", async () => {
    const res = await app.pool.query("SELECT count(*)::int AS n FROM crm.companies");
    expect(res.rows[0]?.n).toBe(0);
    const ws = await app.pool.query("SELECT count(*)::int AS n FROM crm.workspaces");
    expect(ws.rows[0]?.n).toBe(0);
  });

  it("malformed and unknown workspace context → zero rows", async () => {
    await withAppClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", ["not-a-uuid"]);
      const malformed = await c.query("SELECT count(*)::int AS n FROM crm.companies");
      expect(malformed.rows[0]?.n).toBe(0);
      await c.query("ROLLBACK");

      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [RANDOM_ID]);
      const unknown = await c.query("SELECT count(*)::int AS n FROM crm.companies");
      expect(unknown.rows[0]?.n).toBe(0);
      await c.query("ROLLBACK");
    });
  });

  it("transaction-local context does not survive COMMIT on a reused connection", async () => {
    await withAppClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      const inside = await c.query("SELECT count(*)::int AS n FROM crm.companies");
      expect(inside.rows[0]?.n).toBe(1);
      await c.query("COMMIT");
      // Same physical connection, next statement: context must be gone.
      const after = await c.query("SELECT count(*)::int AS n FROM crm.companies");
      expect(after.rows[0]?.n).toBe(0);
    });
  });

  it("WITH CHECK rejects inserting a row into another workspace", async () => {
    await withAppClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      await expect(
        c.query(
          `INSERT INTO crm.companies (id, workspace_id, display_id, name, version, created_at, updated_at)
           VALUES ($1, $2, 999, 'Smuggled', 1, now(), now())`,
          [RANDOM_ID, wsB],
        ),
      ).rejects.toThrow(/row-level security/i);
      await c.query("ROLLBACK");
    });
    expect((await portsB.companies.list({ includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 })).total).toBe(1);
  });

  it("an intentionally unscoped SELECT inside an adapter transaction still returns only A", async () => {
    await withAppClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      const res = await c.query("SELECT DISTINCT workspace_id FROM crm.companies"); // no predicate at all
      expect(res.rows.map((r) => r.workspace_id)).toEqual([wsA]);
      await c.query("ROLLBACK");
    });
  });

  // ── 3. Hostile cross-workspace probes through the ports (doc §4/§5) ───────

  it("reads: known B ids behave exactly like random nonexistent ids", async () => {
    expect(await portsA.companies.get(B.companyId)).toBeNull();
    expect(await portsA.companies.get(RANDOM_ID)).toBeNull();
    expect(await portsA.companies.get("definitely-not-a-uuid")).toBeNull();
    expect(await portsA.people.get(B.personId)).toBeNull();
    expect(await portsA.engagements.get(B.engagementId)).toBeNull();
    expect(await portsA.deals.get(B.dealId)).toBeNull();
    expect(await portsA.tags.get(B.tagId)).toBeNull();
    expect(await portsA.lists.get(B.listId)).toBeNull();
    expect(await portsA.offerings.get(B.offeringId)).toBeNull();
    expect(await portsA.customFields.getDef(B.fieldId)).toBeNull();
    expect(await portsA.activities.get(B.taskId)).toBeNull();
    expect(await portsA.savedViews.get(B.savedViewId)).toBeNull();
    expect(await portsA.pendingActions.get(B.pendingId)).toBeNull();
    expect(await portsA.mcpClients.get(B.clientId)).toBeNull();
    expect(await portsA.users.get(B.userId)).toBeNull();
    expect(await portsA.pipelines.get(B.dealPipelineId)).toBeNull();
    expect(await portsA.pipelines.getStage(B.dealStageIds[0]!)).toBeNull();
    expect(await portsA.deals.getStakeholder(RANDOM_ID)).toBeNull();
    expect(await portsA.mcpClients.getByTokenHash(B.clientTokenHash)).toBeNull();
  });

  it("lists, counts, search and stats contain zero B-derived rows", async () => {
    const companies = await portsA.companies.list({ includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(companies.total).toBe(1);
    expect(companies.items[0]!.name).toBe("Alpha Co");

    const searchB = await portsA.companies.list({ search: "beta", includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(searchB.total).toBe(0);

    expect((await portsA.search.global("beta", 10)).length).toBe(0);
    expect((await portsA.search.global("alpha", 10)).length).toBeGreaterThan(0);

    expect(await portsA.users.count()).toBe(1);
    expect((await portsA.users.list()).map((u) => u.id)).toEqual([A.userId]);
    expect(await portsA.users.getByEmail(B.email)).toBeNull();

    const counts = await portsA.maintenance.counts();
    expect(counts).toMatchObject({ companies: 1, people: 1, engagements: 1, deals: 1, openDeals: 1 });

    expect((await portsA.pipelines.list()).map((p) => p.name).sort()).toEqual(["Alpha Outreach", "Alpha Sales"]);
    expect(await portsA.engagements.countByStage(B.engagementPipelineId)).toEqual([]);
    expect(await portsA.deals.stageStats(B.dealPipelineId)).toEqual([]);
    expect((await portsA.audit.list({ limit: 100, offset: 0 })).items.every((e) => e.summary.startsWith("Alpha"))).toBe(true);
    expect((await portsA.pendingActions.list()).map((p) => p.id)).toEqual([A.pendingId]);
    expect((await portsA.tags.list()).map((x) => x.name)).toEqual(["Alpha-hot"]);
    expect((await portsA.lists.list()).map((x) => x.name)).toEqual(["Alpha audience"]);
    expect((await portsA.offerings.list(true)).map((x) => x.name)).toEqual(["Alpha Offering"]);
    expect((await portsA.savedViews.list(A.userId)).map((v) => v.id)).toEqual([A.savedViewId]);
    expect(await portsA.savedViews.list(B.userId)).toEqual([]); // B's private views invisible even by owner id
  });

  it("joins and filters keyed by B ids return empty, not B data", async () => {
    const people = await portsA.people.list({ companyId: B.companyId, includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(people.total).toBe(0);
    const engagements = await portsA.engagements.list({ pipelineId: B.engagementPipelineId, includeArchived: true, sort: "updatedAt", dir: "desc", limit: 100, offset: 0 });
    expect(engagements.total).toBe(0);
    const byBTag = await portsA.companies.list({ tagIds: [B.tagId], includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(byBTag.total).toBe(0);
    const byBList = await portsA.people.list({ listId: B.listId, includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(byBList.total).toBe(0);
    const dealsByBPerson = await portsA.deals.list({ personId: B.personId, includeArchived: true, sort: "updatedAt", dir: "desc", limit: 100, offset: 0 });
    expect(dealsByBPerson.total).toBe(0);
    const byBOffering = await portsA.engagements.list({ offeringId: B.offeringId, includeArchived: true, sort: "updatedAt", dir: "desc", limit: 100, offset: 0 });
    expect(byBOffering.total).toBe(0);
    expect(await portsA.tags.forEntity("company", B.companyId)).toEqual([]);
    expect(await portsA.lists.forEntity("person", B.personId)).toEqual([]);
    expect(await portsA.customFields.values("company", B.companyId)).toEqual({});
    expect(await portsA.offerings.links("engagement", B.engagementId)).toEqual([]);
    expect(await portsA.companies.people(B.companyId)).toEqual([]);
    expect(await portsA.deals.stakeholders(B.dealId)).toEqual([]);
  });

  it("mutations against B primary ids fail like random ids and leave B byte-identical", async () => {
    const before = JSON.stringify(await portsB.companies.get(B.companyId));

    await expect(portsA.companies.update(B.companyId, { name: "Hacked" })).rejects.toThrow(OpError);
    await expect(portsA.companies.update(RANDOM_ID, { name: "Hacked" })).rejects.toThrow(OpError);
    const errB = await portsA.companies.update(B.companyId, { name: "Hacked" }).catch((e: OpError) => e.code);
    const errRandom = await portsA.companies.update(RANDOM_ID, { name: "Hacked" }).catch((e: OpError) => e.code);
    expect(errB).toBe("not_found");
    expect(errB).toBe(errRandom);

    await portsA.companies.hardDelete(B.companyId); // deletes nothing outside A
    await portsA.activities.hardDelete(B.taskId);
    await portsA.savedViews.delete(B.savedViewId);
    await portsA.tags.delete(B.tagId);
    await portsA.lists.delete(B.listId);
    await portsA.pipelines.deleteStage(B.engagementStageIds[0]!);
    await expect(portsA.users.update(B.userId, { name: "Owned" })).rejects.toThrow(OpError);
    await expect(portsA.mcpClients.revoke(B.clientId)).rejects.toThrow(OpError);
    await expect(portsA.pendingActions.setStatus(B.pendingId, { status: "approved" })).rejects.toThrow(OpError);
    await portsA.mcpClients.touchLastUsed(B.clientId);

    expect(JSON.stringify(await portsB.companies.get(B.companyId))).toBe(before);
    expect(await portsB.activities.get(B.taskId)).not.toBeNull();
    expect(await portsB.savedViews.get(B.savedViewId)).not.toBeNull();
    expect(await portsB.tags.get(B.tagId)).not.toBeNull();
    expect(await portsB.lists.get(B.listId)).not.toBeNull();
    expect(await portsB.pipelines.getStage(B.engagementStageIds[0]!)).not.toBeNull();
    expect((await portsB.mcpClients.get(B.clientId))!.lastUsedAt).toBeNull();
    expect((await portsB.mcpClients.get(B.clientId))!.revokedAt).toBeNull();
    expect((await portsB.pendingActions.get(B.pendingId))!.status).toBe("pending");
  });

  it("relationship writes cannot attach A children to B parents (composite FKs)", async () => {
    // A company ↔ B person and vice versa.
    await expect(portsA.people.link({ companyId: A.companyId, personId: B.personId })).rejects.toThrow();
    await expect(portsA.people.link({ companyId: B.companyId, personId: A.personId })).rejects.toThrow();
    // Stakeholder with a B person.
    await expect(portsA.deals.addStakeholder({ dealId: A.dealId, personId: B.personId })).rejects.toThrow();
    // Tagging across workspaces, both directions.
    await expect(portsA.tags.apply(A.tagId, "company", B.companyId)).rejects.toThrow();
    await expect(portsA.tags.apply(B.tagId, "company", A.companyId)).rejects.toThrow();
    // List membership with B entities.
    await expect(portsA.lists.addMembers(A.listId, "person", [B.personId])).rejects.toThrow();
    // Offering link to a B deal.
    await expect(
      portsA.offerings.link({ offeringId: A.offeringId, entityType: "deal", entityId: B.dealId }),
    ).rejects.toThrow();
    // Custom field value on a B company.
    await expect(portsA.customFields.setValue(A.fieldId, "company", B.companyId, "High")).rejects.toThrow();
    // Engagement pointing at a B pipeline/stage pair.
    await expect(
      portsA.engagements.create({
        title: "Smuggled lead",
        pipelineId: B.engagementPipelineId,
        stageId: B.engagementStageIds[0]!,
      }),
    ).rejects.toThrow();
    // Stage must belong to the referenced pipeline even inside A.
    await expect(
      portsA.engagements.create({
        title: "Wrong stage pairing",
        pipelineId: A.engagementPipelineId,
        stageId: A.dealStageIds[0]!,
      }),
    ).rejects.toThrow();

    // B's rows unaffected by all of the above.
    expect((await portsB.companies.people(B.companyId)).length).toBe(1);
    expect((await portsB.tags.list())[0]!.usage).toBe(1);
    expect((await portsB.lists.list())[0]!.people).toBe(1);
  });

  // ── 4. Behavioral parity with the SQLite adapter (catalog test patterns) ──

  it("company lifecycle: display ids, version bumps, archive, ISO timestamps", async () => {
    const c = await portsA.companies.create({ name: "Parity Co" });
    expect(c.displayId).toBe(2); // Alpha Co took 1
    expect(c.version).toBe(1);
    expect(c.createdAt).toMatch(ISO_RE);
    expect(c.archivedAt).toBeNull();

    const updated = await portsA.companies.update(c.id, { hq: "London" });
    expect(updated.version).toBe(2);
    expect(updated.hq).toBe("London");

    const archived = await portsA.companies.setArchived(c.id, true);
    expect(archived.archivedAt).toMatch(ISO_RE);
    const visible = await portsA.companies.list({ includeArchived: false, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(visible.items.some((x) => x.id === c.id)).toBe(false);
    const all = await portsA.companies.list({ includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(all.items.some((x) => x.id === c.id)).toBe(true);

    expect((await portsA.companies.getByName("  parity CO "))?.id).toBe(c.id);
    await portsA.companies.hardDelete(c.id);
    expect(await portsA.companies.get(c.id)).toBeNull();
  });

  it("people links: single primary company is enforced by the adapter", async () => {
    const c2 = await portsA.companies.create({ name: "Second Co" });
    const link = await portsA.people.link({ companyId: c2.id, personId: A.personId, isPrimary: true });
    expect(link.isPrimary).toBe(true);
    const companies = await portsA.people.companies(A.personId);
    expect(companies).toHaveLength(2);
    expect(companies.filter((l) => l.isPrimary)).toHaveLength(1);
    expect(companies[0]!.companyId).toBe(c2.id); // primary sorts first
    await portsA.people.unlink(c2.id, A.personId);
    await portsA.companies.hardDelete(c2.id);
  });

  it("engagements: stage counts and lastActivityAt denormalization", async () => {
    const counts = await portsA.engagements.countByStage(A.engagementPipelineId);
    expect(counts).toEqual([{ stageId: A.engagementStageIds[0], count: 1 }]);
    const engagement = await portsA.engagements.get(A.engagementId);
    expect(engagement!.lastActivityAt).toMatch(ISO_RE); // touched during seeding
    const stats = await portsA.deals.stageStats(A.dealPipelineId);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ stageId: A.dealStageIds[0], count: 1 });
    expect(stats[0]!.sums["USD"]).toBe(500_000);
    expect(stats[0]!.weighted["USD"]).toBe(50_000); // 10% of 500k
  });

  it("tasks: display ids and overdue filtering on date-or-datetime dueAt", async () => {
    const task = await portsA.activities.get(A.taskId);
    expect(task!.displayId).toBe(1);
    expect(task!.dueAt).toBe("2020-01-01"); // stored verbatim, no timestamp rewrite
    const overdue = await portsA.activities.list({ overdue: true, open: true, limit: 100, offset: 0 });
    expect(overdue.items.some((x) => x.id === A.taskId)).toBe(true);
    const done = await portsA.activities.update(A.taskId, { completedAt: new Date().toISOString() });
    expect(done.completedAt).toMatch(ISO_RE);
    const openAfter = await portsA.activities.list({ open: true, limit: 100, offset: 0 });
    expect(openAfter.items.some((x) => x.id === A.taskId)).toBe(false);
    await portsA.activities.update(A.taskId, { completedAt: null });
  });

  it("tags: usage counts, entity filters, idempotent apply", async () => {
    await portsA.tags.apply(A.tagId, "company", A.companyId); // already applied — no-op
    const tags = await portsA.tags.list();
    expect(tags).toHaveLength(1);
    expect(tags[0]!.usage).toBe(1);
    const filtered = await portsA.companies.list({ tagIds: [A.tagId], includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(await portsA.tags.forEntity("company", A.companyId)).toHaveLength(1);
    expect((await portsA.tags.forEntities("company", [A.companyId]))[A.companyId]).toHaveLength(1);
  });

  it("contact lists: member counts, filters, add/remove return counts", async () => {
    const added = await portsA.lists.addMembers(A.listId, "person", [A.personId]);
    expect(added).toBe(0); // already present
    const addedCompany = await portsA.lists.addMembers(A.listId, "company", [A.companyId]);
    expect(addedCompany).toBe(1);
    const lists = await portsA.lists.list();
    expect(lists[0]).toMatchObject({ people: 1, companies: 1, engagements: 0, deals: 0 });
    expect(await portsA.lists.memberTypeCounts(A.listId)).toEqual({ person: 1, company: 1 });
    const filtered = await portsA.people.list({ listId: A.listId, includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.lists.map((l) => l.id)).toEqual([A.listId]);
    const removed = await portsA.lists.removeMembers(A.listId, "company", [A.companyId]);
    expect(removed).toBe(1);
    expect(await portsA.lists.removeMembers(A.listId, "company", [A.companyId])).toBe(0);
  });

  it("custom fields: typed storage round-trips scalars and arrays; null clears", async () => {
    expect(await portsA.customFields.values("company", A.companyId)).toEqual({ confidence: "High" });
    const multi = await portsA.customFields.createDef({
      entityType: "company",
      key: "regions",
      label: "Regions",
      type: "multi_select",
      options: ["EU", "US"],
      required: false,
    });
    expect(multi.position).toBe(1);
    await portsA.customFields.setValue(multi.id, "company", A.companyId, ["EU", "US"]);
    expect(await portsA.customFields.values("company", A.companyId)).toEqual({ confidence: "High", regions: ["EU", "US"] });
    await portsA.customFields.setValue(multi.id, "company", A.companyId, null);
    expect(await portsA.customFields.values("company", A.companyId)).toEqual({ confidence: "High" });
  });

  it("saved views: private visibility scoped to the owner", async () => {
    expect((await portsA.savedViews.list(A.userId)).map((v) => v.id)).toEqual([A.savedViewId]);
    expect(await portsA.savedViews.list(null)).toEqual([]);
    const updated = await portsA.savedViews.update(A.savedViewId, { visibility: "shared" });
    expect(updated.visibility).toBe("shared");
    expect((await portsA.savedViews.list(null)).map((v) => v.id)).toEqual([A.savedViewId]);
    await portsA.savedViews.update(A.savedViewId, { visibility: "private" });
  });

  it("pending actions + audit: workspace-bound lifecycle", async () => {
    expect(await portsA.pendingActions.countPending()).toBe(1);
    const rejected = await portsA.pendingActions.setStatus(A.pendingId, {
      status: "rejected",
      reviewedByUserId: A.userId,
      reviewNote: "no",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).toMatch(ISO_RE);
    expect(await portsA.pendingActions.countPending()).toBe(0);

    const audit = await portsA.audit.list({ operation: "company.", limit: 10, offset: 0 });
    expect(audit.total).toBeGreaterThan(0);
    expect(audit.items.every((e) => e.operation.startsWith("company."))).toBe(true);
  });

  it("mcp clients: lifecycle within the workspace", async () => {
    const client = await portsA.mcpClients.get(A.clientId);
    expect(client!.scopes).toEqual(["read", "write"]);
    const renamed = await portsA.mcpClients.update(A.clientId, { name: "Renamed agent" });
    expect(renamed.name).toBe("Renamed agent");
    await portsA.mcpClients.touchLastUsed(A.clientId);
    expect((await portsA.mcpClients.get(A.clientId))!.lastUsedAt).toMatch(ISO_RE);
    const byHash = await portsA.mcpClients.getByTokenHash(A.clientTokenHash);
    expect(byHash).toMatchObject({ id: A.clientId, workspaceId: wsA });
  });

  it("workspace settings round-trip through jsonb", async () => {
    const ws = await portsA.workspace.get();
    expect(ws.settings.staleEngagementDays).toBe(14);
    const updated = await portsA.workspace.update({ settings: { ...ws.settings, staleEngagementDays: 3 } });
    expect(updated.settings.staleEngagementDays).toBe(3);
    expect((await portsB.workspace.get()).settings.staleEngagementDays).toBe(14);
  });

  it("hosted backups are refused at the port (private operator concern)", async () => {
    await expect(portsA.maintenance.backup()).rejects.toThrow(/backups/i);
  });

  it("ports.tx: rollback reverts business writes and audit together", async () => {
    const before = await portsA.maintenance.counts();
    await expect(
      portsA.tx(async () => {
        await portsA.companies.create({ name: "Doomed by rollback" });
        await portsA.audit.record({ operation: "company.create", summary: "doomed" }, actor(A.userId));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await portsA.maintenance.counts()).toEqual(before);
    const audit = await portsA.audit.list({ limit: 200, offset: 0 });
    expect(audit.items.some((e) => e.summary === "doomed")).toBe(false);
  });

  // ── 5. Pool reuse across workspaces ───────────────────────────────────────

  it("a max-1 pool serving A then B transactions never leaks context", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "crm_app";
    url.password = APP_ROLE_TEST_PASSWORD;
    const tiny = await connectPg({ databaseUrl: url.toString(), max: 1 });
    try {
      const pA = createPgPorts(tiny.db, wsA);
      const pB = createPgPorts(tiny.db, wsB);
      for (let i = 0; i < 3; i++) {
        const a = await pA.companies.list({ includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
        expect(a.items.every((x) => x.name.startsWith("Alpha"))).toBe(true);
        const b = await pB.companies.list({ includeArchived: true, sort: "name", dir: "asc", limit: 100, offset: 0 });
        expect(b.items.every((x) => x.name.startsWith("Beta"))).toBe(true);
        // A failed transaction must not poison the next user of the connection.
        await expect(pA.companies.update(RANDOM_ID, { name: "x" })).rejects.toThrow(OpError);
      }
    } finally {
      await tiny.close();
    }
  });
});

describe.runIf(!enabled)("postgres workspace isolation (skipped)", () => {
  it.skip("set PG_TESTS=1 and DATABASE_URL (and install the pg driver) to run this suite", () => {});
});
