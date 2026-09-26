/**
 * Issue #5 step 8 on PostgreSQL: the hosted workspace lifecycle
 * (./e2e-hosting-flow.ts) against a dedicated database, with the web runtime
 * connected as crm_app and hosting control as crm_operator — each with its
 * own DATABASE_URL, both under forced row-level security.
 *
 *   cd apps/web && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55442/postgres \
 *     mise exec -- pnpm vitest run e2e-hosting-pg
 *
 * DATABASE_URL must be a superuser: the harness creates the database and sets
 * the two roles' passwords, and reads rows with full visibility to check
 * deletion.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { getRuntimeAsync } from "@mcpsuite/db";
import { connectPg, type PgHandle } from "../../../packages/db/src/pg/repositories.ts";
import { initPgSchema } from "../../../packages/db/src/pg/init.ts";
import { dropTestDatabase, setTestRolePassword } from "../../../packages/db/test/pg-test-support.ts";
import { runHostingLifecycleFlow } from "./e2e-hosting-flow.ts";

const ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const ROOT_URL = process.env.DATABASE_URL ?? "";
const E2E_DB = "mcpsuite_web_e2e_hosting";
const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constants as the db and hosting-control pg suites
const OPERATOR_ROLE_TEST_PASSWORD = "crm_operator_test_pw";


describe.runIf(ENABLED)("hosted workspace lifecycle, end to end — PostgreSQL", () => {
  let root: PgHandle;
  let admin: PgHandle;
  let operatorUrl: string;

  beforeAll(async () => {
    root = await connectPg({ databaseUrl: ROOT_URL, max: 1 });
    await root.pool.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await root.pool.query(`CREATE DATABASE ${E2E_DB}`);
    const adminUrl = new URL(ROOT_URL);
    adminUrl.pathname = `/${E2E_DB}`;
    admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 1 });
    await initPgSchema(admin.pool);
    await setTestRolePassword(admin.pool, "crm_app", APP_ROLE_TEST_PASSWORD);
    await setTestRolePassword(admin.pool, "crm_operator", OPERATOR_ROLE_TEST_PASSWORD);

    const appUrl = new URL(adminUrl.toString());
    appUrl.username = "crm_app";
    appUrl.password = APP_ROLE_TEST_PASSWORD;
    const operator = new URL(adminUrl.toString());
    operator.username = "crm_operator";
    operator.password = OPERATOR_ROLE_TEST_PASSWORD;
    operatorUrl = operator.toString();
    // The web runtime (getRuntimeAsync, used by every route) selects its
    // adapter from DATABASE_URL on first use: point it at crm_app.
    process.env.DATABASE_URL = appUrl.toString();
  }, 120_000);

  afterAll(async () => {
    const runtime = await getRuntimeAsync().catch(() => null);
    if (runtime && runtime.adapter === "postgres") await runtime.close();
    await admin?.close();
    if (root) {
      await dropTestDatabase(root, E2E_DB).catch(() => {});
      await root.close();
    }
  });

  it("provision → setup code → sign in → lock refused → unlock → transfer → delete", async () => {
    const count = async (sql: string, value: string): Promise<number> =>
      Number((await admin.pool.query(sql, [value])).rows[0]?.c ?? 0);
    await runHostingLifecycleFlow({
      adapter: "postgres",
      hostingEnv: { DATABASE_URL: operatorUrl },
      workspaceRows: (workspaceId) => count("SELECT COUNT(*)::int AS c FROM crm.workspaces WHERE id::text = $1", workspaceId),
      serviceAuditRows: (by) =>
        "workspaceId" in by
          ? count("SELECT COUNT(*)::int AS c FROM hosting.service_audit WHERE workspace_id = $1", by.workspaceId)
          : count("SELECT COUNT(*)::int AS c FROM hosting.service_audit WHERE target_hash = $1", by.targetHash),
    });
  }, 120_000);
});
