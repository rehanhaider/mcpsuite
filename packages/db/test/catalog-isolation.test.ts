/** Issue #48 contract: "Maintain an isolation-case registry whose keys must exactly equal the live catalog keys." */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCatalog, newId, nowIso, runOperation, toErrorPayload, type Ports } from "@mcpsuite/core";
import { initSchema, type Db } from "../src/connection.ts";
import * as schema from "../src/schema.ts";
import { createPorts } from "../src/repositories.ts";
import { connectPg, createPgPorts, provisionPgWorkspace, type PgHandle } from "../src/pg/repositories.ts";
import { initPgSchema } from "../src/pg/init.ts";
import { authServices, csvServices } from "../src/services.ts";
import { dropTestDatabase, setTestRolePassword } from "./pg-test-support.ts";
import { context, indistinguishable, isolationCases, noVictimData, ok, seed, SQL_TEXT, type CaseContext, type IsolationCase } from "./catalog-isolation-cases.ts";

const catalog = buildCatalog({ auth: authServices, csv: csvServices });
const enabled = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;

it("isolation registry keys exactly equal live catalog keys", () => {
  expect(Object.keys(isolationCases).sort()).toEqual([...catalog.keys()].sort());
});

it.each([
  new Error('select secret from crm.users violates constraint users_email_key'),
  'duplicate key value violates unique constraint',
  { message: 'SQL syntax error at column password_hash' },
])("hides unstructured driver errors: %s", (error) => {
  const payload = toErrorPayload(error);
  expect(payload).toEqual({ code: "internal", message: "An internal error occurred" });
  expect(payload.message).not.toMatch(SQL_TEXT);
});

