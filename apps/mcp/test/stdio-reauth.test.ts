/**
 * The stdio transport re-checks its API key on EVERY call, end to end: this
 * spawns the real src/stdio.ts process exactly like production (tsx +
 * MCPSUITE_API_KEY) and speaks newline-delimited JSON-RPC over its
 * stdin/stdout, while this parent process changes the key and its creator
 * mid-session:
 *
 *   - the key is revoked                → tool calls and resource reads fail;
 *   - the creator is disabled           → tool calls and resource reads fail;
 *   - the creator is demoted to member  → scopes are clamped (admin-scope
 *                                         tools are forbidden, the rest work).
 *
 * The SQLite half always runs against a temp file (never data/). The
 * PostgreSQL half runs the same scenarios with PG_TESTS=1 and a superuser
 * DATABASE_URL, the stdio child connected as crm_app under forced RLS:
 *
 *   cd apps/mcp && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run stdio-reauth
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpResult, Ports, RequestContext } from "@mcpsuite/core";
import { createRuntime, openDatabase, seedPgWorkspaceWithOwner } from "@mcpsuite/db";
import { connectPg, type PgHandle } from "../../../packages/db/src/pg/repositories.ts";
import { initPgSchema } from "../../../packages/db/src/pg/init.ts";
import { createPgRuntime } from "../../../packages/db/src/pg/runtime.ts";
import { dropTestDatabase, setTestRolePassword } from "../../../packages/db/test/pg-test-support.ts";
import { UNAUTHORIZED_RPC_CODE } from "../src/server.ts";
import { startStdio, type StdioChild } from "./stdio-client.ts";

function errorCode(payload: unknown): string | undefined {
  return (payload as { error?: { code?: string } }).error?.code;
}

// ---------------------------------------------------------------------------
// Adapters: what the parent needs to mint keys and change state mid-session
// ---------------------------------------------------------------------------

interface Harness {
  /** Environment that points a stdio child at this database. */
  childEnv(apiKey: string): NodeJS.ProcessEnv;
  run(ctx: RequestContext, operation: string, input: unknown): Promise<OpResult>;
  ports: Ports;
  owner: RequestContext;
  close(): Promise<void>;
}

function humanContext(workspaceId: string, userId: string, role: RequestContext["role"]): RequestContext {
  return {
    workspaceId,
    actorType: "human",
    userId,
    clientId: null,
    role,
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "web",
  };
}

