/**
 * Contract suite for the identity adapter interface (src/identity.ts): the
 * same tests run against the SQLite adapter and, with PG_TESTS=1 and a
 * superuser DATABASE_URL, the PostgreSQL adapter connected as crm_app under
 * forced row-level security (issue #4, step 7).
 *
 *   cd packages/db && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run identity-contract
 *
 * Without PG_TESTS the PostgreSQL half self-skips; the SQLite half always runs.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog, type Ports, type RequestContext } from "@mcpsuite/core";
import { openDatabase, type Db } from "../src/connection.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { createPorts } from "../src/repositories.ts";
import { createSqliteIdentity } from "../src/sqlite-identity.ts";
import { runGated } from "../src/gated-run.ts";
import { authServices, csvServices } from "../src/services.ts";
import { AUTH_CODE_ISSUE_MAX, AUTH_CODE_MAX_ATTEMPTS, joinAuthKey } from "../src/openauth.ts";
import type { IdentityStore, IdentityTestHooks } from "../src/identity.ts";
import { connectPg, createPgPorts, provisionPgWorkspace, type PgHandle } from "../src/pg/repositories.ts";
import { createPgIdentity } from "../src/pg/identity.ts";
import { createPgRuntime } from "../src/pg/runtime.ts";
import { dropTestDatabase, setTestRolePassword } from "./pg-test-support.ts";
import { createRuntime } from "../src/runtime.ts";
import { initPgSchema } from "../src/pg/init.ts";

const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");
const RANDOM_ID = "01890000-0000-7000-8000-00000000beef"; // valid uuid, never inserted
const catalog = buildCatalog({ auth: authServices, csv: csvServices });

interface Harness {
  identity: IdentityStore;
  hooked(hooks: IdentityTestHooks): IdentityStore;
  portsFor(workspaceId: string): Ports;
  workspaceId: string;
  /** Lock the workspace the way hosting control does. */
  lockWorkspace: () => void | Promise<void>;
  /** Run a catalog query as the runtime role (PostgreSQL only). */
  catalogQuery: ((text: string) => Promise<Array<Record<string, unknown>>>) | null;
  /** SQLite only: the database file, for a second (other-process) connection. */
  sqliteFile: string | null;
  /** The adapter's real runtime over the same database. */
  runtime(): Promise<{ run: (ctx: RequestContext, operation: string, input: unknown) => Promise<unknown>; close(): Promise<void> }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

async function sqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mcpsuite-identity-contract-"));
  const db: Db = openDatabase(join(dir, "contract.db"));
  const { workspaceId } = bootstrap(db, { ownerEmail: "owner@contract.test", ownerName: "Owner" });
  return {
    identity: createSqliteIdentity(db),
    hooked: (hooks) => createSqliteIdentity(db, { hooks }),
    portsFor: (ws) => createPorts(db, ws),
    workspaceId,
    lockWorkspace: () => {
      // Same table shape hosting control creates (its own store owns it).
      db.$client.exec(`CREATE TABLE IF NOT EXISTS hc_workspace_access (
        workspace_id TEXT PRIMARY KEY, access_mode TEXT NOT NULL DEFAULT 'active',
        access_expires_at TEXT, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      const now = new Date().toISOString();
      db.$client
        .prepare(
          `INSERT INTO hc_workspace_access (workspace_id, access_mode, version, created_at, updated_at)
           VALUES (?, 'locked', 1, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET access_mode = 'locked'`,
        )
        .run(workspaceId, now, now);
    },
    catalogQuery: null,
    sqliteFile: join(dir, "contract.db"),
    runtime: async () => ({ run: createRuntime(db).run, close: async () => {} }),
    close: async () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PG_ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const CONTRACT_DB = "mcpsuite_identity_contract";
const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as the other pg suites

async function pgHarness(): Promise<Harness> {
  const rootUrl = process.env.DATABASE_URL!;
  const root = await connectPg({ databaseUrl: rootUrl, max: 1 });
  await root.pool.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB} WITH (FORCE)`);
  await root.pool.query(`CREATE DATABASE ${CONTRACT_DB}`);
  const adminUrl = new URL(rootUrl);
  adminUrl.pathname = `/${CONTRACT_DB}`;
  const admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 1 });
  // Roles are cluster-global: a parallel pg suite may race the guarded
  // CREATE ROLE block. Retrying is safe (one transaction, idempotent guard).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await initPgSchema(admin.pool);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastError) throw lastError;
  await setTestRolePassword(admin.pool, "crm_app", APP_ROLE_TEST_PASSWORD);
  const appUrl = new URL(adminUrl.toString());
  appUrl.username = "crm_app";
  appUrl.password = APP_ROLE_TEST_PASSWORD;
  const app: PgHandle = await connectPg({ databaseUrl: appUrl.toString(), max: 4 });
  const workspaceId = await provisionPgWorkspace(app.db, { name: "Contract" });
  return {
    identity: createPgIdentity(app.db),
    hooked: (hooks) => createPgIdentity(app.db, { hooks }),
    portsFor: (ws) => createPgPorts(app.db, ws) as unknown as Ports,
    workspaceId,
    // Hosting control's access row, written as the superuser (crm_app has no
    // access to the hosting schema).
    lockWorkspace: async () => {
      await admin.pool.query(
        `INSERT INTO hosting.workspace_access (workspace_id, access_mode, created_at, updated_at)
         VALUES ($1, 'locked', now(), now())
         ON CONFLICT (workspace_id) DO UPDATE SET access_mode = 'locked'`,
        [workspaceId],
      );
    },
    catalogQuery: async (text) => (await app.pool.query(text)).rows,
    sqliteFile: null,
    runtime: async () => {
      const pg = await createPgRuntime({ databaseUrl: appUrl.toString() });
      return { run: pg.run, close: () => pg.close() };
    },
    close: async () => {
      await app.close();
      await admin.close();
      await dropTestDatabase(root, CONTRACT_DB).catch(() => {});
      await root.close();
    },
  };
}

