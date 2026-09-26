/**
 * OpenAuth identity-model tests for the PostgreSQL adapter (schema.sql):
 * user lifecycle status, subject linking, setup/reset code bookkeeping,
 * disable/delete revocation, ownership transfer, and the RLS posture of the
 * identity-level tables (sessions / openauth_kv / auth_codes).
 *
 * Runs exactly like test/pg-isolation.test.ts:
 *
 *   docker run --rm -d --name mcpsuite-pg-test \
 *     -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   cd packages/db && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run pg-auth
 *
 * DATABASE_URL must be a superuser/deployment credential (see the isolation
 * suite header for why). To stay parallel-safe with pg-isolation.test.ts in
 * one vitest run, this suite creates and initializes its OWN database
 * (mcpsuite_pg_auth) on the same server and drops it afterwards. Roles are
 * cluster-global and both suites set the same throwaway crm_app password.
 * Without PG_TESTS=1 and DATABASE_URL the whole file self-skips.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpError, type ActorStamp, type User } from "@mcpsuite/core";
import {
  connectPg,
  createPgPorts,
  provisionPgWorkspace,
  type PgHandle,
  type PgPorts,
} from "../src/pg/repositories.ts";
import { initPgSchema } from "../src/pg/init.ts";
import { createPgIdentity } from "../src/pg/identity.ts";
import { dropTestDatabase, setTestRolePassword } from "./pg-test-support.ts";
import { joinAuthKey, normalizeAuthCode } from "../src/openauth.ts";

const enabled = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
/** The fixed fields every identity lookup returns (schema.sql). */
const IDENTITY_FIELDS = [
  "auth_subject",
  "disabled_at",
  "email",
  "password_must_change",
  "role",
  "status",
  "user_id",
  "workspace_id",
];

const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as pg-isolation.test.ts
const AUTH_DB = "mcpsuite_pg_auth";
const RANDOM_ID = "01890000-0000-7000-8000-00000000dead"; // valid uuid, never inserted
const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");
/** Adapter-mapped but not (yet) part of the core User type. */
const mustChangeOf = (u: User): boolean => (u as unknown as { passwordMustChange: boolean }).passwordMustChange;

