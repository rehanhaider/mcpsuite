/**
 * OpenAuth identity plumbing (docs/auth-api.md, docs/issues/0022):
 * the KV storage adapter, scrypt credential interop, setup/reset code
 * lifecycle, pending→active subject linking, subject-linked sessions, and
 * the forced-password-change gate.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { systemContext } from "@emcp/core";
import { initSchema, type Db } from "../src/connection.ts";
import * as schema from "../src/schema.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { createPorts } from "../src/repositories.ts";
import { createRuntime } from "../src/runtime.ts";
import { createSession, destroySession, resolveSession } from "../src/auth.ts";
import {
  AUTH_CODE_ISSUE_MAX,
  AUTH_CODE_MAX_ATTEMPTS,
  createOpenAuthStorage,
  deliverAuthCode,
  issueAuthCode,
  joinAuthKey,
  normalizeAuthCode,
  openAuthHashPassword,
  openAuthVerifyPassword,
  redeemAuthCodeAndSetPassword,
  resolveAuthSuccess,
  setOpenAuthPassword,
  sqliteAuthKv,
  verifyAndConsumeAuthCode,
  verifyOpenAuthPassword,
} from "../src/openauth.ts";

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initSchema(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

let db: Db;
beforeEach(() => {
  db = memoryDb();
});

// ---------------------------------------------------------------------------

describe("OpenAuth storage adapter", () => {
  it("round-trips set/get/remove with expiry and whole-segment scans", async () => {
    const storage = createOpenAuthStorage(sqliteAuthKv(db));
    await storage.set(["email", "a@x.test", "password"], { hash: "h", salt: "s", N: 16384, r: 8, p: 1 });
    expect(await storage.get(["email", "a@x.test", "password"])).toMatchObject({ hash: "h" });
    expect(await storage.get(["email", "missing@x.test", "password"])).toBeUndefined();

    // Expired values act as absent (and are cleaned up lazily).
    await storage.set(["oauth:code", "c1"], { v: 1 }, new Date(Date.now() - 1000));
    expect(await storage.get(["oauth:code", "c1"])).toBeUndefined();

    // Prefix scans respect segment boundaries.
    await storage.set(["oauth:refresh", "acct_1", "t1"], { a: 1 });
    await storage.set(["oauth:refresh", "acct_1", "t2"], { a: 2 });
    await storage.set(["oauth:refresh", "acct_10", "t3"], { a: 3 }); // must NOT match prefix acct_1
    const found: string[][] = [];
    for await (const [key] of storage.scan(["oauth:refresh", "acct_1"])) found.push(key);
    expect(found.map((k) => k[2]).sort()).toEqual(["t1", "t2"]);

    await storage.remove(["oauth:refresh", "acct_1", "t1"]);
    expect(await storage.get(["oauth:refresh", "acct_1", "t1"])).toBeUndefined();
  });

  it("writes credentials in OpenAuth's exact scrypt shape", async () => {
    const hashed = openAuthHashPassword("hunter2hunter2");
    expect(hashed).toMatchObject({ N: 16384, r: 8, p: 1 });
    expect(openAuthVerifyPassword("hunter2hunter2", hashed)).toBe(true);
    expect(openAuthVerifyPassword("wrong-password", hashed)).toBe(false);

    await setOpenAuthPassword(db, "User@X.test", "pw-1234567890");
    expect(await verifyOpenAuthPassword(db, "user@x.test", "pw-1234567890")).toBe(true);
    expect(await verifyOpenAuthPassword(db, "user@x.test", "nope")).toBe(false);
    // The stored value is the provider-compatible object under OpenAuth's key.
    const raw = await sqliteAuthKv(db).get(joinAuthKey(["email", "user@x.test", "password"]));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!.value)).toMatchObject({ N: 16384, r: 8, p: 1 });
  });
});

// ---------------------------------------------------------------------------

describe("setup/reset codes", () => {
  it("are single-use, hashed, expiring, attempt-capped, and superseded on reissue", async () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    const ports = createPorts(db, boot.workspaceId);
    const { userId } = await ports.users.createPending({ email: "sam@x.test", name: "Sam", role: "member" });

    const first = await issueAuthCode(db, { userId, purpose: "setup" });
    expect(first.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Regeneration invalidates the previous code…
    const second = await issueAuthCode(db, { userId, purpose: "setup" });
    expect(await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: first.code })).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    // …the current one verifies once (case/separator-insensitively) and is consumed.
    const sloppy = second.code.toLowerCase().replaceAll("-", " ");
    expect(normalizeAuthCode(sloppy)).toBe(normalizeAuthCode(second.code));
    expect(await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: sloppy })).toEqual({
      ok: true,
      userId,
    });
    expect(await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: second.code })).toEqual({
      ok: false,
      reason: "invalid_code",
    });

    // Expiry: an expired row answers expired_code.
    const third = await issueAuthCode(db, { userId, purpose: "setup" });
    db.$client.prepare("UPDATE auth_codes SET expires_at = ? WHERE used_at IS NULL").run("2000-01-01T00:00:00Z");
    expect(await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: third.code })).toEqual({
      ok: false,
      reason: "expired_code",
    });

    // Attempt cap: wrong guesses lock the active code.
    const fourth = await issueAuthCode(db, { userId, purpose: "setup" });
    for (let i = 0; i < AUTH_CODE_MAX_ATTEMPTS - 1; i++) {
      expect((await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: "WRONG-GUESS-1" })).ok).toBe(false);
    }
    expect(await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: "WRONG-GUESS-1" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect((await verifyAndConsumeAuthCode(db, { email: "sam@x.test", purpose: "setup", code: fourth.code })).ok).toBe(false);
  });

  it("rate-limits issuance per email (fixed window) and reset ends sessions", async () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    const ports = createPorts(db, boot.workspaceId);
    const { userId } = await ports.users.createPending({ email: "rate@x.test", name: "R", role: "member" });

    // Bootstrap already issued 0 codes for this email; the cap applies per email.
    for (let i = 0; i < AUTH_CODE_ISSUE_MAX; i++) await issueAuthCode(db, { userId, purpose: "setup" });
    await expect(issueAuthCode(db, { userId, purpose: "setup" })).rejects.toMatchObject({ code: "conflict" });

    // reset issuance ends every session and revokes stored refresh tokens.
    const owner = boot.ownerUserId;
    db.$client.prepare("UPDATE users SET status = 'active', auth_subject = 'acct_own' WHERE id = ?").run(owner);
    createSession(db, owner, { authSubject: "acct_own", authRefresh: "acct_own:tok1" });
    await sqliteAuthKv(db).set(joinAuthKey(["oauth:refresh", "acct_own", "tok1"]), "{}", null);
    const issued = await issueAuthCode(db, { userId: owner, purpose: "reset" });
    expect(issued.code).toBeTruthy();
    expect(db.$client.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").get(owner)).toEqual({ n: 0 });
    expect(await sqliteAuthKv(db).get(joinAuthKey(["oauth:refresh", "acct_own", "tok1"]))).toBeNull();
  });

  it("redeeming a code writes the OpenAuth credential and clears the forced-change flag", async () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    const code = boot.ownerSetupCode!;
    db.$client.prepare("UPDATE users SET password_must_change = 1 WHERE id = ?").run(boot.ownerUserId);
    const outcome = await redeemAuthCodeAndSetPassword(db, {
      email: "owner@x.test",
      purpose: "setup",
      code,
      password: "chosen-password-1",
    });
    expect(outcome).toEqual({ ok: true, userId: boot.ownerUserId });
    expect(await verifyOpenAuthPassword(db, "owner@x.test", "chosen-password-1")).toBe(true);
    const row = db.$client.prepare("SELECT password_must_change f, status FROM users WHERE id = ?").get(boot.ownerUserId) as {
      f: number;
      status: string;
    };
    expect(row.f).toBe(0);
    expect(row.status).toBe("pending"); // activation happens on first LOGIN, not here
  });
});

// ---------------------------------------------------------------------------

describe("identity linking (resolveAuthSuccess)", () => {
  it("activates a pending user and binds the subject exactly once", async () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    const first = await resolveAuthSuccess(db, "Owner@X.test");
    expect(first.status).toBe("linked");
    const subject = (first as { subject: string }).subject;
    expect(subject).toMatch(/^acct_/);
    const row = db.$client.prepare("SELECT status, auth_subject s FROM users WHERE id = ?").get(boot.ownerUserId) as {
      status: string;
      s: string;
    };
    expect(row.status).toBe("active");
    expect(row.s).toBe(subject);
    // Subsequent logins resolve by the SAME subject (bound once).
    const again = await resolveAuthSuccess(db, "owner@x.test");
    expect(again).toEqual({ status: "linked", userId: boot.ownerUserId, subject });
  });

  it("rejects unknown verified emails (not invited) and disabled users", async () => {
    bootstrap(db, { ownerEmail: "owner@x.test" });
    expect(await resolveAuthSuccess(db, "stranger@elsewhere.test")).toEqual({ status: "not_invited" });
    db.$client.prepare("UPDATE users SET status = 'disabled', disabled_at = 't' WHERE email = 'owner@x.test'").run();
    expect(await resolveAuthSuccess(db, "owner@x.test")).toEqual({ status: "disabled" });
  });
});

// ---------------------------------------------------------------------------

describe("sessions linked to the OpenAuth subject", () => {
  it("stores the subject + refresh link, resolves flags, and logout revokes the refresh token", async () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    db.$client.prepare("UPDATE users SET status = 'active', auth_subject = 'acct_s1' WHERE id = ?").run(boot.ownerUserId);
    await sqliteAuthKv(db).set(joinAuthKey(["oauth:refresh", "acct_s1", "r1"]), "{}", null);

    const { token } = createSession(db, boot.ownerUserId, { authSubject: "acct_s1", authRefresh: "acct_s1:r1" });
    const session = resolveSession(db, token)!;
    expect(session.authSubject).toBe("acct_s1");
    expect(session.passwordMustChange).toBe(false);
    expect(session.user.status).toBe("active");

    destroySession(db, token);
    expect(resolveSession(db, token)).toBeNull();
    expect(await sqliteAuthKv(db).get(joinAuthKey(["oauth:refresh", "acct_s1", "r1"]))).toBeNull();
  });

  it("never resolves pending or disabled users", () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    const { token } = createSession(db, boot.ownerUserId);
    expect(resolveSession(db, token)).toBeNull(); // pending (bootstrap default)
    db.$client.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(boot.ownerUserId);
    expect(resolveSession(db, token)).toBeNull();
    db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(boot.ownerUserId);
    expect(resolveSession(db, token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("forced password change gate", () => {
  it("runtime.run refuses every catalog operation with password_change_required", async () => {
    const runtime = createRuntime(memoryDb());
    const { workspaceId, ownerUserId } = runtime.bootstrapResult;
    runtime.db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(ownerUserId);
    const ctx = { ...systemContext(workspaceId), actorType: "human" as const, userId: ownerUserId, surface: "web" as const };

    expect((await runtime.run(ctx, "company.list", {})).status).toBe("ok");

    await runtime.portsFor(workspaceId).credentials.mustChangePassword(ownerUserId, true);
    const blocked = await runtime.run(ctx, "company.list", {});
    expect(blocked).toMatchObject({ status: "error", error: { code: "password_change_required" } });
    // Agents acting on behalf of the flagged user are blocked identically.
    const agentCtx = { ...ctx, actorType: "agent" as const, clientId: "client-x", surface: "mcp_http" as const };
    expect(await runtime.run(agentCtx, "company.list", {})).toMatchObject({
      status: "error",
      error: { code: "password_change_required" },
    });

    await runtime.portsFor(workspaceId).credentials.mustChangePassword(ownerUserId, false);
    expect((await runtime.run(ctx, "company.list", {})).status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------

describe("bootstrap + delivery seam", () => {
  it("bootstrap emits a setup code, never any password field", () => {
    const boot = bootstrap(db, { ownerEmail: "owner@x.test" });
    expect(boot.ownerSetupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Object.keys(boot).some((k) => k.toLowerCase().includes("password"))).toBe(false);
  });

  it("deliverAuthCode is display-mode without EMCP_AUTH_DELIVERY_URL and posts when set", async () => {
    const prevUrl = process.env.EMCP_AUTH_DELIVERY_URL;
    const prevKey = process.env.EMCP_AUTH_DELIVERY_KEY;
    delete process.env.EMCP_AUTH_DELIVERY_URL;
    delete process.env.EMCP_AUTH_DELIVERY_KEY;
    const received: Array<{ auth: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: unknown) => (raw += String(chunk)));
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(received.length > 1 ? 500 : 200).end("{}");
      });
    });
    try {
      expect(await deliverAuthCode({ email: "a@x.test", code: "C-1", purpose: "setup" })).toEqual({ mode: "display" });

      // Hosted mode: POSTs {email, code, purpose} with the bearer key.
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port; // ephemeral test port
      process.env.EMCP_AUTH_DELIVERY_URL = `http://127.0.0.1:${port}/codes`;
      process.env.EMCP_AUTH_DELIVERY_KEY = "seam-key-1";
      expect(await deliverAuthCode({ email: "B@X.test", code: "AAAA-BBBB-CCCC", purpose: "reset" })).toEqual({
        mode: "delivered",
      });
      expect(received[0]).toEqual({
        auth: "Bearer seam-key-1",
        body: { email: "b@x.test", code: "AAAA-BBBB-CCCC", purpose: "reset" },
      });
      // Non-2xx is a hard failure and the error never contains the code.
      await expect(deliverAuthCode({ email: "b@x.test", code: "SECRET-CODE-42", purpose: "reset" })).rejects.toThrow(
        /delivery failed/,
      );
      await expect(deliverAuthCode({ email: "b@x.test", code: "SECRET-CODE-42", purpose: "reset" })).rejects.not.toThrow(
        /SECRET-CODE-42/,
      );
    } finally {
      server.close();
      if (prevUrl !== undefined) process.env.EMCP_AUTH_DELIVERY_URL = prevUrl;
      else delete process.env.EMCP_AUTH_DELIVERY_URL;
      if (prevKey !== undefined) process.env.EMCP_AUTH_DELIVERY_KEY = prevKey;
      else delete process.env.EMCP_AUTH_DELIVERY_KEY;
    }
  });
});