const ADAPTERS: Array<{ name: "sqlite" | "postgres"; enabled: boolean; make: () => Promise<Harness> }> = [
  { name: "sqlite", enabled: true, make: sqliteHarness },
  { name: "postgres", enabled: PG_ENABLED, make: pgHarness },
];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

for (const adapter of ADAPTERS) {
  describe.runIf(adapter.enabled)(`identity contract — ${adapter.name}`, () => {
    let h: Harness;
    let ports: Ports;
    let identity: IdentityStore;
    let seq = 0;

    beforeAll(async () => {
      h = await adapter.make();
      ports = h.portsFor(h.workspaceId);
      identity = h.identity;
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    const email = (tag: string): string => `${tag}-${++seq}@contract.test`;
    const pendingUser = async (tag: string): Promise<{ id: string; email: string }> => {
      const address = email(tag);
      const { userId } = await ports.users.createPending({ email: address, name: tag, role: "member" });
      return { id: userId, email: address };
    };
    /** Pending user → first sign-in: active with a bound subject. */
    const activeUser = async (tag: string): Promise<{ id: string; email: string; subject: string }> => {
      const user = await pendingUser(tag);
      const linked = await identity.resolveAuthSuccess(user.email);
      if (linked.status !== "linked") throw new Error(`expected linked, got ${linked.status}`);
      return { ...user, subject: linked.subject };
    };
    const disable = (userId: string) => ports.users.update(userId, { disabledAt: new Date().toISOString() });
    const ctxFor = (userId: string): RequestContext => ({
      workspaceId: h.workspaceId,
      actorType: "human",
      userId,
      clientId: null,
      role: "member",
      scopes: ["read", "write", "admin", "approvals"],
      trust: "fully_authorized_agent",
      surface: "web",
    });

    // ── sessions ────────────────────────────────────────────────────────────

    describe("sessions", () => {
      it("create → resolve to the current user → destroy revokes the refresh token", async () => {
        const user = await activeUser("sess");
        const refreshKey = joinAuthKey(["oauth:refresh", user.subject, "r1"]);
        await identity.authKv.set(refreshKey, JSON.stringify({ t: 1 }), null);
        const { token } = await identity.createSession(user.id, {
          authSubject: user.subject,
          authRefresh: `${user.subject}:r1`,
        });
        const session = await identity.resolveSession(token);
        expect(session).toMatchObject({ workspaceId: h.workspaceId, authSubject: user.subject, passwordMustChange: false });
        expect(session!.user).toMatchObject({ id: user.id, email: user.email, status: "active" });

        await identity.destroySession(token);
        expect(await identity.resolveSession(token)).toBeNull();
        expect(await identity.authKv.get(refreshKey)).toBeNull();
      });

      it("never resolves pending or disabled users, or unknown tokens", async () => {
        const pending = await pendingUser("sess-pending");
        const { token: pendingToken } = await identity.createSession(pending.id);
        expect(await identity.resolveSession(pendingToken)).toBeNull();

        const active = await activeUser("sess-disabled");
        const { token } = await identity.createSession(active.id);
        expect(await identity.resolveSession(token)).not.toBeNull();
        await disable(active.id);
        expect(await identity.resolveSession(token)).toBeNull();

        expect(await identity.resolveSession("sess_unknown")).toBeNull();
        expect(await identity.resolveSession(null)).toBeNull();
      });

      it("a user-less session surfaces as unprovisioned", async () => {
        const address = email("unprov");
        const { token } = await identity.createSession(null, { email: address, authSubject: "acct_unprovisioned_1" });
        expect(await identity.resolveSessionAny(token)).toEqual({
          unprovisioned: true,
          email: address,
          authSubject: "acct_unprovisioned_1",
        });
        expect(await identity.resolveSession(token)).toBeNull();
      });

      it("adopts the user by email once it exists: binds the subject and upgrades the row", async () => {
        const address = email("adopt");
        const subject = `acct_adopt_${seq}`;
        const { token } = await identity.createSession(null, { email: address, authSubject: subject });
        // The user appears later, active and not yet linked (owner recovery shape).
        const created = await ports.users.create({ name: "Adopted", email: address, role: "member", passwordHash: null });

        const adopted = await identity.resolveSessionAny(token);
        expect(adopted).toMatchObject({ workspaceId: h.workspaceId, authSubject: subject });
        expect((adopted as { user: { id: string } }).user.id).toBe(created.id);
        expect(await identity.findUserByAuthSubject(subject)).toMatchObject({ id: created.id, workspaceId: h.workspaceId });
        // The row was upgraded in place: it resolves as a user from now on.
        expect((await identity.resolveSession(token))!.user.id).toBe(created.id);
      });

      it("deletes a user-less session whose email user bound a different subject", async () => {
        const user = await activeUser("conflict");
        const { token } = await identity.createSession(null, { email: user.email, authSubject: "acct_someone_else" });
        expect(await identity.resolveSessionAny(token)).toBeNull();
        // Deleted, not just refused: it stays gone.
        expect(await identity.resolveSessionAny(token)).toBeNull();
        expect(await identity.findUserByAuthSubject("acct_someone_else")).toBeNull();
      });

      it("the cross-workspace lookups return fixed identity fields only, never profile data", async () => {
        // PostgreSQL: the SECURITY DEFINER lookups must not hand the runtime
        // role names or password material (a profile is read afterwards,
        // under row-level security, inside the resolved workspace).
        if (!h.catalogQuery) return;
        for (const fn of ["identity_by_email(text)", "identity_by_subject(text)", "identity_by_user_id(uuid)"]) {
          const [row] = await h.catalogQuery(`SELECT pg_get_function_result('crm.${fn}'::regprocedure) AS result`);
          const columns = String(row?.result)
            .replace(/^TABLE\(|\)$/g, "")
            .split(",")
            .map((c) => c.trim().split(" ")[0]);
          expect(columns.sort(), fn).toEqual(
            ["auth_subject", "disabled_at", "email", "password_must_change", "role", "status", "user_id", "workspace_id"].sort(),
          );
        }
      });

      it("two sessions racing to adopt one user bind exactly one subject", async () => {
        for (let i = 0; i < 5; i += 1) {
          const address = email("adopt-race");
          const first = await identity.createSession(null, { email: address, authSubject: `acct_race_a_${seq}` });
          const second = await identity.createSession(null, { email: address, authSubject: `acct_race_b_${seq}` });
          const created = await ports.users.create({ name: "Raced", email: address, role: "member", passwordHash: null });
          const [a, b] = await Promise.all([identity.resolveSessionAny(first.token), identity.resolveSessionAny(second.token)]);
          const winners = [a, b].filter((r) => r !== null);
          expect(winners).toHaveLength(1);
          const winner = winners[0] as { user: { id: string }; authSubject: string };
          expect(winner.user.id).toBe(created.id);
          expect(await identity.findUserByAuthSubject(winner.authSubject)).toMatchObject({ id: created.id });
          const loserSubject = a === null ? `acct_race_a_${seq}` : `acct_race_b_${seq}`;
          expect(await identity.findUserByAuthSubject(loserSubject)).toBeNull();
        }
      });

      it("endUserSessions ends every session of the user", async () => {
        const user = await activeUser("end");
        const a = await identity.createSession(user.id);
        const b = await identity.createSession(user.id);
        expect(await identity.endUserSessions(h.workspaceId, user.id)).toBe(2);
        expect(await identity.resolveSession(a.token)).toBeNull();
        expect(await identity.resolveSession(b.token)).toBeNull();
        await expect(identity.endUserSessions(h.workspaceId, RANDOM_ID)).rejects.toMatchObject({ code: "not_found" });
      });
    });

    // ── setup/reset codes ───────────────────────────────────────────────────

    describe("codes", () => {
      it("are single-use and superseded on reissue", async () => {
        const user = await pendingUser("code");
        const first = await identity.issueCode(h.workspaceId, user.id, "setup");
        const second = await identity.issueCode(h.workspaceId, user.id, "setup");
        expect(Date.parse(second.expiresAt)).toBeGreaterThan(Date.now());
        expect(await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code: first.code })).toEqual({
          ok: false,
          reason: "invalid_code",
        });
        expect(
          await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code: second.code.toLowerCase() }),
        ).toEqual({ ok: true, userId: user.id });
        expect(await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code: second.code })).toEqual({
          ok: false,
          reason: "invalid_code",
        });
      });

      it("burn the active code at the attempt cap", async () => {
        const user = await pendingUser("attempts");
        const { code } = await identity.issueCode(h.workspaceId, user.id, "setup");
        let last: unknown = null;
        for (let i = 0; i < AUTH_CODE_MAX_ATTEMPTS; i += 1) {
          last = await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code: "WRNG-WRNG-WRNG" });
        }
        expect(last).toEqual({ ok: false, reason: "rate_limited" });
        expect((await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code })).ok).toBe(false);
      });

      it("rate-limit issuance through the operations' port too (user.resetPassword & co.)", async () => {
        const user = await pendingUser("port-limit");
        for (let i = 0; i < AUTH_CODE_ISSUE_MAX; i += 1) await ports.credentials.issueCode(user.id, "setup");
        await expect(ports.credentials.issueCode(user.id, "setup")).rejects.toMatchObject({ code: "conflict" });
      });

      it("rate-limit issuance per email and refuse users outside the workspace", async () => {
        const user = await pendingUser("issue-limit");
        for (let i = 0; i < AUTH_CODE_ISSUE_MAX; i += 1) await identity.issueCode(h.workspaceId, user.id, "setup");
        await expect(identity.issueCode(h.workspaceId, user.id, "setup")).rejects.toMatchObject({ code: "conflict" });
        await expect(identity.issueCode(h.workspaceId, RANDOM_ID, "setup")).rejects.toMatchObject({ code: "not_found" });
      });

      it("concurrent issues for one email: exactly the per-email cap succeeds", async () => {
        const user = await pendingUser("issue-race");
        const attempts = await Promise.allSettled(
          Array.from({ length: AUTH_CODE_ISSUE_MAX + 2 }, () => identity.issueCode(h.workspaceId, user.id, "setup")),
        );
        const issued = attempts.filter((r) => r.status === "fulfilled");
        const refused = attempts.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(issued).toHaveLength(AUTH_CODE_ISSUE_MAX);
        expect(refused).toHaveLength(2);
        for (const r of refused) expect(r.reason).toMatchObject({ code: "conflict" });
      });

      it("two concurrent redemptions of one code: exactly one succeeds", async () => {
        for (let i = 0; i < 5; i += 1) {
          const user = await pendingUser("redeem-race");
          const { code } = await identity.issueCode(h.workspaceId, user.id, "setup");
          const redeem = (password: string) =>
            identity.redeemCodeAndSetPassword({ email: user.email, purpose: "setup", code, password });
          const results = await Promise.all([redeem("race-password-1"), redeem("race-password-2")]);
          expect(results.filter((r) => r.ok)).toHaveLength(1);
          expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "invalid_code" }]);
          const winner = results[0]!.ok ? "race-password-1" : "race-password-2";
          expect(await identity.verifyPassword(user.email, winner)).toBe(true);
        }
      });

      it("a reset code ends the user's sessions when issued", async () => {
        const user = await activeUser("reset-issue");
        const { token } = await identity.createSession(user.id);
        await identity.issueCode(h.workspaceId, user.id, "reset");
        expect(await identity.resolveSession(token)).toBeNull();
      });

      it("redemption sets the password and clears the forced-change flag; reset also ends sessions", async () => {
        const user = await activeUser("redeem");
        await ports.credentials.mustChangePassword(user.id, true);
        const { token } = await identity.createSession(user.id);
        const { code } = await identity.issueCode(h.workspaceId, user.id, "setup");

        expect(
          await identity.redeemCodeAndSetPassword({ email: user.email, purpose: "setup", code, password: "chosen-password-1" }),
        ).toEqual({ ok: true, userId: user.id });
        expect(await identity.hasPasswordCredential(user.email)).toBe(true);
        expect(await identity.verifyPassword(user.email, "chosen-password-1")).toBe(true);
        expect(await identity.verifyPassword(user.email, "wrong-password")).toBe(false);
        expect(await identity.passwordMustChange(h.workspaceId, user.id)).toBe(false);
        expect(await identity.resolveSession(token)).not.toBeNull(); // setup keeps sessions

        const reset = await identity.issueCode(h.workspaceId, user.id, "reset");
        const { token: after } = await identity.createSession(user.id);
        expect(
          await identity.redeemCodeAndSetPassword({
            email: user.email,
            purpose: "reset",
            code: reset.code,
            password: "second-password-1",
          }),
        ).toEqual({ ok: true, userId: user.id });
        expect(await identity.resolveSession(after)).toBeNull();
        expect(await identity.verifyPassword(user.email, "second-password-1")).toBe(true);
      });
    });

    // ── identity linking ────────────────────────────────────────────────────

    describe("identity linking", () => {
      it("activates a pending user and binds its subject exactly once", async () => {
        const user = await pendingUser("link");
        const first = await identity.resolveAuthSuccess(user.email.toUpperCase());
        expect(first).toMatchObject({ status: "linked", userId: user.id });
        const subject = (first as { subject: string }).subject;
        expect(subject).toMatch(/^acct_/);
        expect(await identity.resolveAuthSuccess(user.email)).toEqual({ status: "linked", userId: user.id, subject });
        expect(await identity.findUserByAuthSubject(subject)).toEqual({
          id: user.id,
          status: "active",
          email: user.email,
          workspaceId: h.workspaceId,
        });
        expect(await identity.emailForAuthSubject(subject)).toBe(user.email);
        expect(await identity.emailForAuthSubject("acct_nobody")).toBeNull();
      });

      it("binds the subject exactly once when two sign-ins race", async () => {
        const user = await pendingUser("link-race");
        const [a, b] = await Promise.all([identity.resolveAuthSuccess(user.email), identity.resolveAuthSuccess(user.email)]);
        expect(a).toMatchObject({ status: "linked", userId: user.id });
        // Both sign-ins get the ONE bound subject; neither overwrites the other.
        expect(b).toEqual(a);
        const subject = (a as { subject: string }).subject;
        expect(await identity.findUserByAuthSubject(subject)).toMatchObject({ id: user.id });
        expect(await identity.emailForAuthSubject(subject)).toBe(user.email);
      });

      it("mints one open-registration subject when two first sign-ins race", async () => {
        // Ten races, each on a fresh email: one pair may happen not to overlap,
        // ten in a row do not (unguarded, ~9 of 10 pairs minted two subjects).
        for (let i = 0; i < 10; i += 1) {
          const stranger = email("open-race");
          const [a, b] = await Promise.all([
            identity.resolveAuthSuccess(stranger, { openRegistration: true }),
            identity.resolveAuthSuccess(stranger, { openRegistration: true }),
          ]);
          expect(a).toMatchObject({ status: "unprovisioned" });
          expect(b).toEqual(a);
          expect(await identity.emailForAuthSubject((a as { subject: string }).subject)).toBe(stranger);
        }
      });

      it("rejects unknown and disabled identities; open registration mints a stable subject", async () => {
        const stranger = email("stranger");
        expect(await identity.resolveAuthSuccess(stranger)).toEqual({ status: "not_invited" });
        const open = await identity.resolveAuthSuccess(stranger, { openRegistration: true });
        expect(open).toMatchObject({ status: "unprovisioned" });
        expect(await identity.resolveAuthSuccess(stranger, { openRegistration: true })).toEqual(open);

        const user = await activeUser("link-disabled");
        await disable(user.id);
        expect(await identity.resolveAuthSuccess(user.email)).toEqual({ status: "disabled" });
        expect(await identity.findUserByAuthSubject(user.subject)).toMatchObject({ id: user.id, status: "disabled" });
      });
    });

    // ── MCP keys ────────────────────────────────────────────────────────────

    describe("MCP keys", () => {
      it("resolve to the creator's current authority and go inert when revoked or the creator is disabled", async () => {
        const creator = await activeUser("mcp");
        const token = `mcpsuite_contract_${seq}_${"a".repeat(24)}`;
        const client = await ports.mcpClients.create({
          name: "Contract agent",
          tokenHash: sha256Hex(token),
          tokenPrefix: token.slice(0, 12),
          scopes: ["read", "write", "admin"],
          trust: "review_risky_actions",
          createdByUserId: creator.id,
        });
        const resolved = await identity.resolveMcpToken(token);
        expect(resolved).toMatchObject({
          clientId: client.id,
          workspaceId: h.workspaceId,
          name: "Contract agent",
          userId: creator.id,
          role: "member",
          trust: "review_risky_actions",
        });
        // Clamped to what a member can grant.
        expect(resolved!.scopes).not.toContain("admin");
        expect((await ports.mcpClients.get(client.id))!.lastUsedAt).not.toBeNull();

        expect(await identity.resolveMcpToken("mcpsuite_unknown")).toBeNull();
        expect(await identity.resolveMcpToken(null)).toBeNull();

        await disable(creator.id);
        expect(await identity.resolveMcpToken(token)).toBeNull();

        const other = await activeUser("mcp-revoke");
        const token2 = `mcpsuite_contract_${seq}_${"b".repeat(24)}`;
        const client2 = await ports.mcpClients.create({
          name: "Revoked agent",
          tokenHash: sha256Hex(token2),
          tokenPrefix: token2.slice(0, 12),
          scopes: ["read"],
          trust: "review_risky_actions",
          createdByUserId: other.id,
        });
        expect(await identity.resolveMcpToken(token2)).not.toBeNull();
        await ports.mcpClients.revoke(client2.id);
        expect(await identity.resolveMcpToken(token2)).toBeNull();
      });
    });

    // ── request gates ───────────────────────────────────────────────────────

    describe("request gates", () => {
      it("forced password change refuses every catalog operation through the runtime", async () => {
        const user = await activeUser("gate");
        const portsFor = h.portsFor;
        await ports.credentials.mustChangePassword(user.id, true);
        expect(await identity.passwordMustChange(h.workspaceId, user.id)).toBe(true);
        const refused = await runGated(catalog, identity, portsFor, ctxFor(user.id), "company.list", {});
        expect(refused).toMatchObject({ status: "error", error: { code: "password_change_required" } });

        await ports.credentials.mustChangePassword(user.id, false);
        const allowed = await runGated(catalog, identity, portsFor, ctxFor(user.id), "company.list", {});
        expect(allowed.status).toBe("ok");
      });

      it("the adapter's runtime enforces forced password change on run()", async () => {
        const user = await activeUser("runtime-gate");
        const rt = await h.runtime();
        try {
          await ports.credentials.mustChangePassword(user.id, true);
          expect(await rt.run(ctxFor(user.id), "company.list", {})).toMatchObject({
            status: "error",
            error: { code: "password_change_required" },
          });
          await ports.credentials.mustChangePassword(user.id, false);
          expect(await rt.run(ctxFor(user.id), "company.list", {})).toMatchObject({ status: "ok" });
        } finally {
          await rt.close();
        }
      });

      it("reports hosted workspace access", async () => {
        expect(await identity.workspaceAccess(h.workspaceId)).toEqual({ mode: "active", expiresAt: null });
        await h.lockWorkspace();
        expect((await identity.workspaceAccess(h.workspaceId)).mode).toBe("locked");
      });
    });

    // ── transactions ────────────────────────────────────────────────────────

    describe("transactions", () => {
      it("identity.withTransaction nested in ports.tx joins it; a failure rolls everything back", async () => {
        const user = await activeUser("nest");
        let token = "";
        let code = "";
        await expect(
          ports.tx(async () => {
            await ports.credentials.mustChangePassword(user.id, true);
            await identity.withTransaction(async () => {
              token = (await identity.createSession(user.id)).token;
              // A method with its own transaction (code issuance) joins too.
              // A setup code leaves sessions alone, so only the rollback can
              // remove the session and the code below.
              code = (await identity.issueCode(h.workspaceId, user.id, "setup")).code;
            });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await identity.passwordMustChange(h.workspaceId, user.id)).toBe(false);
        expect(token).not.toBe("");
        expect(await identity.resolveSession(token)).toBeNull();
        expect((await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code })).ok).toBe(false);

        // The same nesting commits when nothing fails.
        await ports.tx(async () => {
          await identity.withTransaction(async () => {
            token = (await identity.createSession(user.id)).token;
          });
        });
        expect(await identity.resolveSession(token)).not.toBeNull();
      });

      it("an identity transaction survives another process writing the same database", async () => {
        // SQLite only. A second connection stands in for the MCP HTTP process
        // or hosting control, which write the same file from another process.
        // A deferred BEGIN that reads, then sees another commit, then writes
        // fails with SQLITE_BUSY_SNAPSHOT; the identity store must not.
        if (!h.sqliteFile) return;
        const user = await activeUser("busy");
        await identity.setPassword(user.email, "first-password-1");
        const other = new Database(h.sqliteFile);
        other.pragma("busy_timeout = 50");
        let otherWrote = true;
        try {
          await identity.withTransaction(async () => {
            expect(await identity.verifyPassword(user.email, "first-password-1")).toBe(true); // read
            try {
              other.prepare("UPDATE workspaces SET updated_at = ?").run(new Date().toISOString()); // other process commits
            } catch {
              otherWrote = false; // it has to wait: we already hold the write lock
            }
            await identity.setPassword(user.email, "second-password-1"); // write
          });
        } finally {
          other.close();
        }
        expect(otherWrote).toBe(false);
        expect(await identity.verifyPassword(user.email, "second-password-1")).toBe(true);
      });

      it("session lookups do not take the write lock another process may need", async () => {
        // SQLite only. Session resolution runs on every authenticated request;
        // it must read under WAL while another process holds the write lock,
        // not queue for (or take) that lock itself.
        if (!h.sqliteFile) return;
        const user = await activeUser("wal-read");
        const { token } = await identity.createSession(user.id);
        const other = new Database(h.sqliteFile);
        try {
          other.exec("BEGIN IMMEDIATE"); // another process mid-write
          const started = Date.now();
          expect((await identity.resolveSession(token))!.user.id).toBe(user.id);
          expect(Date.now() - started).toBeLessThan(1000); // answered, did not wait out busy_timeout
          other.exec("COMMIT");
        } finally {
          if (other.inTransaction) other.exec("ROLLBACK");
          other.close();
        }
      });

      it("logout and session adoption wait out another process's write lock", { timeout: 20_000 }, async () => {
        // SQLite only. A real second PROCESS takes the file's write lock and
        // commits a write a moment later (as the MCP HTTP process or hosting
        // control do). Logout and adoption must wait through busy_timeout and
        // succeed.
        //
        // Limit: inside this test worker the variant that ran these methods in
        // a deferred read-then-write transaction ALSO passes, although the same
        // sequence fails with SQLITE_BUSY between two standalone processes (PR
        // #6 review round 7). This test guards the waiting behaviour, not that
        // regression.
        if (!h.sqliteFile) return;
        const holdWriteLock = async (ms: number): Promise<Promise<void>> => {
          // The child signals through a marker file, polled synchronously here:
          // pipe output reaches this test worker only after a delay as long as
          // the hold itself, which would miss the window every time.
          const marker = `${h.sqliteFile}.locked-${++seq}`;
          const child = spawn(
            process.execPath,
            [
              "-e",
              `const D = require("better-sqlite3"); const db = new D(process.argv[1]);
               db.exec("BEGIN IMMEDIATE");
               db.prepare("UPDATE workspaces SET updated_at = ?").run(new Date().toISOString());
               require("node:fs").writeFileSync(process.argv[3], "locked");
               Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
               db.exec("COMMIT"); db.close();`,
              h.sqliteFile!,
              String(ms),
              marker,
            ],
            { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "inherit"] },
          );
          const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
          const deadline = Date.now() + 10_000;
          while (!existsSync(marker)) {
            if (Date.now() > deadline) throw new Error("lock holder never took the lock");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          // Prove the lock is held right now, so the test can never silently miss the window.
          const probe = new Database(h.sqliteFile!);
          probe.pragma("busy_timeout = 0");
          expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
          probe.close();
          return exited;
        };

        const user = await activeUser("xproc-logout");
        const { token } = await identity.createSession(user.id);
        expect(await identity.resolveSession(token)).not.toBeNull(); // logout has a row to delete
        let released = await holdWriteLock(2000);
        await identity.destroySession(token);
        await released;
        expect(await identity.resolveSession(token)).toBeNull();

        const address = email("xproc-adopt");
        const subject = `acct_xproc_${seq}`;
        const { token: pending } = await identity.createSession(null, { email: address, authSubject: subject });
        const created = await ports.users.create({ name: "Adopted", email: address, role: "member", passwordHash: null });
        released = await holdWriteLock(2000);
        const adopted = await identity.resolveSession(pending);
        await released;
        expect(adopted!.user.id).toBe(created.id);
      });

      it("an error caught inside a nested ports.tx does not abort the outer transaction", async () => {
        // The approval flow does this: it runs the approved operation in a
        // nested ports.tx, catches its error, and records the failure. On
        // PostgreSQL a failed statement aborts the whole transaction unless
        // the nested tx is a savepoint.
        const user = await activeUser("nested-error");
        const other = await pendingUser("nested-error-taken");
        await ports.tx(async () => {
          await ports.credentials.mustChangePassword(user.id, true);
          await expect(
            ports.tx(async () => {
              // Duplicate email: a unique-index violation on PostgreSQL.
              await ports.users.createPending({ email: other.email, name: "Dup", role: "member" });
            }),
          ).rejects.toMatchObject({ code: "conflict" });
          await ports.credentials.mustChangePassword(other.id, true); // the outer transaction carries on
        });
        expect(await identity.passwordMustChange(h.workspaceId, user.id)).toBe(true);
        expect(await identity.passwordMustChange(h.workspaceId, other.id)).toBe(true);
      });

      it("keeps requests apart: another request neither joins an open transaction nor lands in it", async () => {
        const a = await activeUser("iso-a");
        const b = await activeUser("iso-b");
        let signalInside!: () => void;
        const inside = new Promise<void>((resolve) => {
          signalInside = resolve;
        });
        const order: string[] = [];
        let tokenA = "";

        // Request A holds its transaction open across a REAL timer, on purpose.
        // This breaks the "await only microtasks inside a transaction" rule so
        // the test can catch a plain write landing inside another request's
        // transaction. Do not shorten it to microtasks.
        const requestA = identity
          .withTransaction(async () => {
            tokenA = (await identity.createSession(a.id)).token;
            signalInside();
            await new Promise((r) => setTimeout(r, 50));
            order.push("A rolls back");
            throw new Error("A fails");
          })
          .catch((e: Error) => e.message);

        await inside;
        // Two more requests, each its own call chain, both started while A is
        // still open. B opens a transaction (it must wait, not join A's). C
        // makes a plain write (setPassword runs without a transaction on
        // SQLite; it must wait, not execute inside A's).
        const requestB = identity
          .withTransaction(async () => (await identity.createSession(b.id)).token)
          .then((token) => {
            order.push("B done");
            return token;
          });
        const requestC = identity.setPassword(b.email, "c-plain-write-1").then(() => {
          order.push("C done");
        });

        expect(await requestA).toBe("A fails");
        const tokenB = await requestB;
        await requestC;
        expect(await identity.resolveSession(tokenA)).toBeNull();
        expect((await identity.resolveSession(tokenB))!.user.id).toBe(b.id);
        expect(await identity.verifyPassword(b.email, "c-plain-write-1")).toBe(true);
        // SQLite shares one connection, so both must wait for A to finish.
        if (adapter.name === "sqlite") expect(order[0]).toBe("A rolls back");
      });
    });

    // ── atomic flows ────────────────────────────────────────────────────────

    describe("atomic flows", () => {
      it("a failure after the code is consumed leaves it unspent and no password set", async () => {
        const user = await pendingUser("atomic-redeem");
        const { code } = await identity.issueCode(h.workspaceId, user.id, "setup");
        const faulty = h.hooked({
          afterCodeConsumed: () => {
            throw new Error("crash after consume");
          },
        });
        await expect(
          faulty.redeemCodeAndSetPassword({ email: user.email, purpose: "setup", code, password: "never-stored-1" }),
        ).rejects.toThrow("crash after consume");
        expect(await identity.hasPasswordCredential(user.email)).toBe(false);
        expect(await identity.verifyAndConsumeCode({ email: user.email, purpose: "setup", code })).toEqual({
          ok: true,
          userId: user.id,
        });
      });

      it("a failure part-way through identity linking leaves the user unbound", async () => {
        const user = await pendingUser("atomic-link");
        const faulty = h.hooked({
          afterSubjectBound: () => {
            throw new Error("crash after bind");
          },
        });
        await expect(faulty.resolveAuthSuccess(user.email)).rejects.toThrow("crash after bind");
        expect((await ports.users.get(user.id))!.status).toBe("pending");
        const linked = await identity.resolveAuthSuccess(user.email);
        expect(linked).toMatchObject({ status: "linked", userId: user.id });
        expect(await identity.emailForAuthSubject((linked as { subject: string }).subject)).toBe(user.email);
      });
    });
  });
}