describe.each(["sqlite", "postgres"] as const)("%s catalog workspace isolation", (adapter) => {
  describe.runIf(adapter === "sqlite" || enabled)("two-workspace cases", () => {
    let root: PgHandle;
    let admin: PgHandle;
    let app: PgHandle;
    let sqlite: Database.Database;
    let dir: string;
    let portsA: Ports;
    let portsB: Ports;
    let wsA: string;
    let wsB: string;
    let A: Awaited<ReturnType<typeof seed>>;
    const databaseName = `mcpsuite_catalog_${newId().replaceAll("-", "")}`;
    let pgSnapshotQuery: string;
    let pgSnapshotTables: string[];
    let sqliteSnapshotTables: Array<{ table: string; key: string }>;

    beforeAll(async () => {
      if (adapter !== "postgres") return;
      root = await connectPg({ databaseUrl: process.env.DATABASE_URL!, max: 1 });
      await root.pool.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${databaseName}`;
      admin = await connectPg({ databaseUrl: url.toString(), max: 2 });
      await initPgSchema(admin.pool);
      await setTestRolePassword(admin.pool, "crm_app", "crm_app_test_pw");
      url.username = "crm_app";
      url.password = "crm_app_test_pw";
      app = await connectPg({ databaseUrl: url.toString(), max: 2 });
      // A superuser would bypass row-level security and invalidate the test.
      const role = await app.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const columns = (await admin.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'crm' AND column_name IN ('workspace_id', 'user_id') ORDER BY table_name, column_name")).rows;
      const tables = new Map<string, string>();
      for (const { table_name, column_name } of columns) {
        const table = String(table_name);
        if (!tables.has(table) || column_name === "workspace_id") tables.set(table, String(column_name));
      }
      tables.set("workspaces", "id");
      pgSnapshotTables = [...tables.keys()].sort();
      pgSnapshotQuery = [...tables].map(([table, column]) =>
        `SELECT '${table}' AS name, to_jsonb(r) AS data FROM crm."${table}" r WHERE "${column}" = $${column === "user_id" ? 2 : 1}::uuid`,
      ).join(" UNION ALL ");
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await admin?.close();
      if (root) {
        await dropTestDatabase(root, databaseName);
        await root.close();
      }
    });

    beforeEach(async () => {
      if (adapter === "sqlite") {
        dir = mkdtempSync(join(tmpdir(), "mcpsuite-catalog-isolation-"));
        sqlite = new Database(join(dir, "test.db"));
        sqlite.pragma("journal_mode = WAL");
        sqlite.pragma("synchronous = NORMAL");
        sqlite.pragma("foreign_keys = ON");
        initSchema(sqlite);
        const db = drizzle(sqlite, { schema }) as Db;
        const provision = (name: string) => {
          const id = newId();
          db.insert(schema.workspaces).values({ id, name, defaultCurrency: "USD", timezone: "UTC", settings: "{}", createdAt: nowIso(), updatedAt: nowIso() }).run();
          return id;
        };
        wsA = provision("Alpha workspace");
        wsB = provision("Beta workspace");
        portsA = createPorts(db, wsA);
        portsB = createPorts(db, wsB);
        sqliteSnapshotTables = [];
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
        for (const { name } of tables) {
          const columns = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
          const has = (col: string) => columns.some((c) => c.name === col);
          const key = has("workspace_id") ? "workspace_id" : name === "workspaces" || name === "users" ? "id" : has("user_id") ? "user_id" : null;
          if (key) sqliteSnapshotTables.push({ table: name, key });
        }
      } else {
        wsA = await provisionPgWorkspace(app.db, { name: "Alpha workspace" });
        wsB = await provisionPgWorkspace(app.db, { name: "Beta workspace" });
        portsA = createPgPorts(app.db, wsA);
        portsB = createPgPorts(app.db, wsB);
      }
      A = await seed(portsA, "Alpha");
    });

    afterEach(() => {
      sqlite?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /** Read every victim-owned row, including associations, counters and audit/auth records. */
    async function snapshotB(userId: string): Promise<string> {
      const snapshot: Record<string, unknown[]> = {};
      if (adapter === "sqlite") {
        for (const { table, key } of sqliteSnapshotTables) {
          const id = key === "workspace_id" || table === "workspaces" ? wsB : userId;
          snapshot[table] = sqlite.prepare(`SELECT * FROM "${table}" WHERE "${key}" = ?`).all(id);
        }
      } else {
        for (const table of pgSnapshotTables) snapshot[table] = [];
        const rows = (await admin.pool.query(pgSnapshotQuery, [wsB, userId])).rows;
        for (const row of rows) snapshot[String(row.name)]!.push(row.data);
      }
      // Stable row order, but no field or timestamp normalization: B must be byte-identical.
      return JSON.stringify(Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.map((row) => JSON.stringify(row)).sort()])));
    }

    for (const [name, testCase] of Object.entries(isolationCases) as Array<[string, IsolationCase]>) {
      it(name, async () => {
        const owner = context(wsA, A.user.id);
        const run: CaseContext["run"] = (operation, input = {}, ctx = owner) => runOperation(catalog, portsA, ctx, operation, input);
        const readInputs = testCase.reads?.(A) ?? [];
        // Capture exact A-only results before any victim rows exist. This catches count leaks too.
        const baseline = [];
        for (const input of readInputs) baseline.push(ok(await run(name, input)));
        const B = await seed(portsB, "Beta");
        const ctx: CaseContext = {
          A, B, ports: portsA, run, owner, adapter, snapshotB: () => snapshotB(B.user.id),
          // Change only the fixture filter bytes, so paired run outcomes can be
          // compared without ignoring generated view IDs or update timestamps.
          setViewFilters: async (id, filters) => {
            if (adapter === "sqlite") {
              sqlite.prepare("UPDATE saved_views SET filters = ? WHERE workspace_id = ? AND id = ?").run(JSON.stringify(filters), wsA, id);
            } else {
              await admin.pool.query("UPDATE crm.saved_views SET filters = $1::jsonb WHERE workspace_id = $2 AND id = $3", [JSON.stringify(filters), wsA, id]);
            }
          },
        };
        const before = await ctx.snapshotB();
        for (let i = 0; i < readInputs.length; i++) {
          const result = ok(await run(name, readInputs[i]));
          expect(result).toEqual(baseline[i]);
          // Import preview echoes the caller's CSV; the A-only comparison checks its match counts.
          if (name !== "import.preview") noVictimData(result, B);
        }
        for (const attack of testCase.attacks?.(A, B) ?? []) {
          // A malformed input would test validation instead of database isolation.
          expect(catalog.get(name)!.input.safeParse(attack.input(attack.id)).success).toBe(true);
          await indistinguishable(ctx, name, attack);
        }
        await testCase.check?.(ctx, name);
        expect(await ctx.snapshotB(), `${name}: victim rows changed`).toBe(before);
      }, 30_000);
    }
  });
});
