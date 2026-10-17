/** Issue #52: exercise the real mounted issuer, cookies, and adapter storage. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CODE_ISSUE_MAX,
  AUTH_CODE_ISSUE_WINDOW_MS,
  AUTH_CODE_MAX_ATTEMPTS,
  createOpenAuthStorage,
  createSqliteIdentity,
  openAuthHashPassword,
  openAuthVerifyPassword,
  openDatabase,
  type Db,
  type IdentityStore,
  type OpenAuthScryptHash,
} from "@mcpsuite/db";
import { createPgIdentity } from "../../../packages/db/src/pg/identity.ts";
import { initPgSchema } from "../../../packages/db/src/pg/init.ts";
import { connectPg, type PgHandle } from "../../../packages/db/src/pg/repositories.ts";
import { dropTestDatabase, setTestRolePassword } from "../../../packages/db/test/pg-test-support.ts";
import { handleAuthRequest, resetAuthAppCache } from "../src/server/auth-issuer.ts";

const ORIGIN = "http://localhost:7777";
const PASSWORD = "chosen-password-52";
const PG_ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
type Flow = "register" | "change";

for (const adapter of ["sqlite", "postgres"] as const) {
  describe.runIf(adapter === "sqlite" || PG_ENABLED)(`issuer code limits, ${adapter}`, { timeout: 60_000 }, () => {
    let identity: IdentityStore;
    let sqlite: Db | undefined;
    let dir: string;
    let root: PgHandle;
    let admin: PgHandle;
    let app: PgHandle;
    let serial = 0;
    let sent: Array<{ email: string; code: string }>;
    const databaseName = `mcpsuite_web_code_limits_${process.pid}`;

    beforeAll(async () => {
      if (adapter === "sqlite") {
        dir = mkdtempSync(join(tmpdir(), "mcpsuite-code-limits-"));
        return;
      }
      root = await connectPg({ databaseUrl: process.env.DATABASE_URL!, max: 1 });
      await root.pool.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${databaseName}`;
      admin = await connectPg({ databaseUrl: url.toString(), max: 1 });
      await initPgSchema(admin.pool);
      await setTestRolePassword(admin.pool, "crm_app", "crm_app_test_pw");
      url.username = "crm_app";
      url.password = "crm_app_test_pw";
      app = await connectPg({ databaseUrl: url.toString(), max: 2 });
    }, 120_000);

    beforeEach(() => {
      serial++;
      identity = adapter === "sqlite"
        ? createSqliteIdentity(sqlite = openDatabase(join(dir, `${serial}.db`)))
        : createPgIdentity(app.db);
      resetAuthAppCache();
      vi.stubEnv("MCPSUITE_AUTH_SIGNUP_URL", `${ORIGIN}/signup`);
      vi.stubEnv("MCPSUITE_AUTH_DELIVERY_URL", "");
      sent = [];
      // Observe the actual self-host delivery channel; do not replace sendCode.
      vi.spyOn(console, "log").mockImplementation((message: unknown) => {
        const match = /^\[mcpsuite\] verification code for (.*): (\d{6})$/.exec(String(message));
        if (match) sent.push({ email: match[1]!, code: match[2]! });
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      resetAuthAppCache();
      sqlite?.$client.close();
    });

    afterAll(async () => {
      if (adapter === "sqlite") {
        if (dir) rmSync(dir, { recursive: true, force: true });
        return;
      }
      await app?.close();
      await admin?.close();
      if (root) {
        await dropTestDatabase(root, databaseName);
        await root.close();
      }
    });

    class Browser {
      cookies = new Map<string, string>();
      async request(path: string, data?: Record<string, string>): Promise<Response> {
        const response = await handleAuthRequest(identity, new Request(`${ORIGIN}${path}`, {
          method: data ? "POST" : "GET",
          headers: {
            cookie: [...this.cookies.values()].join("; "),
            ...(data ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          body: data ? new URLSearchParams(data).toString() : undefined,
          redirect: "manual",
        }));
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";", 1)[0]!;
          this.cookies.set(pair.split("=", 1)[0]!, pair);
        }
        expect(response.status).toBe(302);
        return response;
      }
    }

    const params = (response: Response) => new URL(response.headers.get("location")!, ORIGIN).searchParams;
    const emailFor = (flow: Flow, suffix = "main") => `${adapter}-${serial}-${flow}-${suffix}@limits.test`;
    const submitCode = (flow: Flow, email: string) => flow === "register"
      ? { action: "register", email, password: PASSWORD, repeat: PASSWORD }
      : { action: "code", email };

    async function start(flow: Flow, email: string): Promise<Browser> {
      const browser = new Browser();
      if (flow === "register") {
        await browser.request(`/api/auth/authorize?client_id=crm-web&response_type=code&provider=password&redirect_uri=${encodeURIComponent(`${ORIGIN}/api/auth/callback`)}`);
      } else {
        await createOpenAuthStorage(identity.authKv).set(["email", email, "password"], openAuthHashPassword("previous-password"));
      }
      expect(params(await browser.request(`/api/auth/password/${flow}?redirect_uri=${encodeURIComponent(`${ORIGIN}/login`)}`)).get("state")).toBe("start");
      return browser;
    }

    async function complete(flow: Flow, browser: Browser, code: string, email: string): Promise<void> {
      const verified = await browser.request(`/api/auth/password/${flow}`, { action: "verify", code });
      expect(params(verified).get("error")).toBeNull();
      if (flow === "register") {
        expect(verified.headers.get("location")).toMatch(/^http:\/\/localhost:7777\/api\/auth\/callback\?code=/);
      } else {
        expect(params(verified).get("state")).toBe("update");
        const updated = await browser.request("/api/auth/password/change", { action: "update", password: PASSWORD, repeat: PASSWORD });
        expect(updated.headers.get("location")).toBe(`${ORIGIN}/login`);
      }
      const stored = await createOpenAuthStorage(identity.authKv).get(["email", email, "password"]);
      expect(stored).toBeDefined();
      expect(openAuthVerifyPassword(PASSWORD, stored as unknown as OpenAuthScryptHash)).toBe(true);
    }

    for (const flow of ["register", "change"] as const) {
      it(`${flow}: ten failures block the correct code and cookie replay; a new code succeeds`, async () => {
        const email = emailFor(flow);
        const browser = await start(flow, email);
        const path = `/api/auth/password/${flow}`;
        expect(params(await browser.request(path, submitCode(flow, email))).get("state")).toBe("code");
        expect(sent).toHaveLength(1);
        const code = sent[0]!.code;
        const savedCookies = new Map(browser.cookies);
        const wrong = code === "000000" ? "111111" : "000000";
        for (let n = 0; n < AUTH_CODE_MAX_ATTEMPTS; n++) {
          expect(params(await browser.request(path, { action: "verify", code: wrong })).get("error")).toBe("invalid_code");
        }
        const blocked = params(await browser.request(path, { action: "verify", code }));
        expect(blocked.get("error")).toBe("too_many_attempts");
        expect(blocked.get("state")).toBe("start");
        // A fresh issuer instance and the original cookie still see the DB count.
        resetAuthAppCache();
        const replay = new Browser();
        replay.cookies = savedCookies;
        expect(params(await replay.request(path, { action: "verify", code })).get("error")).toBe("too_many_attempts");
        // The blocked browser must obtain a new code before it can proceed.
        expect(params(await browser.request(path, { action: "verify", code })).get("state")).toBe("start");
        expect(params(await browser.request(path, submitCode(flow, email))).get("state")).toBe("code");
        expect(sent).toHaveLength(2);
        await complete(flow, browser, sent[1]!.code, email);
      });

      it(`${flow}: caps initial sends and resends at five per normalized email; another email succeeds`, async () => {
        const email = emailFor(flow);
        const browser = await start(flow, email);
        const path = `/api/auth/password/${flow}`;
        for (let n = 0; n < AUTH_CODE_ISSUE_MAX; n++) {
          expect(params(await browser.request(path, submitCode(flow, email))).get("error")).toBeNull();
        }
        expect(sent).toHaveLength(AUTH_CODE_ISSUE_MAX);
        expect(params(await browser.request(path, submitCode(flow, email))).get("error")).toBe("too_many_codes");
        expect(sent).toHaveLength(AUTH_CODE_ISSUE_MAX);
        // Register resends use the cookie email, regardless of the submitted email.
        expect(params(await browser.request(path, submitCode(flow, "bypass@limits.test"))).get("error")).toBe(flow === "register" ? "too_many_codes" : null);
        const prior = sent.length;
        expect(params(await browser.request(path, submitCode(flow, ` ${email.toUpperCase()} `))).get("error")).toBe("too_many_codes");
        expect(sent).toHaveLength(prior);
        // Starting over with new cookies cannot bypass the initial-send limit.
        const fresh = await start(flow, email);
        expect(params(await fresh.request(path, submitCode(flow, email.toUpperCase()))).get("error")).toBe("too_many_codes");
        expect(sent).toHaveLength(prior);
        const other = emailFor(flow, "other");
        const independent = await start(flow, other);
        expect(params(await independent.request(path, submitCode(flow, other))).get("state")).toBe("code");
        expect(sent).toHaveLength(prior + 1);
      });

      it(`${flow}: sends resume after the issue window`, async () => {
        const email = emailFor(flow);
        const browser = await start(flow, email);
        const path = `/api/auth/password/${flow}`;
        for (let n = 0; n < AUTH_CODE_ISSUE_MAX; n++) await browser.request(path, submitCode(flow, email));
        expect(params(await browser.request(path, submitCode(flow, email))).get("error")).toBe("too_many_codes");
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + AUTH_CODE_ISSUE_WINDOW_MS + 1);
        expect(params(await browser.request(path, submitCode(flow, email))).get("state")).toBe("code");
        expect(sent).toHaveLength(AUTH_CODE_ISSUE_MAX + 1);
      });
    }

    it("shares the send limit between register and change", async () => {
      const email = emailFor("register");
      const register = await start("register", email);
      for (let n = 0; n < AUTH_CODE_ISSUE_MAX; n++) await register.request("/api/auth/password/register", submitCode("register", email));
      const change = await start("change", email);
      expect(params(await change.request("/api/auth/password/change", submitCode("change", email))).get("error")).toBe("too_many_codes");
      expect(sent).toHaveLength(AUTH_CODE_ISSUE_MAX);
    });

    it("does not count registration submissions that send no code", async () => {
      const email = emailFor("register");
      const browser = await start("register", email);
      for (let n = 0; n <= AUTH_CODE_ISSUE_MAX; n++) {
        expect(params(await browser.request("/api/auth/password/register", { action: "register", email, password: "short", repeat: "short" })).get("error")).toBe("validation_error");
      }
      expect(sent).toHaveLength(0);
      expect(params(await browser.request("/api/auth/password/register", submitCode("register", email))).get("state")).toBe("code");
      expect(sent).toHaveLength(1);
    });
  });
}
