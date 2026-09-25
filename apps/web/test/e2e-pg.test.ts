/**
 * Issue #4 step 8 on PostgreSQL: the sign-in-to-MCP flow (./e2e-flow.ts)
 * against a dedicated database, with the web runtime connected as crm_app
 * under forced row-level security.
 *
 *   cd apps/web && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run e2e-pg
 *
 * DATABASE_URL must be a superuser: the harness creates the database and sets
 * crm_app's password, then points the runtime at crm_app. PostgreSQL has no
 * first-boot setup, so seedPgWorkspaceWithOwner creates an ACTIVE owner with
 * no sign-in linked: this run covers the owner-recovery path. First-time setup
 * of a pending owner on PostgreSQL is covered in #5 (hosting control).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { getRuntimeAsync, seedPgWorkspaceWithOwner, type SeededPgWorkspace } from "@mcpsuite/db";
import { connectPg, type PgHandle } from "../../../packages/db/src/pg/repositories.ts";
import { initPgSchema } from "../../../packages/db/src/pg/init.ts";
import { runSignInToMcpFlow } from "./e2e-flow.ts";

const ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const ROOT_URL = process.env.DATABASE_URL ?? "";
const E2E_DB = "mcpsuite_web_e2e";
const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as the db package's pg suites

describe.runIf(ENABLED)("sign-in to MCP, end to end — PostgreSQL (crm_app under forced RLS)", () => {
  let root: PgHandle;
  let seed: SeededPgWorkspace;

  beforeAll(async () => {
    root = await connectPg({ databaseUrl: ROOT_URL, max: 1 });
    await root.pool.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await root.pool.query(`CREATE DATABASE ${E2E_DB}`);
    const adminUrl = new URL(ROOT_URL);
    adminUrl.pathname = `/${E2E_DB}`;
    const admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 1 });
    try {
      await initPgSchema(admin.pool);
      await admin.pool.query(`ALTER ROLE crm_app WITH PASSWORD '${APP_ROLE_TEST_PASSWORD}'`);
    } finally {
      await admin.close();
    }
    const appUrl = new URL(adminUrl.toString());
    appUrl.username = "crm_app";
    appUrl.password = APP_ROLE_TEST_PASSWORD;

    // The web runtime (getRuntimeAsync, used by every route) selects its
    // adapter from DATABASE_URL on first use: point it at crm_app.
    process.env.DATABASE_URL = appUrl.toString();
    seed = await seedPgWorkspaceWithOwner(appUrl.toString(), {
      workspaceName: "E2E",
      ownerEmail: "owner@e2e-pg.test",
      ownerName: "E2E Owner",
    });
  }, 120_000);

  afterAll(async () => {
    const runtime = await getRuntimeAsync().catch(() => null);
    if (runtime && runtime.adapter === "postgres") await runtime.close();
    if (root) {
      await root.pool.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`).catch(() => {});
      await root.close();
    }
  });

  it("setup code → sign in → /api/me → /api/ops → API key → MCP tool", async () => {
    await runSignInToMcpFlow({ email: seed.email, setupCode: seed.setupCode, workspaceId: seed.workspaceId });
  });
});
