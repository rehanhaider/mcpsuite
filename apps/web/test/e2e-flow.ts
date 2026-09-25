/**
 * The sign-in-to-MCP flow of issue #4 step 8, driven through the real route
 * handlers (no server, no browser), identical on every database adapter:
 *
 *   redeem the setup code → sign in → /api/me → an operation through
 *   /api/ops → create an API key → call an MCP tool with it.
 *
 * The caller seeds the workspace and points the process runtime at its
 * database (DB_PATH or DATABASE_URL) before calling this.
 */
import { expect } from "vitest";
import { Route as AuthRoute } from "../src/routes/api.auth.$.ts";
import { Route as MeRoute } from "../src/routes/api.me.ts";
import { Route as OpsRoute } from "../src/routes/api.ops.$name.ts";
import { Route as McpRoute } from "../src/routes/mcp.ts";

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handlers = (route: unknown): Record<string, Handler> =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers;

const ORIGIN = "http://e2e.local"; // never bound to a socket

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

export async function runSignInToMcpFlow(seed: { email: string; setupCode: string; workspaceId: string }): Promise<void> {
  const password = "e2e-chosen-password-1";

  // 1. Redeem the setup code.
  const redeemed = await handlers(AuthRoute).POST!({
    request: postJson("/api/auth/set-password", { email: seed.email, code: seed.setupCode, purpose: "setup", password }),
    params: {},
  });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toEqual({ ok: true });

  // 2. Sign in.
  const login = await handlers(AuthRoute).POST!({
    request: postJson("/api/auth/login", { email: seed.email, password }),
    params: {},
  });
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ ok: true, provisioned: true, mustChangePassword: false });
  const sessionCookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0]!)
    .find((c) => c.startsWith("mcpsuite_session="));
  expect(sessionCookie).toBeDefined();
  const cookie = { cookie: sessionCookie! };

  // 3. /api/me reports the signed-in user.
  const me = await handlers(MeRoute).GET!({ request: new Request(`${ORIGIN}/api/me`, { headers: cookie }), params: {} });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({
    email: seed.email,
    workspaceId: seed.workspaceId,
    role: "owner",
    provisioned: true,
    accessMode: "active",
  });

  // 4. An operation through /api/ops.
  const created = await handlers(OpsRoute).POST!({
    request: postJson("/api/ops/company.create", { name: "E2E Company" }, cookie),
    params: { name: "company.create" },
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ status: "ok" });

  // 5. An API key for an agent.
  const keyed = await handlers(OpsRoute).POST!({
    request: postJson("/api/ops/mcpClient.create", { name: "E2E agent", scopes: ["read", "write"] }, cookie),
    params: { name: "mcpClient.create" },
  });
  expect(keyed.status).toBe(200);
  const apiKey = ((await keyed.json()) as { data: { token: string } }).data.token;
  expect(apiKey).toMatch(/^mcpsuite_/);

  // 6. Call an MCP tool with that key.
  const mcp = (body: unknown) =>
    handlers(McpRoute).POST!({
      request: postJson("/mcp", body, {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
      }),
      params: {},
    });
  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } },
  });
  expect(init.status).toBe(200);
  const call = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "company_list", arguments: {} } });
  expect(call.status).toBe(200);
  const result = ((await call.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean } }).result;
  expect(result?.isError).toBeFalsy();
  expect(result?.content?.[0]?.text).toContain("E2E Company");
}