async function sqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mcpsuite-stdio-reauth-"));
  const dbPath = join(dir, "stdio-reauth.db");
  // Bootstrap in the parent (keeps the one-time owner-password log off the
  // child's protocol stdout).
  const db = openDatabase(dbPath);
  const runtime = createRuntime(db);
  const { workspaceId, ownerUserId } = runtime.bootstrapResult;
  // Bootstrap creates the owner PENDING; a key is only live while its
  // creator is active — simulate the completed first login.
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(ownerUserId);
  return {
    childEnv: (apiKey) => {
      const env = { ...process.env, DB_PATH: dbPath, MCPSUITE_API_KEY: apiKey } as NodeJS.ProcessEnv;
      delete env.DATABASE_URL; // unset -> SQLite at DB_PATH
      return env;
    },
    run: runtime.run,
    ports: runtime.portsFor(workspaceId),
    owner: humanContext(workspaceId, ownerUserId, "owner"),
    close: async () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PG_ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const PG_DB = "mcpsuite_mcp_stdio_reauth";
const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as the other pg suites

async function pgHarness(): Promise<Harness> {
  const rootUrl = process.env.DATABASE_URL!;
  const root: PgHandle = await connectPg({ databaseUrl: rootUrl, max: 1 });
  await root.pool.query(`DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE)`);
  await root.pool.query(`CREATE DATABASE ${PG_DB}`);
  const adminUrl = new URL(rootUrl);
  adminUrl.pathname = `/${PG_DB}`;
  const admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 1 });
  try {
    await initPgSchema(admin.pool);
    await setTestRolePassword(admin.pool, "crm_app", APP_ROLE_TEST_PASSWORD);
  } finally {
    await admin.close();
  }
  const appUrl = new URL(adminUrl.toString());
  appUrl.username = "crm_app";
  appUrl.password = APP_ROLE_TEST_PASSWORD;
  // seedPgWorkspaceWithOwner creates an ACTIVE owner.
  const seed = await seedPgWorkspaceWithOwner(appUrl.toString(), {
    workspaceName: "Stdio reauth",
    ownerEmail: "owner@stdio-reauth.test",
    ownerName: "Owner",
  });
  const runtime = await createPgRuntime({ databaseUrl: appUrl.toString(), max: 2 });
  return {
    childEnv: (apiKey) => ({ ...process.env, DATABASE_URL: appUrl.toString(), MCPSUITE_API_KEY: apiKey }),
    run: runtime.run,
    ports: runtime.portsFor(seed.workspaceId),
    owner: humanContext(seed.workspaceId, seed.userId, "owner"),
    close: async () => {
      await runtime.close();
      await dropTestDatabase(root, PG_DB).catch(() => {});
      await root.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The scenarios, run against each adapter
// ---------------------------------------------------------------------------

function ok<T>(result: OpResult): T {
  if (result.status !== "ok") throw new Error(`operation failed: ${JSON.stringify(result)}`);
  return result.data as T;
}

function describeAdapter(name: string, enabled: boolean, makeHarness: () => Promise<Harness>): void {
  describe.runIf(enabled)(`stdio transport re-checks its API key per call — ${name} (real child process)`, () => {
    let harness: Harness;
    const children: StdioChild[] = [];
    let userSeq = 0;

    beforeAll(async () => {
      harness = await makeHarness();
    }, 120_000);

    afterAll(async () => {
      for (const child of children) child.close();
      await harness?.close();
    });

    /** An active user with a membership, as the human context they act in. */
    async function activeUser(role: "admin"): Promise<RequestContext> {
      userSeq += 1;
      const user = await harness.ports.users.create({
        name: `Creator ${userSeq}`,
        email: `creator${userSeq}@stdio-reauth.test`,
        role,
        passwordHash: null,
      });
      return humanContext(harness.owner.workspaceId, user.id, role);
    }

    /** Mint a key as `creator` and start a stdio child with it. */
    async function stdioFor(
      creator: RequestContext,
      scopes: RequestContext["scopes"],
    ): Promise<{ child: StdioChild; clientId: string }> {
      const created = ok<{ client: { id: string }; token: string }>(
        await harness.run(creator, "mcpClient.create", { name: `key ${children.length}`, scopes, trust: "trusted_agent" }),
      );
      const child = await startStdio(harness.childEnv(created.token));
      children.push(child);
      return { child, clientId: created.client.id };
    }

    async function companyCount(): Promise<number> {
      return ok<{ total: number }>(await harness.run(harness.owner, "company.list", {})).total;
    }

    async function expectRefused(child: StdioChild): Promise<void> {
      const before = await companyCount();
      const call = await child.callTool("company_create", { name: "After the key stopped working" });
      expect(call.isError).toBe(true);
      expect(errorCode(call.payload)).toBe("unauthorized");
      expect(await companyCount()).toBe(before);

      for (const uri of ["mcpsuite://pipelines", "mcpsuite://catalog"]) {
        const read = await child.request("resources/read", { uri });
        expect(read.result).toBeUndefined();
        expect(read.error?.code).toBe(UNAUTHORIZED_RPC_CODE);
      }
    }

    it("refuses tool calls and resource reads once the key is revoked (no restart)", async () => {
      const { child, clientId } = await stdioFor(harness.owner, ["read", "write"]);
      expect((await child.callTool("company_create", { name: "Before revoke" })).isError).toBe(false);

      ok(await harness.run(harness.owner, "mcpClient.revoke", { id: clientId }));

      await expectRefused(child);
    }, 60_000);

    it("refuses tool calls and resource reads once the creator is disabled (no restart)", async () => {
      const creator = await activeUser("admin");
      const { child } = await stdioFor(creator, ["read", "write"]);
      expect((await child.callTool("company_create", { name: "Before disable" })).isError).toBe(false);

      // Through the port, not user.update: that op also revokes the
      // creator's keys, which would hide whether the creator itself is
      // re-checked.
      await harness.ports.users.update(creator.userId!, { disabledAt: new Date().toISOString() });

      await expectRefused(child);
    }, 60_000);

    it("clamps scopes to the creator's new role once the creator is demoted (no restart)", async () => {
      const creator = await activeUser("admin");
      const { child } = await stdioFor(creator, ["read", "write", "admin"]);
      expect((await child.callTool("audit_list", {})).isError).toBe(false);

      ok(await harness.run(harness.owner, "user.update", { id: creator.userId, role: "member" }));

      const audit = await child.callTool("audit_list", {});
      expect(audit.isError).toBe(true);
      expect(errorCode(audit.payload)).toBe("forbidden");
      // Still authenticated: what a member may do keeps working.
      expect((await child.callTool("company_list", {})).isError).toBe(false);
      const pipelines = await child.request("resources/read", { uri: "mcpsuite://pipelines" });
      expect(pipelines.error).toBeUndefined();
    }, 60_000);
  });
}

describeAdapter("SQLite", true, sqliteHarness);
describeAdapter("PostgreSQL", PG_ENABLED, pgHarness);
if (!PG_ENABLED) {
  describe("stdio transport re-checks its API key per call — PostgreSQL", () => {
    it.skip("set PG_TESTS=1 and DATABASE_URL (superuser) to run this suite", () => {});
  });
}
