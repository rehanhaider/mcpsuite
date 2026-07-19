/**
 * The dev-loop login proof (docs/auth-api.md): drives the real OpenAuth
 * issuer + CRM first-party endpoints entirely through the Fetch handler —
 * no HTTP server, no browser. Covers the in-process password login, the
 * browser-style authorize/callback dance, code redemption, logout, the
 * not-invited rejection, and the forced-change signal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrap,
  createPorts,
  openDatabase,
  resolveSession,
  sqliteAuthKv,
  joinAuthKey,
  setOpenAuthPassword,
  type Db,
} from "@emcp/db";
import {
  handleAuthRequest,
  performPasswordLogin,
  resetAuthAppCache,
  sessionFromRequest,
} from "../src/server/auth-issuer.ts";

const tmp = mkdtempSync(join(tmpdir(), "emcp-web-auth-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ORIGIN = "http://localhost:7777"; // test-only origin, never bound to a socket

let db: Db;
let ownerEmail: string;
let ownerSetupCode: string;
let ownerUserId: string;
let workspaceId: string;
let n = 0;

beforeEach(() => {
  db = openDatabase(join(tmp, `auth-${++n}.db`));
  ownerEmail = "owner@flow.test";
  const boot = bootstrap(db, { ownerEmail, ownerName: "Owner" });
  ownerSetupCode = boot.ownerSetupCode!;
  ownerUserId = boot.ownerUserId;
  workspaceId = boot.workspaceId;
  resetAuthAppCache();
});

function req(path: string, init?: RequestInit & { cookies?: string[] }): Request {
  const headers = new Headers(init?.headers);
  if (init?.cookies?.length) headers.set("cookie", init.cookies.join("; "));
  return new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

function form(data: Record<string, string>): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams(data).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

function setCookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";", 1)[0]!);
}

async function redeemSetupCode(password = "chosen-password-1"): Promise<void> {
  const res = await handleAuthRequest(
    db,
    req("/api/auth/set-password", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, code: ownerSetupCode, purpose: "setup", password }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
}

describe("in-process password login", () => {
  it("setup code → password → login → subject-linked session; bad passwords fail", async () => {
    await redeemSetupCode();

    const wrong = await performPasswordLogin(db, { email: ownerEmail, password: "wrong-password" });
    expect(wrong).toEqual({ ok: false, error: "invalid_credentials" });

    const login = await performPasswordLogin(db, { email: ownerEmail, password: "chosen-password-1" });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.mustChangePassword).toBe(false);

    // The session resolves to the CURRENT user and carries the subject.
    const session = resolveSession(db, login.sessionToken)!;
    expect(session.user.email).toBe(ownerEmail);
    expect(session.user.status).toBe("active");
    expect(session.role).toBe("owner");
    expect(session.authSubject).toMatch(/^acct_/);

    // First login ACTIVATED the pending owner and bound the subject once…
    const again = await performPasswordLogin(db, { email: ownerEmail, password: "chosen-password-1" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(resolveSession(db, again.sessionToken)!.authSubject).toBe(session.authSubject);
  });

  it("rejects verified-but-unknown emails as not invited", async () => {
    // A credential exists in OpenAuth storage but no CRM user was invited.
    await setOpenAuthPassword(db, "stranger@flow.test", "stranger-pass-1");
    const res = await performPasswordLogin(db, { email: "stranger@flow.test", password: "stranger-pass-1" });
    expect(res).toEqual({ ok: false, error: "not_invited" });
  });

  it("surfaces the forced-change flag and disabled accounts", async () => {
    await redeemSetupCode();
    const first = await performPasswordLogin(db, { email: ownerEmail, password: "chosen-password-1" });
    expect(first.ok).toBe(true);

    await createPorts(db, workspaceId).credentials.mustChangePassword(ownerUserId, true);
    const flagged = await performPasswordLogin(db, { email: ownerEmail, password: "chosen-password-1" });
    expect(flagged.ok && flagged.mustChangePassword).toBe(true);

    db.$client.prepare("UPDATE users SET status = 'disabled', disabled_at = 't' WHERE id = ?").run(ownerUserId);
    const disabled = await performPasswordLogin(db, { email: ownerEmail, password: "chosen-password-1" });
    expect(disabled).toEqual({ ok: false, error: "account_disabled" });
  });
});

describe("/api/auth/* endpoints", () => {
  it("POST /api/auth/login sets the emcp_session cookie; logout revokes it and the refresh token", async () => {
    await redeemSetupCode();
    const res = await handleAuthRequest(
      db,
      req("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: ownerEmail, password: "chosen-password-1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mustChangePassword: false, provisioned: true });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("emcp_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure"); // http request, no X-Forwarded-Proto

    const pairs = setCookiePairs(res);
    const session = sessionFromRequest(db, req("/app", { cookies: pairs }))!;
    expect(session.user.id).toBe(ownerUserId);

    // One refresh token exists for the subject; logout removes it + the row.
    const prefix = joinAuthKey(["oauth:refresh", session.authSubject!]);
    expect((await sqliteAuthKv(db).scanPrefix(prefix)).length).toBe(1);
    const out = await handleAuthRequest(db, req("/api/auth/logout", { method: "POST", cookies: pairs }));
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(sessionFromRequest(db, req("/app", { cookies: pairs }))).toBeNull();
    expect((await sqliteAuthKv(db).scanPrefix(prefix)).length).toBe(0);
  });

  it("honors X-Forwarded-Proto for the Secure attribute", async () => {
    await redeemSetupCode();
    const res = await handleAuthRequest(
      db,
      req("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: ownerEmail, password: "chosen-password-1" }),
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("drives the full browser-style authorize → password → callback dance", async () => {
    await redeemSetupCode();

    // 1. Start the flow at the mounted authorize endpoint.
    const start = await handleAuthRequest(
      db,
      req(
        `/api/auth/authorize?client_id=crm-web&redirect_uri=${encodeURIComponent(`${ORIGIN}/api/auth/callback`)}&response_type=code&provider=password`,
      ),
    );
    expect(start.status).toBe(302);
    // Issuer-internal redirect is re-prefixed onto the mount.
    expect(start.headers.get("location")).toBe("/api/auth/password/authorize");
    const flowCookies = setCookiePairs(start);
    expect(flowCookies.length).toBeGreaterThan(0);

    // 2. The provider's login screen is OUR /login page (custom UI redirect).
    const screen = await handleAuthRequest(db, req("/api/auth/password/authorize", { cookies: flowCookies }));
    expect(screen.status).toBe(302);
    expect(screen.headers.get("location")).toBe("/login?flow=1");

    // 3. Submitting bad credentials re-renders the login page with the error.
    const bad = await handleAuthRequest(
      db,
      req("/api/auth/password/authorize", { ...form({ email: ownerEmail, password: "nope-nope-nope" }), cookies: flowCookies }),
    );
    expect(bad.headers.get("location")).toContain("/login?flow=1&error=invalid_password");

    // 4. Correct credentials bounce back to the redirect_uri with a code…
    const good = await handleAuthRequest(
      db,
      req("/api/auth/password/authorize", { ...form({ email: ownerEmail, password: "chosen-password-1" }), cookies: flowCookies }),
    );
    const location = good.headers.get("location")!;
    expect(location.startsWith(`${ORIGIN}/api/auth/callback?`)).toBe(true);

    // 5. …and the callback exchanges it, mints the session, and enters /app.
    const callback = await handleAuthRequest(db, req(location.slice(ORIGIN.length)));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/app");
    const session = sessionFromRequest(db, req("/app", { cookies: setCookiePairs(callback) }))!;
    expect(session.user.id).toBe(ownerUserId);
    expect(session.authSubject).toMatch(/^acct_/);

    // An authorization code is single-use: replaying the callback fails safe.
    const replay = await handleAuthRequest(db, req(location.slice(ORIGIN.length)));
    expect(replay.headers.get("location")).toBe("/login?error=expired_flow");
  });

  it("serves discovery under the mount and rejects bad set-password codes", async () => {
    const discovery = await handleAuthRequest(db, req("/api/auth/.well-known/oauth-authorization-server"));
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer: ORIGIN });

    const bad = await handleAuthRequest(
      db,
      req("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ email: ownerEmail, code: "WRONG-CODE-XX", purpose: "setup", password: "long-enough-pw" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: "invalid_code" } });

    const short = await handleAuthRequest(
      db,
      req("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ email: ownerEmail, code: ownerSetupCode, purpose: "setup", password: "short" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ ok: false, error: { code: "weak_password" } });
  });
});