describe.runIf(enabled)("postgres OpenAuth identity model (crm_app under forced RLS)", () => {
  let root: PgHandle; // server-level superuser on the original database
  let admin: PgHandle; // superuser on the dedicated mcpsuite_pg_auth database
  let app: PgHandle; // crm_app on mcpsuite_pg_auth
  let wsA: string;
  let wsB: string;
  let portsA: PgPorts;
  let portsB: PgPorts;
  let ownerA: User;
  let ownerB: User;

  const actor = (userId: string): ActorStamp => ({
    actorType: "human",
    actorUserId: userId,
    actorClientId: null,
    surface: "web",
  });

  const insertSession = async (userId: string): Promise<void> => {
    await admin.pool.query(
      `INSERT INTO crm.sessions (id, token_hash, user_id, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, now() + interval '30 days', now())`,
      [`test-hash-${Math.random().toString(36).slice(2)}`, userId],
    );
  };
  const sessionCount = async (userId: string): Promise<number> => {
    const res = await admin.pool.query("SELECT count(*)::int AS n FROM crm.sessions WHERE user_id = $1", [userId]);
    return Number(res.rows[0]?.n ?? 0);
  };
  interface CodeRow {
    purpose: string;
    email: string;
    code_hash: string;
    attempts: number;
    expires_at: Date;
    used_at: Date | null;
  }
  const codeRows = async (userId: string): Promise<CodeRow[]> => {
    const res = await admin.pool.query(
      "SELECT purpose, email, code_hash, attempts, expires_at, used_at FROM crm.auth_codes WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return res.rows as unknown as CodeRow[];
  };
  const kvKeys = async (): Promise<string[]> => {
    const res = await admin.pool.query("SELECT key FROM crm.openauth_kv ORDER BY key");
    return res.rows.map((r) => String(r.key));
  };
  const ownerCount = async (ws: string): Promise<number> => {
    const res = await admin.pool.query(
      "SELECT count(*)::int AS n FROM crm.memberships WHERE workspace_id = $1 AND role = 'owner'",
      [ws],
    );
    return Number(res.rows[0]?.n ?? 0);
  };
  /** New pending user linked to a subject — the standard activation dance. */
  const activeUser = async (ports: PgPorts, email: string, subject: string): Promise<User> => {
    const { userId } = await ports.users.createPending({ name: email.split("@")[0]!, email, role: "member" });
    return ports.users.activate(userId, subject);
  };

  beforeAll(async () => {
    const rootUrl = process.env.DATABASE_URL!;
    root = await connectPg({ databaseUrl: rootUrl, max: 1 });
    await root.pool.query(`DROP DATABASE IF EXISTS ${AUTH_DB} WITH (FORCE)`);
    await root.pool.query(`CREATE DATABASE ${AUTH_DB}`);

    const adminUrl = new URL(rootUrl);
    adminUrl.pathname = `/${AUTH_DB}`;
    admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 2 });
    // Roles are cluster-global; a parallel pg-isolation run may race the
    // guarded CREATE ROLE block in schema.sql — retrying is safe (the file is
    // one transaction and the guard is idempotent per database).
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
    app = await connectPg({ databaseUrl: appUrl.toString(), max: 2 });

    wsA = await provisionPgWorkspace(app.db, { name: "Auth A" });
    wsB = await provisionPgWorkspace(app.db, { name: "Auth B" });
    portsA = createPgPorts(app.db, wsA);
    portsB = createPgPorts(app.db, wsB);
    ownerA = await portsA.users.create({ name: "A Owner", email: "owner@auth-a.test", role: "owner", passwordHash: "x" });
    ownerB = await portsB.users.create({ name: "B Owner", email: "owner@auth-b.test", role: "owner", passwordHash: "x" });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin?.close();
    if (root) {
      await dropTestDatabase(root, AUTH_DB).catch(() => {});
      await root.close();
    }
  });

  // ── 1. New columns and their invariants ───────────────────────────────────

  it("status / auth_subject / password_must_change round-trip and stay coherent", async () => {
    expect(ownerA.status).toBe("active");
    expect(mustChangeOf(ownerA)).toBe(false);
    expect(ownerA.hasPassword).toBe(true);

    await portsA.credentials.mustChangePassword(ownerA.id, true);
    expect(mustChangeOf((await portsA.users.get(ownerA.id))!)).toBe(true);
    const flagged = await admin.pool.query("SELECT password_must_change FROM crm.users WHERE id = $1", [ownerA.id]);
    expect(flagged.rows[0]?.password_must_change).toBe(true);
    await portsA.credentials.mustChangePassword(ownerA.id, false);
    await expect(portsA.credentials.mustChangePassword(RANDOM_ID, true)).rejects.toThrow(OpError);
    // Cross-workspace flips behave like random ids.
    await expect(portsB.credentials.mustChangePassword(ownerA.id, true)).rejects.toThrow(OpError);

    // Disable/enable keeps (status, disabled_at) coherent through the port…
    const u = await activeUser(portsA, "coherent@auth-a.test", "sub-coherent");
    const disabled = await portsA.users.update(u.id, { disabledAt: new Date().toISOString() });
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledAt).not.toBeNull();
    const enabledAgain = await portsA.users.update(u.id, { disabledAt: null });
    expect(enabledAgain.status).toBe("active");
    expect(enabledAgain.disabledAt).toBeNull();
    // …and the CHECK refuses half-disabled rows even for a superuser.
    await expect(
      admin.pool.query("UPDATE crm.users SET status = 'disabled' WHERE id = $1", [u.id]),
    ).rejects.toThrow(/users_status_disabled_ck/);

    // auth_subject is globally unique: linking a taken subject is a conflict.
    const { userId: p2 } = await portsA.users.createPending({ name: "Dupe", email: "dupe@auth-a.test", role: "member" });
    await expect(portsA.users.activate(p2, "sub-coherent")).rejects.toMatchObject({ code: "conflict" });
    expect((await portsA.users.get(p2))!.status).toBe("pending"); // failed link rolls back fully
    await portsA.users.deletePermanently(p2);
  });

  // ── 2. createPending → activate linking ───────────────────────────────────

  it("createPending → activate: email triage serves only the success-callback linking", async () => {
    const { userId } = await portsA.users.createPending({ name: "Invitee", email: "invitee@auth-a.test", role: "member" });
    const pending = (await portsA.users.get(userId))!;
    expect(pending.status).toBe("pending");
    expect(pending.hasPassword).toBe(false);

    // Pending users have no subject, so no subject lookup finds them…
    const bySubject = await app.pool.query("SELECT * FROM crm.identity_by_subject($1)", ["sub-invitee"]);
    expect(bySubject.rows).toHaveLength(0);
    // …but the email lookup the success callback uses finds the invite,
    // pending and unlinked (docs/auth-api.md linking rules), with the fixed
    // identity fields only — never names or password material.
    const link = await app.pool.query("SELECT * FROM crm.identity_by_email($1)", ["invitee@auth-a.test"]);
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]).toMatchObject({ user_id: userId, workspace_id: wsA, role: "member", status: "pending", auth_subject: null });
    expect(Object.keys(link.rows[0]!).sort()).toEqual(IDENTITY_FIELDS);
    // Unknown emails resolve to nothing (→ not_invited).
    expect((await app.pool.query("SELECT * FROM crm.identity_by_email($1)", ["nobody@auth-a.test"])).rows).toHaveLength(0);

    const linked = await portsA.users.activate(userId, "sub-invitee");
    expect(linked.status).toBe("active");
    const resolved = await app.pool.query("SELECT * FROM crm.identity_by_subject($1)", ["sub-invitee"]);
    expect(resolved.rows[0]).toMatchObject({ user_id: userId, workspace_id: wsA, role: "member", password_must_change: false });
    // Once linked, the email lookup shows the identity as subject-owned…
    const relink = await app.pool.query("SELECT * FROM crm.identity_by_email($1)", ["invitee@auth-a.test"]);
    expect(relink.rows[0]).toMatchObject({ status: "active", auth_subject: "sub-invitee" });
    // …and subject binding is single-shot.
    await expect(portsA.users.activate(userId, "sub-again")).rejects.toThrow(OpError);

    // An ACTIVE user without a subject (pre-OpenAuth account / owner
    // recovery) binds on first login — the second landed linking rule.
    expect((await app.pool.query("SELECT * FROM crm.identity_by_email($1)", [ownerA.email])).rows[0]).toMatchObject({
      status: "active",
      auth_subject: null,
    });
    const boundOwner = await portsA.users.activate(ownerA.id, "sub-owner-a");
    expect(boundOwner.status).toBe("active");
    expect((await app.pool.query("SELECT * FROM crm.identity_by_subject($1)", ["sub-owner-a"])).rows[0]).toMatchObject({
      user_id: ownerA.id,
      workspace_id: wsA,
      role: "owner",
    });

    // Cross-workspace and unknown ids behave identically.
    const { userId: otherPending } = await portsA.users.createPending({ name: "Px", email: "px@auth-a.test", role: "member" });
    await expect(portsB.users.activate(otherPending, "sub-px")).rejects.toThrow(OpError);
    await expect(portsA.users.activate(RANDOM_ID, "sub-none")).rejects.toThrow(OpError);
    // Deployment-global email uniqueness answers without naming the workspace.
    await expect(
      portsB.users.createPending({ name: "Steal", email: "invitee@auth-a.test", role: "member" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await portsA.users.deletePermanently(otherPending);
  });

  // ── 3. Disabled/pending users cannot authenticate anywhere ────────────────

  it("a disabled user's sessions do not resolve and their MCP clients are de-authorized", async () => {
    const u = await activeUser(portsA, "revocable@auth-a.test", "sub-revocable");
    const identity = createPgIdentity(app.db);
    const tokenHash = `mcp-hash-${Math.random().toString(36).slice(2)}`;
    await portsA.mcpClients.create({
      name: "Revocable agent",
      tokenHash,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read"],
      trust: "review_risky_actions",
      createdByUserId: u.id,
    });
    expect((await app.pool.query("SELECT enabled FROM crm.resolve_mcp_key($1)", [tokenHash])).rows[0]?.enabled).toBe(true);

    await portsA.users.update(u.id, { disabledAt: new Date().toISOString() });
    // Disabling ended the sessions; a session minted afterwards still does not resolve.
    const { token } = await identity.createSession(u.id, { authSubject: "sub-revocable" });
    expect(await identity.resolveSession(token)).toBeNull();
    expect((await app.pool.query("SELECT enabled FROM crm.resolve_mcp_key($1)", [tokenHash])).rows[0]?.enabled).toBe(false);
    // The email lookup still identifies the account as disabled — the success
    // callback shows account_disabled, never not_invited, for a real user.
    expect((await app.pool.query("SELECT status FROM crm.identity_by_email($1)", ["revocable@auth-a.test"])).rows[0]?.status).toBe("disabled");

    await portsA.users.update(u.id, { disabledAt: null });
    expect((await identity.resolveSession(token))?.user.id).toBe(u.id);
    expect((await app.pool.query("SELECT enabled FROM crm.resolve_mcp_key($1)", [tokenHash])).rows[0]?.enabled).toBe(true);

    // A pending creator lends no authority either.
    const { userId: pendingId } = await portsA.users.createPending({ name: "Pend", email: "pend@auth-a.test", role: "member" });
    const pendingHash = `mcp-hash-${Math.random().toString(36).slice(2)}`;
    await portsA.mcpClients.create({
      name: "Pending-owned agent",
      tokenHash: pendingHash,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read"],
      trust: "review_risky_actions",
      createdByUserId: pendingId,
    });
    expect((await app.pool.query("SELECT enabled FROM crm.resolve_mcp_key($1)", [pendingHash])).rows[0]?.enabled).toBe(false);
    await portsA.users.deletePermanently(pendingId);
  });

  // ── 4. Disable revocation sweep (docs/issues/0022, pg mirror) ─────────────

  it("disabling deletes sessions and revokes MCP clients in one transaction", async () => {
    const u = await activeUser(portsA, "sweep@auth-a.test", "sub-sweep");
    await insertSession(u.id);
    await insertSession(u.id);
    const activeClient = await portsA.mcpClients.create({
      name: "Sweep active",
      tokenHash: `mcp-hash-${Math.random().toString(36).slice(2)}`,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read"],
      trust: "review_risky_actions",
      createdByUserId: u.id,
    });
    const preRevoked = await portsA.mcpClients.create({
      name: "Sweep already revoked",
      tokenHash: `mcp-hash-${Math.random().toString(36).slice(2)}`,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read"],
      trust: "review_risky_actions",
      createdByUserId: u.id,
    });
    const revokedBefore = (await portsA.mcpClients.revoke(preRevoked.id)).revokedAt;

    // Exactly the admin-ops user.update(disabled: true) sequence, one tx.
    const sweep = await portsA.tx(async () => {
      await portsA.users.update(u.id, { disabledAt: new Date().toISOString() });
      return {
        endedSessions: await portsA.users.deleteSessions(u.id),
        revokedMcpClients: await portsA.mcpClients.revokeAllForUser(u.id),
      };
    });
    expect(sweep).toEqual({ endedSessions: 2, revokedMcpClients: 1 }); // pre-revoked one not double-counted
    expect(await sessionCount(u.id)).toBe(0);
    expect((await portsA.mcpClients.get(activeClient.id))!.revokedAt).not.toBeNull();
    expect((await portsA.mcpClients.get(preRevoked.id))!.revokedAt).toBe(revokedBefore); // timestamp preserved

    // Re-enabling restores nothing.
    await portsA.users.update(u.id, { disabledAt: null });
    expect(await sessionCount(u.id)).toBe(0);
    expect((await portsA.mcpClients.get(activeClient.id))!.revokedAt).not.toBeNull();

    // The sweep is workspace-guarded: B cannot end A's sessions.
    await insertSession(u.id);
    expect(await portsB.users.deleteSessions(u.id)).toBe(0);
    expect(await sessionCount(u.id)).toBe(1);
    expect(await portsA.users.deleteSessions(u.id)).toBe(1);
  });

  // ── 5. Setup/reset codes: issuance ────────────────────────────────────────

  it("issueCode stores only hashes, supersedes per purpose, and reset ends sessions", async () => {
    const { userId: invitee } = await portsA.users.createPending({ name: "Codes", email: "codes@auth-a.test", role: "member" });
    const first = await portsA.credentials.issueCode(invitee, "setup");
    expect(first.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    let rows = await codeRows(invitee);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(sha256Hex(normalizeAuthCode(first.code))); // never the raw code
    expect(rows[0]!.email).toBe("codes@auth-a.test"); // v5 column parity
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.used_at).toBeNull();
    expect(new Date(rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());

    const second = await portsA.credentials.issueCode(invitee, "setup");
    rows = await codeRows(invitee);
    // The previous setup code is superseded (marked used, kept for the issue
    // rate limit); exactly one live code remains — the new one.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.used_at).not.toBeNull();
    expect(rows.filter((r) => r.used_at === null).map((r) => r.code_hash)).toEqual([sha256Hex(normalizeAuthCode(second.code))]);

    // reset: issuing ends every session in the same transaction.
    const u = await activeUser(portsA, "resettable@auth-a.test", "sub-resettable");
    await insertSession(u.id);
    await insertSession(u.id);
    const reset = await portsA.credentials.issueCode(u.id, "reset");
    expect(reset.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await sessionCount(u.id)).toBe(0);
    // Reset codes are hot links: max one hour, not the 7-day invite window.
    const resetRow = (await codeRows(u.id))[0]!;
    expect(new Date(resetRow.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);

    // Guards: unknown, cross-workspace and disabled users all read not_found.
    await expect(portsA.credentials.issueCode(RANDOM_ID, "setup")).rejects.toThrow(OpError);
    await expect(portsB.credentials.issueCode(u.id, "reset")).rejects.toThrow(OpError);
    await portsA.users.update(u.id, { disabledAt: new Date().toISOString() });
    await expect(portsA.credentials.issueCode(u.id, "reset")).rejects.toThrow(OpError);
    await portsA.users.update(u.id, { disabledAt: null });
    await portsA.users.deletePermanently(invitee);
  });

  // ── 6. Setup/reset codes: single-use + expiry ─────────────────────────────

  it("a code redeems exactly once and honors purpose, supersession and expiry", async () => {
    const identity = createPgIdentity(app.db);
    const email = "burn@auth-a.test";
    const { userId } = await portsA.users.createPending({ name: "Burn", email, role: "member" });
    const { code } = await portsA.credentials.issueCode(userId, "setup");

    // Wrong purpose neither redeems nor burns.
    expect(await identity.verifyAndConsumeCode({ email, purpose: "reset", code })).toEqual({ ok: false, reason: "invalid_code" });
    expect(await identity.verifyAndConsumeCode({ email, purpose: "setup", code })).toEqual({ ok: true, userId });
    // Single-use.
    expect(await identity.verifyAndConsumeCode({ email, purpose: "setup", code })).toEqual({ ok: false, reason: "invalid_code" });

    // Reissue invalidates the outstanding code even before expiry.
    const a = await portsA.credentials.issueCode(userId, "setup");
    const b = await portsA.credentials.issueCode(userId, "setup");
    expect(await identity.verifyAndConsumeCode({ email, purpose: "setup", code: a.code })).toMatchObject({ ok: false });
    expect(await identity.verifyAndConsumeCode({ email, purpose: "setup", code: b.code })).toEqual({ ok: true, userId });

    // Expired codes are dead even when unconsumed.
    await admin.pool.query(
      `INSERT INTO crm.auth_codes (user_id, email, purpose, code_hash, expires_at)
       VALUES ($1, $2, 'setup', $3, now() - interval '1 minute')`,
      [userId, email, sha256Hex(normalizeAuthCode("AAAA-BBBB-CCCC"))],
    );
    expect(await identity.verifyAndConsumeCode({ email, purpose: "setup", code: "AAAA-BBBB-CCCC" })).toEqual({
      ok: false,
      reason: "expired_code",
    });
    // Unknown emails: the same answer as a wrong code.
    expect(await identity.verifyAndConsumeCode({ email: "never@auth-a.test", purpose: "setup", code })).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    await portsA.users.deletePermanently(userId);
  });

  // ── 7. Identity-level tables: reachable by key, bound to one workspace ────

  it("crm_app reaches identity rows by key before binding, and only its workspace's once bound", async () => {
    const identity = createPgIdentity(app.db);
    // The issuer storage: keyed reads and writes, expired rows invisible.
    await identity.authKv.set(joinAuthKey(["oauth:refresh", "sub-kv", "t1"]), JSON.stringify({ n: 1 }), null);
    const later = Date.now() + 3_600_000;
    await identity.authKv.set(joinAuthKey(["oauth:refresh", "sub-kv", "t2"]), JSON.stringify({ n: 2 }), later);
    await identity.authKv.set(joinAuthKey(["oauth:refresh", "sub-kv", "t3"]), JSON.stringify({ n: 3 }), Date.now() - 1_000);
    expect(await identity.authKv.get(joinAuthKey(["oauth:refresh", "sub-kv", "t1"]))).toEqual({ value: '{"n":1}', expiry: null });
    await identity.authKv.set(joinAuthKey(["oauth:refresh", "sub-kv", "t1"]), JSON.stringify({ n: 10 }), null);
    expect((await identity.authKv.get(joinAuthKey(["oauth:refresh", "sub-kv", "t1"])))?.value).toBe('{"n":10}');
    expect(await identity.authKv.get(joinAuthKey(["oauth:refresh", "sub-kv", "t3"]))).toBeNull();
    const scan = await identity.authKv.scanPrefix(joinAuthKey(["oauth:refresh", "sub-kv"]));
    expect(scan.map((r) => [r.key, r.expiry])).toEqual([
      [joinAuthKey(["oauth:refresh", "sub-kv", "t1"]), null],
      [joinAuthKey(["oauth:refresh", "sub-kv", "t2"]), later],
    ]);
    await identity.authKv.remove(joinAuthKey(["oauth:refresh", "sub-kv", "t1"]));
    await identity.authKv.remove(joinAuthKey(["oauth:refresh", "sub-kv", "t2"]));

    // Sessions and codes: B's rows are reachable by key while unbound (sign-in
    // has not found a workspace yet), and invisible once bound to A.
    await insertSession(ownerB.id);
    const bCode = await portsB.credentials.issueCode(ownerB.id, "reset"); // ends B's sessions…
    await insertSession(ownerB.id); // …so mint one after it
    const client = await app.pool.connect();
    try {
      const n = async (q: string, v: unknown[]) => Number((await client.query(q, v)).rows[0]?.n ?? 0);
      expect(await n("SELECT count(*)::int AS n FROM crm.sessions WHERE user_id = $1", [ownerB.id])).toBe(1);
      expect(await n("SELECT count(*)::int AS n FROM crm.auth_codes WHERE user_id = $1", [ownerB.id])).toBeGreaterThan(0);
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      expect(await n("SELECT count(*)::int AS n FROM crm.sessions WHERE user_id = $1", [ownerB.id])).toBe(0);
      expect(await n("SELECT count(*)::int AS n FROM crm.auth_codes WHERE user_id = $1", [ownerB.id])).toBe(0);
      expect((await client.query("DELETE FROM crm.sessions WHERE user_id = $1", [ownerB.id])).rowCount).toBe(0);
      expect((await client.query("UPDATE crm.auth_codes SET used_at = now() WHERE user_id = $1", [ownerB.id])).rowCount).toBe(0);
      await expect(
        client.query(
          "INSERT INTO crm.auth_codes (user_id, email, purpose, code_hash, expires_at) VALUES ($1, 'x', 'setup', 'h-cross', now())",
          [ownerB.id],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await sessionCount(ownerB.id)).toBe(1);
    expect((await codeRows(ownerB.id)).some((r) => r.code_hash === sha256Hex(normalizeAuthCode(bCode.code)) && r.used_at === null)).toBe(true);
    await portsB.users.deleteSessions(ownerB.id);

    // A set but malformed workspace is not "unbound": it reaches nothing,
    // not even sessions that have no user yet.
    await identity.createSession(null, { email: "stranger@auth-a.test", authSubject: "acct_stranger" });
    await insertSession(ownerB.id);
    const probe = await app.pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SELECT set_config('app.workspace_id', 'not-a-uuid', true)");
      expect((await probe.query("SELECT count(*)::int AS n FROM crm.sessions")).rows[0]?.n).toBe(0);
      expect((await probe.query("SELECT count(*)::int AS n FROM crm.auth_codes")).rows[0]?.n).toBe(0);
      await probe.query("ROLLBACK");
    } finally {
      probe.release();
    }
    await portsB.users.deleteSessions(ownerB.id);
    await admin.pool.query("DELETE FROM crm.sessions WHERE email = 'stranger@auth-a.test'");

    // Workspace tables stay invisible without a workspace: identity work
    // reads users only through the keyed lookup functions.
    expect((await app.pool.query("SELECT count(*)::int AS n FROM crm.users")).rows[0]?.n).toBe(0);
  });

  it("SQL holds only the nine read-only lookups, none callable by PUBLIC", async () => {
    const fns = await admin.pool.query(
      `SELECT n.nspname || '.' || p.proname AS name, p.provolatile AS volatility, l.lanname AS language,
              pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl,
              has_function_privilege('crm_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('crm_operator', p.oid, 'EXECUTE') AS operator
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname IN ('crm', 'hosting')
       ORDER BY 1`,
    );
    const byName = new Map(fns.rows.map((r) => [String(r.name), r]));
    expect([...byName.keys()]).toEqual([
      "crm.current_workspace_id",
      "crm.email_for_auth_subject",
      "crm.has_password_credential",
      "crm.identity_by_email",
      "crm.identity_by_subject",
      "crm.identity_by_user_id",
      "crm.resolve_mcp_key",
      "crm.workspace_access_state",
      "hosting.pending_auth_deliveries",
    ]);
    for (const row of fns.rows) {
      // STABLE: a function cannot write. current_workspace_id reads the GUC in plpgsql.
      expect(row.volatility, `${row.name} volatility`).toBe("s");
      expect(row.language, `${row.name} language`).toBe(row.name === "crm.current_workspace_id" ? "plpgsql" : "sql");
      if (row.name !== "crm.current_workspace_id") expect(row.owner, `${row.name} owner`).toBe("crm_identity_resolver");
      const entries = String(row.acl).replace(/[{}]/g, "").split(",").filter(Boolean);
      expect(entries.length, `${row.name} has explicit acl`).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.startsWith("="), `${row.name} grants nothing to PUBLIC`).toBe(false);
    }
    // crm_app: every crm lookup, not hosting's sweep. crm_operator: the RLS
    // predicate, subject → email, "has a password", and its sweep — nothing else.
    const expectApp = (name: string) => name.startsWith("crm.");
    const operatorMay = new Set([
      "crm.current_workspace_id",
      "crm.email_for_auth_subject",
      "crm.has_password_credential",
      "hosting.pending_auth_deliveries",
    ]);
    for (const row of fns.rows) {
      expect(row.app, `crm_app on ${row.name}`).toBe(expectApp(String(row.name)));
      expect(row.operator, `crm_operator on ${row.name}`).toBe(operatorMay.has(String(row.name)));
    }
  });

  // ── 8. Permanent deletion: cascade vs survival ────────────────────────────

  it("deletePermanently removes credentials and identity, business history survives as 'Deleted user'", async () => {
    const victim = await activeUser(portsA, "victim@auth-a.test", "sub-victim");
    await portsA.credentials.issueCode(victim.id, "reset"); // leaves a code row (and would end sessions — insert them after)
    await insertSession(victim.id);
    await insertSession(victim.id);
    const client = await portsA.mcpClients.create({
      name: "Victim agent",
      tokenHash: `mcp-hash-${Math.random().toString(36).slice(2)}`,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read", "write"],
      trust: "review_risky_actions",
      createdByUserId: victim.id,
    });
    const revoked = await portsA.mcpClients.create({
      name: "Victim revoked agent",
      tokenHash: `mcp-hash-${Math.random().toString(36).slice(2)}`,
      tokenPrefix: "mcpsuite_test",
      scopes: ["read"],
      trust: "review_risky_actions",
      createdByUserId: victim.id,
    });
    await portsA.mcpClients.revoke(revoked.id);
    // Issuer rows keyed by the subject (tokens) AND by the email (password
    // hash / email→subject binding) must both die — real OpenAuth keys, joined
    // with chr(31). Unrelated identities stay, including an email that CONTAINS
    // the victim's (whole-segment match, never a substring).
    const setKv = (key: string) => app.pool.query("INSERT INTO crm.openauth_kv (key, value) VALUES ($1, '{}'::jsonb)", [key]);
    await setKv(joinAuthKey(["oauth:refresh", "sub-victim", "t1"]));
    await setKv(joinAuthKey(["email", "victim@auth-a.test", "password"]));
    await setKv(joinAuthKey(["email", "victim@auth-a.test", "subject"]));
    await setKv(joinAuthKey(["oauth:refresh", "sub-survivor", "t1"]));
    await setKv(joinAuthKey(["email", "my-victim@auth-a.test", "password"]));

    const company = await portsA.companies.create({ name: "Victim Co", ownerUserId: victim.id });
    const task = await portsA.activities.create(
      { kind: "task", title: "Victim task", assigneeUserId: victim.id },
      actor(victim.id),
    );
    await portsA.audit.record(
      { operation: "company.create", entityType: "company", entityId: company.id, summary: "victim acted" },
      actor(victim.id),
    );
    const privateView = await portsA.savedViews.create({
      name: "Victim private",
      entityType: "company",
      filters: {},
      visibility: "private",
      ownerUserId: victim.id,
    });
    const sharedView = await portsA.savedViews.create({
      name: "Victim shared",
      entityType: "company",
      filters: {},
      visibility: "shared",
      ownerUserId: victim.id,
    });
    const pending = await portsA.pendingActions.create({
      operation: "company.delete",
      input: { id: company.id },
      preview: null,
      riskCategory: "destructive",
      actor: actor(victim.id),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // Guards first: the owner is undeletable; B ids and random ids match.
    await expect(portsA.users.deletePermanently(ownerA.id)).rejects.toThrow(/transfer ownership/i);
    await expect(portsB.users.deletePermanently(victim.id)).rejects.toThrow(OpError);
    await expect(portsA.users.deletePermanently(RANDOM_ID)).rejects.toThrow(OpError);

    await portsA.users.deletePermanently(victim.id);

    // Identity + credentials are gone…
    expect(await portsA.users.get(victim.id)).toBeNull();
    expect((await admin.pool.query("SELECT count(*)::int AS n FROM crm.users WHERE id = $1", [victim.id])).rows[0]?.n).toBe(0);
    expect((await admin.pool.query("SELECT count(*)::int AS n FROM crm.memberships WHERE user_id = $1", [victim.id])).rows[0]?.n).toBe(0);
    expect(await sessionCount(victim.id)).toBe(0);
    expect(await codeRows(victim.id)).toHaveLength(0);
    expect(await portsA.mcpClients.get(client.id)).toBeNull();
    expect(await portsA.mcpClients.get(revoked.id)).toBeNull();
    // Issuer state: every record of the victim is gone; the others stay.
    expect(await kvKeys()).toEqual(
      [joinAuthKey(["email", "my-victim@auth-a.test", "password"]), joinAuthKey(["oauth:refresh", "sub-survivor", "t1"])].sort(),
    );
    expect((await app.pool.query("SELECT * FROM crm.identity_by_subject($1)", ["sub-victim"])).rows).toHaveLength(0);

    // …while business records survive, unassigned and nameless.
    const companyAfter = (await portsA.companies.get(company.id))!;
    expect(companyAfter.ownerUserId).toBeNull();
    const taskAfter = (await portsA.activities.get(task.id))!;
    expect(taskAfter.assigneeUserId).toBeNull();
    expect(taskAfter.actorUserId).toBeNull();
    const audit = await portsA.audit.list({ operation: "company.create", limit: 10, offset: 0 });
    const auditRow = audit.items.find((e) => e.summary === "victim acted")!;
    expect(auditRow.actorUserId).toBeNull();
    expect(JSON.stringify(auditRow)).not.toContain("victim@auth-a.test");
    const pendingAfter = (await portsA.pendingActions.get(pending.id))!;
    expect(pendingAfter.requestedByUserId).toBeNull();
    expect(await portsA.savedViews.get(privateView.id)).toBeNull(); // personal config dies
    const sharedAfter = (await portsA.savedViews.get(sharedView.id))!;
    expect(sharedAfter.ownerUserId).toBeNull(); // shared config survives ownerless

    // B never noticed.
    expect((await portsB.users.list()).map((u) => u.id)).toEqual([ownerB.id]);
  });

  // ── 9. Ownership transfer: atomic, single-owner under races ───────────────

  it("transferOwnership swaps atomically and the one-owner index survives concurrency", async () => {
    const m1 = await activeUser(portsA, "m1@auth-a.test", "sub-m1");
    const m2 = await activeUser(portsA, "m2@auth-a.test", "sub-m2");

    await portsA.users.transferOwnership(ownerA.id, m1.id);
    expect((await portsA.users.get(m1.id))!.role).toBe("owner");
    expect((await portsA.users.get(ownerA.id))!.role).toBe("admin");
    expect(await ownerCount(wsA)).toBe(1);

    // Stale "from" (no longer owner) is a conflict, not a second owner.
    await expect(portsA.users.transferOwnership(ownerA.id, m2.id)).rejects.toMatchObject({ code: "conflict" });
    // Self-transfer and non-active targets are rejected.
    await expect(portsA.users.transferOwnership(m1.id, m1.id)).rejects.toThrow(OpError);
    const { userId: pendingId } = await portsA.users.createPending({ name: "P", email: "p-owner@auth-a.test", role: "member" });
    await expect(portsA.users.transferOwnership(m1.id, pendingId)).rejects.toThrow(OpError);
    // Cross-workspace: B cannot move A's ownership.
    await expect(portsB.users.transferOwnership(m1.id, ownerB.id)).rejects.toThrow(OpError);

    // Two simultaneous transfers from the same owner: exactly one wins, the
    // loser rolls back, and the workspace never observes two owners.
    const outcomes = await Promise.allSettled([
      portsA.users.transferOwnership(m1.id, ownerA.id),
      portsA.users.transferOwnership(m1.id, m2.id),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await ownerCount(wsA)).toBe(1);
    const winners = await admin.pool.query(
      "SELECT user_id FROM crm.memberships WHERE workspace_id = $1 AND role = 'owner'",
      [wsA],
    );
    expect([ownerA.id, m2.id]).toContain(winners.rows[0]?.user_id);

    // The DB-level backstop itself: crm_app cannot smuggle a second owner.
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      await expect(
        client.query("UPDATE crm.memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [wsA, m1.id]),
      ).rejects.toThrow(/memberships_one_owner_ux|duplicate key/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await ownerCount(wsA)).toBe(1);
    await portsA.users.deletePermanently(pendingId);
  });
});

describe.runIf(!enabled)("postgres OpenAuth identity model (skipped)", () => {
  it.skip("set PG_TESTS=1 and DATABASE_URL (superuser) to run this suite", () => {});
});
