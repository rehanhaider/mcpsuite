/**
 * The hosted workspace lifecycle of issue #5 step 8, identical on every
 * database adapter. Hosting control runs as its own process (its real entry
 * point, src/main.ts, choosing its adapter from its own environment); the CRM
 * side is driven through the real route handlers (no server, no browser):
 *
 *   provision through the hosting API (pending owner) → redeem the setup
 *   code → sign in → lock, and the CRM refuses → unlock → transfer ownership
 *   → delete, and the workspace is gone with its service audit redacted.
 *
 * The caller points the web runtime at its database (DB_PATH or DATABASE_URL)
 * and passes hosting control's own environment.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { Route as AuthRoute } from "../src/routes/api.auth.$.ts";
import { Route as MeRoute } from "../src/routes/api.me.ts";
import { Route as OpsRoute } from "../src/routes/api.ops.$name.ts";
import { Route as McpRoute } from "../src/routes/mcp.ts";

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handlers = (route: unknown): Record<string, Handler> =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers;

const ORIGIN = "http://e2e.local"; // never bound to a socket
const HC_KEY = "hc_e2e_service_key_0123456789abcdef";
const HC_DIR = fileURLToPath(new URL("../../../packages/hosting-control/", import.meta.url));
const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export interface HostingE2eDatabase {
  /** The adapter hosting control must report at startup. */
  adapter: "sqlite" | "postgres";
  /** Hosting control's database environment: DB_PATH, or its own crm_operator DATABASE_URL. */
  hostingEnv: Record<string, string>;
  /** Rows, read with full visibility: the workspace row, and its service audit by id and by hash. */
  workspaceRows(workspaceId: string): Promise<number>;
  serviceAuditRows(by: { workspaceId: string } | { targetHash: string }): Promise<number>;
}

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Start hosting control on an ephemeral port; resolves once it is listening. */
async function startHostingControl(
  env: Record<string, string>,
): Promise<{ url: string; adapter: string; stop(): Promise<void> }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.DB_PATH;
  delete childEnv.MCPSUITE_AUTH_DELIVERY_URL;
  delete childEnv.MCPSUITE_AUTH_DELIVERY_KEY;
  Object.assign(childEnv, env, { HC_SERVICE_KEY: HC_KEY, HC_HOST: "127.0.0.1", HC_PORT: "0" });
  const child: ChildProcess = spawn(`${HC_DIR}node_modules/.bin/tsx`, ["src/main.ts"], {
    cwd: HC_DIR,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const started = await new Promise<{ url: string; adapter: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hosting control did not start:\n${output}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)\/api\/v1 \((\w+);/);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[1]!, adapter: match[2]! });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hosting control exited (${code}):\n${output}`));
    });
  });
  return {
    ...started,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

export async function runHostingLifecycleFlow(database: HostingE2eDatabase): Promise<void> {
  const hc = await startHostingControl(database.hostingEnv);
  try {
    expect(hc.adapter).toBe(database.adapter);
    let seq = 0;
    const hosting = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${hc.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${HC_KEY}`,
          "idempotency-key": `e2e-${++seq}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    const signIn = async (email: string, password: string): Promise<{ cookie: string }> => {
      const login = await handlers(AuthRoute).POST!({ request: postJson("/api/auth/login", { email, password }), params: {} });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((c) => c.split(";", 1)[0]!)
        .find((c) => c.startsWith("mcpsuite_session="));
      expect(cookie).toBeDefined();
      return { cookie: cookie! };
    };
    const setPassword = async (email: string, code: string, password: string): Promise<void> => {
      const res = await handlers(AuthRoute).POST!({
        request: postJson("/api/auth/set-password", { email, code, purpose: "setup", password }),
        params: {},
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    };
    const me = async (cookie: { cookie: string }) =>
      handlers(MeRoute).GET!({ request: new Request(`${ORIGIN}/api/me`, { headers: cookie }), params: {} });
    const op = async (cookie: { cookie: string }, name: string, input: unknown) =>
      handlers(OpsRoute).POST!({ request: postJson(`/api/ops/${name}`, input, cookie), params: { name } });

    // 1. Provision through the hosting API: the owner starts pending.
    const ownerEmail = "owner@e2e-hosting.test";
    const provisioned = await hosting("POST", "/api/v1/workspaces", {
      organizationName: "E2E Hosted",
      ownerEmail,
      ownerName: "Hosted Owner",
    });
    expect(provisioned.status).toBe(201);
    const { workspaceId, ownerUserId, ownerStatus, setupCode } = provisioned.json.data;
    expect(ownerStatus).toBe("pending");
    expect(setupCode).toBeTruthy();

    // 2. Redeem the setup code and sign in.
    await setPassword(ownerEmail, setupCode, "hosted-owner-password-1");
    const owner = await signIn(ownerEmail, "hosted-owner-password-1");
    expect(await (await me(owner)).json()).toMatchObject({ userId: ownerUserId, workspaceId, role: "owner", accessMode: "active" });
    expect((await op(owner, "company.create", { name: "Hosted Company" })).status).toBe(200);
    const keyed = await op(owner, "mcpClient.create", { name: "Hosted agent", scopes: ["read"] });
    const apiKey = ((await keyed.json()) as { data: { token: string } }).data.token;
    const mcpCall = async () => {
      const res = await handlers(McpRoute).POST!({
        request: postJson(
          "/mcp",
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "company_list", arguments: {} } },
          { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream" },
        ),
        params: {},
      });
      return (await res.json()) as { result?: { isError?: boolean }; error?: { code: number } };
    };
    expect((await mcpCall()).result?.isError).toBeFalsy();

    // 3. Lock: the CRM refuses operations and tool calls; /api/me reports it.
    expect((await hosting("PUT", `/api/v1/workspaces/${workspaceId}/access`, { accessMode: "locked", reason: "e2e" })).status).toBe(200);
    expect(await (await me(owner)).json()).toMatchObject({ accessMode: "locked" });
    const refused = await op(owner, "company.list", {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ status: "error", error: { code: "workspace_locked" } });
    expect((await mcpCall()).error?.code).toBe(-32003);

    // 4. Unlock: work resumes.
    expect((await hosting("PUT", `/api/v1/workspaces/${workspaceId}/access`, { accessMode: "active", reason: "e2e" })).status).toBe(200);
    expect((await op(owner, "company.list", {})).status).toBe(200);
    expect((await mcpCall()).result?.isError).toBeFalsy();

    // 5. Transfer ownership to an invited member who has signed in.
    const memberEmail = "member@e2e-hosting.test";
    const invited = await op(owner, "user.create", { name: "Hosted Member", email: memberEmail, role: "admin" });
    expect(invited.status).toBe(200);
    const memberCode = ((await invited.json()) as { data: { setupCode: string } }).data.setupCode;
    await setPassword(memberEmail, memberCode, "hosted-member-password-1");
    const member = await signIn(memberEmail, "hosted-member-password-1");
    const transferred = await hosting("PUT", `/api/v1/workspaces/${workspaceId}/owner`, { targetEmail: memberEmail, reason: "e2e" });
    expect(transferred.status).toBe(200);
    expect(transferred.json.data.previousOwnerUserId).toBe(ownerUserId);
    expect(await (await me(member)).json()).toMatchObject({ role: "owner", workspaceId });
    expect(await (await me(owner)).json()).toMatchObject({ role: "admin", workspaceId });

    // 6. Delete: the workspace, its users and their sign-ins are gone; the
    //    service audit keeps only the one-way hash.
    expect(await database.serviceAuditRows({ workspaceId })).toBeGreaterThan(0);
    expect((await hosting("DELETE", `/api/v1/workspaces/${workspaceId}`, { reason: "e2e" })).status).toBe(204);
    expect(await database.workspaceRows(workspaceId)).toBe(0);
    expect((await me(owner)).status).toBe(401);
    expect((await me(member)).status).toBe(401);
    const again = await handlers(AuthRoute).POST!({
      request: postJson("/api/auth/login", { email: ownerEmail, password: "hosted-owner-password-1" }),
      params: {},
    });
    expect(again.status).not.toBe(200);
    expect(await database.serviceAuditRows({ workspaceId })).toBe(0);
    expect(await database.serviceAuditRows({ targetHash: sha256Hex(workspaceId) })).toBeGreaterThan(0);
    expect((await hosting("GET", `/api/v1/workspaces/${workspaceId}`)).status).toBe(404);
  } finally {
    await hc.stop();
  }
}
