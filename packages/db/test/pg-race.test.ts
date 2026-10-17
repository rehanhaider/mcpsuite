/**
 * Cross-workspace race tests for the PostgreSQL adapter, per
 * docs/architecture/postgres-tenant-isolation.md §10 "Race and inference
 * tests": one email invited into two workspaces at once, and list, tag,
 * offering and custom-value upserts running in both workspaces at once.
 * Owner-transfer races are covered in pg-auth.test.ts.
 *
 * Runs exactly like test/pg-isolation.test.ts:
 *
 *   docker run --rm -d --name mcpsuite-pg-test \
 *     -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   cd packages/db && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run pg-race
 *
 * DATABASE_URL must be a superuser/deployment credential (see the isolation
 * suite header for why). Like pg-auth.test.ts, this suite creates and
 * initializes its OWN database (mcpsuite_pg_race) so it stays parallel-safe
 * with the other PostgreSQL suites, and drops it afterwards. Every race runs
 * through the catalog as crm_app, the real runtime role. Without PG_TESTS=1
 * and DATABASE_URL the whole file self-skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCatalog,
  runOperation,
  systemContext,
  type ContactList,
  type CustomFieldDef,
  type Offering,
  type OfferingLink,
  type OpResult,
  type RequestContext,
  type Tag,
  type User,
} from "@mcpsuite/core";
import {
  connectPg,
  createPgPorts,
  provisionPgWorkspace,
  type PgHandle,
  type PgPorts,
} from "../src/pg/repositories.ts";
import { initPgSchema } from "../src/pg/init.ts";
import { authServices, csvServices } from "../src/services.ts";
import { dropTestDatabase, setTestRolePassword } from "./pg-test-support.ts";

const enabled = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;

const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as pg-isolation.test.ts
const RACE_DB = "mcpsuite_pg_race";
/** What a losing invitation returns: the generic conflict, nothing more. */
const EMAIL_UNAVAILABLE = { status: "error", error: { code: "conflict", message: "That email is unavailable" } };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled)("postgres races across workspaces (crm_app under forced RLS)", () => {
  let root: PgHandle; // server-level superuser on the original database
  let admin: PgHandle; // superuser on the dedicated mcpsuite_pg_race database
  let app: PgHandle; // crm_app on mcpsuite_pg_race
  const catalog = buildCatalog({ auth: authServices, csv: csvServices });

  /** One workspace with its owner and the records the upserts attach to. */
  interface Side {
    ws: string;
    ports: PgPorts;
    owner: User;
    ctx: RequestContext;
    companyId: string;
    engagementId: string;
  }
  let A: Side;
  let B: Side;

  async function seedSide(name: string, ownerEmail: string): Promise<Side> {
    const ws = await provisionPgWorkspace(app.db, { name });
    const ports = createPgPorts(app.db, ws);
    const owner = await ports.users.create({ name: `${name} Owner`, email: ownerEmail, role: "owner", passwordHash: null });
    const pipeline = await ports.pipelines.create({
      type: "engagement",
      name: "Outreach",
      isDefault: true,
      stages: [{ name: "New", color: "ghost" }],
    });
    const company = await ports.companies.create({ name: `${name} Co` });
    const engagement = await ports.engagements.create({
      title: `${name} lead`,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0]!.id,
      companyId: company.id,
    });
    const ctx: RequestContext = { ...systemContext(ws), actorType: "human", userId: owner.id, surface: "web" };
    return { ws, ports, owner, ctx, companyId: company.id, engagementId: engagement.id };
  }

  const call = (side: Side, name: string, input: unknown): Promise<OpResult> =>
    runOperation(catalog, side.ports, side.ctx, name, input);
  const data = <T>(result: OpResult): T => {
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return (result as { data: T }).data;
  };
  const invite = (side: Side, email: string): Promise<OpResult> =>
    call(side, "user.create", { name: "Contested", email, role: "member" });

  /**
   * The locks sessions in this suite's database are waiting for:
   * "transactionid" for a row another transaction wrote (a shared unique
   * key), "advisory" for an application lock such as the per-email code lock.
   */
  const lockWaits = async (): Promise<string[]> => {
    const res = await admin.pool.query(
      "SELECT wait_event FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
      [RACE_DB],
    );
    return res.rows.map((r) => String(r.wait_event));
  };

  /**
   * Run `first` in a transaction on `holder` and keep that transaction open,
   * its writes uncommitted, while `second` runs in a transaction of its own.
   * If `second` needs a lock `first` holds (a shared unique key), PostgreSQL
   * makes it wait for `first` to finish: the helper sees that wait in
   * pg_stat_activity, reports what it waited for, and commits `first` so
   * `second` can end.
   */
  async function overlap<F, S>(
    holder: PgPorts,
    first: () => Promise<F>,
    second: () => Promise<S>,
  ): Promise<{ first: F; second: S; waitedOn: string | null }> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markHeld!: () => void;
    const held = new Promise<void>((r) => (markHeld = r));
    const firstTx = holder.tx(async () => {
      const value = await first();
      markHeld();
      await gate;
      return value;
    });
    try {
      await Promise.race([held, firstTx]);
      let finished = false;
      const secondRun = second().finally(() => {
        finished = true;
      });
      let waitedOn: string | null = null;
      while (!finished) {
        const waits = await lockWaits();
        if (waits.length > 0) {
          waitedOn = waits.join(",");
          break;
        }
        await sleep(10);
      }
      release();
      const [firstValue, secondValue] = await Promise.all([firstTx, secondRun]);
      return { first: firstValue, second: secondValue, waitedOn };
    } finally {
      release(); // never leave a pooled connection inside an open transaction
    }
  }

  /**
   * Exactly one user and one membership hold `email`, both in the winner's
   * workspace. The loser got the generic conflict, kept no user, setup code
   * or audit event, and a later invitation from it still loses the same way.
   */
  async function expectOneStableWinner(email: string, winner: Side, loser: Side, loss: OpResult): Promise<void> {
    // The exact payload: no details, nothing that names the winner's workspace.
    expect(loss).toEqual(EMAIL_UNAVAILABLE);

    const users = await admin.pool.query("SELECT id, workspace_id, status FROM crm.users WHERE email = $1", [email]);
    expect(users.rows).toHaveLength(1);
    const userId = String(users.rows[0]!.id);
    expect(users.rows[0]).toMatchObject({ workspace_id: winner.ws, status: "pending" });
    const memberships = await admin.pool.query("SELECT workspace_id, role FROM crm.memberships WHERE user_id = $1", [userId]);
    expect(memberships.rows).toEqual([{ workspace_id: winner.ws, role: "member" }]);
    const codes = await admin.pool.query("SELECT user_id FROM crm.auth_codes WHERE email = $1", [email]);
    expect(codes.rows).toEqual([{ user_id: userId }]);

    expect(await loser.ports.users.getByEmail(email)).toBeNull();
    const loserAudit = await loser.ports.audit.list({ operation: "user.create", limit: 100, offset: 0 });
    expect(loserAudit.items.filter((e) => e.summary.includes(email))).toEqual([]);

    // Stable: the winner keeps the same user, and the loser cannot take it later.
    expect((await winner.ports.users.getByEmail(email))?.id).toBe(userId);
    expect(await invite(loser, email)).toEqual(EMAIL_UNAVAILABLE);
    expect((await admin.pool.query("SELECT id FROM crm.users WHERE email = $1", [email])).rows).toEqual([{ id: userId }]);
  }

  /**
   * Run one operation in A (held open, uncommitted) and in B at the same
   * time. Both must succeed, and B must never wait on A's write.
   */
  async function upsertInBoth<T>(name: string, inputFor: (side: Side) => unknown): Promise<[T, T]> {
    const { first, second, waitedOn } = await overlap(
      A.ports,
      () => call(A, name, inputFor(A)),
      () => call(B, name, inputFor(B)),
    );
    expect(waitedOn, `${name} in B waited on A's uncommitted write`).toBeNull();
    return [data<T>(first), data<T>(second)];
  }

  beforeAll(async () => {
    const rootUrl = process.env.DATABASE_URL!;
    root = await connectPg({ databaseUrl: rootUrl, max: 1 });
    await root.pool.query(`DROP DATABASE IF EXISTS ${RACE_DB} WITH (FORCE)`);
    await root.pool.query(`CREATE DATABASE ${RACE_DB}`);

    const adminUrl = new URL(rootUrl);
    adminUrl.pathname = `/${RACE_DB}`;
    admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 2 });
    // Roles are cluster-global; a parallel suite may race the guarded CREATE
    // ROLE block in schema.sql — retrying is safe (the file is one
    // transaction and the guard is idempotent per database).
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await initPgSchema(admin.pool);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        await sleep(500);
      }
    }
    if (lastError) throw lastError;
    await setTestRolePassword(admin.pool, "crm_app", APP_ROLE_TEST_PASSWORD);

    const appUrl = new URL(adminUrl.toString());
    appUrl.username = "crm_app";
    appUrl.password = APP_ROLE_TEST_PASSWORD;
    // One connection holds A's transaction open while another runs B's.
    app = await connectPg({ databaseUrl: appUrl.toString(), max: 4 });

    A = await seedSide("Race Workspace A", "owner@race-a.test");
    B = await seedSide("Race Workspace B", "owner@race-b.test");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin?.close();
    if (root) {
      await dropTestDatabase(root, RACE_DB).catch(() => {});
      await root.close();
    }
  });

  // ── Invitations: one email, one stable winner ─────────────────────────────

  it("an email invited into A and B at once has one winner; B waits on A's row, then gets only 'email unavailable'", async () => {
    const email = "contested@race.test";
    const { first, second, waitedOn } = await overlap(A.ports, () => invite(A, email), () => invite(B, email));
    // B's insert hit A's uncommitted row in the deployment-wide email index…
    expect(waitedOn).toBe("transactionid");
    expect(data<{ user: User }>(first).user.email).toBe(email);
    // …and lost once A committed.
    await expectOneStableWinner(email, A, B, second);
  });

  it("simultaneous invitations leave exactly one user, whichever workspace wins", async () => {
    for (let round = 0; round < 6; round += 1) {
      const email = `simultaneous-${round}@race.test`;
      // Alternate which workspace sends first so either one can win.
      const [x, y] = round % 2 === 0 ? [A, B] : [B, A];
      const [rx, ry] = await Promise.all([invite(x, email), invite(y, email)]);
      expect([rx, ry].filter((r) => r.status === "ok"), `round ${round}`).toHaveLength(1);
      if (rx.status === "ok") await expectOneStableWinner(email, x, y, ry);
      else await expectOneStableWinner(email, y, x, rx);
    }
  });

  // ── Upserts: per-workspace keys, so A and B never touch the same row ──────

  it("tag upserts with one name in A and B never conflict", async () => {
    const [tagA, tagB] = await upsertInBoth<Tag>("tag.create", () => ({ name: "Race VIP", color: "error" }));
    expect(tagA.id).not.toBe(tagB.id);
    const tagOf = (side: Side): Tag => (side === A ? tagA : tagB);
    const apply = (side: Side) => ({ tagId: tagOf(side).id, entityType: "company", entityId: side.companyId });
    await upsertInBoth("tag.apply", apply);

    // The second round finds each workspace's own rows again.
    const [againA, againB] = await upsertInBoth<Tag>("tag.create", () => ({ name: "Race VIP", color: "error" }));
    expect([againA.id, againB.id]).toEqual([tagA.id, tagB.id]);
    await upsertInBoth("tag.apply", apply);

    for (const side of [A, B]) {
      expect((await side.ports.tags.list()).filter((t) => t.name === "Race VIP").map((t) => t.id)).toEqual([tagOf(side).id]);
      expect((await side.ports.tags.forEntity("company", side.companyId)).map((t) => t.id)).toEqual([tagOf(side).id]);
    }
  });

  it("list upserts with one name in A and B never conflict", async () => {
    const [listA, listB] = await upsertInBoth<ContactList>("list.create", () => ({ name: "Race audience" }));
    expect(listA.id).not.toBe(listB.id);
    const listOf = (side: Side): ContactList => (side === A ? listA : listB);
    const add = (side: Side) => ({ listId: listOf(side).id, entityType: "company", entityIds: [side.companyId] });
    expect(await upsertInBoth("list.addMembers", add)).toEqual([
      { added: 1, alreadyPresent: 0 },
      { added: 1, alreadyPresent: 0 },
    ]);

    // The second round finds each workspace's own rows again.
    const [againA, againB] = await upsertInBoth<ContactList>("list.create", () => ({ name: "Race audience" }));
    expect([againA.id, againB.id]).toEqual([listA.id, listB.id]);
    expect(await upsertInBoth("list.addMembers", add)).toEqual([
      { added: 0, alreadyPresent: 1 },
      { added: 0, alreadyPresent: 1 },
    ]);

    for (const side of [A, B]) {
      expect((await side.ports.lists.list()).filter((l) => l.name === "Race audience").map((l) => l.id)).toEqual([listOf(side).id]);
      expect((await side.ports.lists.forEntity("company", side.companyId)).map((l) => l.id)).toEqual([listOf(side).id]);
    }
  });

  it("offering link upserts in A and B never conflict", async () => {
    const [offeringA, offeringB] = await upsertInBoth<Offering>("offering.create", () => ({ name: "Race Offering", type: "product" }));
    const offeringOf = (side: Side): Offering => (side === A ? offeringA : offeringB);
    const link = (fit: string) => (side: Side) => ({
      offeringId: offeringOf(side).id,
      entityType: "engagement",
      entityId: side.engagementId,
      fit,
    });
    const [linkA, linkB] = await upsertInBoth<OfferingLink>("offering.link", link("strong"));

    // The second round updates each workspace's own link in place.
    const [againA, againB] = await upsertInBoth<OfferingLink>("offering.link", link("weak"));
    expect([againA.id, againB.id]).toEqual([linkA.id, linkB.id]);

    for (const side of [A, B]) {
      const links = await side.ports.offerings.links("engagement", side.engagementId);
      expect(links.map((l) => [l.offeringId, l.fit])).toEqual([[offeringOf(side).id, "weak"]]);
    }
  });

  it("custom-value upserts under one field key in A and B never conflict", async () => {
    const field = { entityType: "company", label: "Race tier", type: "select", options: ["Gold", "Silver"] };
    const [defA, defB] = await upsertInBoth<CustomFieldDef>("customField.create", () => field);
    expect([defA.key, defB.key]).toEqual(["race-tier", "race-tier"]);
    const setTier = (tierA: string, tierB: string) => (side: Side) => ({
      entityType: "company",
      entityId: side.companyId,
      values: { "race-tier": side === A ? tierA : tierB },
    });
    await upsertInBoth("customField.setValues", setTier("Gold", "Silver"));

    // The second round swaps the values: each workspace updates its own row.
    await upsertInBoth("customField.setValues", setTier("Silver", "Gold"));

    expect(await A.ports.customFields.values("company", A.companyId)).toEqual({ "race-tier": "Silver" });
    expect(await B.ports.customFields.values("company", B.companyId)).toEqual({ "race-tier": "Gold" });
    const rows = await admin.pool.query(
      "SELECT workspace_id, field_id, value FROM crm.company_custom_field_values WHERE field_id = ANY($1::uuid[])",
      [[defA.id, defB.id]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { workspace_id: A.ws, field_id: defA.id, value: "Silver" },
        { workspace_id: B.ws, field_id: defB.id, value: "Gold" },
      ]),
    );
  });
});

describe.runIf(!enabled)("postgres races across workspaces (skipped)", () => {
  it.skip("set PG_TESTS=1 and DATABASE_URL (superuser) to run this suite", () => {});
});
