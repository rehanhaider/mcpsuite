/**
 * The shared web-standard /mcp request handler (handler.ts) — the one code
 * path behind both the in-process mount (apps/web /mcp route) and the
 * standalone HTTP server. Exercised against a real SQLite file in a temp
 * directory (never data/), no ports: requests go straight to the function.
 *
 * Pinned here: method gating, the exact 401 shape, the non-SQLite 501 guard,
 * a full authorized JSON-RPC roundtrip, and the locked-workspace rejection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@emcp/core";
import { createRuntime, openDatabase, type AnyRuntime, type Db, type Runtime } from "@emcp/db";
import { handleMcpRequest } from "../src/handler.ts";
import { SERVER_INFO, WORKSPACE_LOCKED_RPC_CODE } from "../src/server.ts";

let dir: string;
let db: Db;
let runtime: Runtime;
let workspaceId: string;
let apiKey: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "emcp-mcp-handler-"));
  db = openDatabase(join(dir, "handler-test.db"));
  runtime = createRuntime(db);
  workspaceId = runtime.bootstrapResult.workspaceId;
  // The bootstrap owner starts "pending" (setup code not yet redeemed); an
  // MCP key is inert until its creator is active, so activate the owner the
  // way the identity tests do.
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(runtime.bootstrapResult.ownerUserId);
  const ctx: RequestContext = {
    workspaceId,
    actorType: "agent",
    userId: runtime.bootstrapResult.ownerUserId,
    clientId: "test-client",
    role: "owner",
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "mcp_http",
  };
  const created = await runtime.run(ctx, "mcpClient.create", {
    name: "handler-test-agent",
    scopes: ["read", "write"],
    trust: "fully_authorized_agent",
  });
  if (created.status !== "ok") throw new Error(`mcpClient.create failed: ${JSON.stringify(created)}`);
  apiKey = (created.data as { token: string }).token;
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://emcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function rpc(method: string, params: Record<string, unknown> = {}, id: number = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

const INITIALIZE = rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "handler-test", version: "0.0.0" },
});

/** Simulates hosting control having run: its table + one access row. */
function setAccess(mode: "active" | "locked"): void {
  db.$client.exec(`CREATE TABLE IF NOT EXISTS hc_workspace_access (
    workspace_id      TEXT PRIMARY KEY,
    access_mode       TEXT NOT NULL DEFAULT 'active',
    access_expires_at TEXT,
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  db.$client
    .prepare(
      `INSERT INTO hc_workspace_access (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
       VALUES (?, ?, NULL, 1, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET access_mode = excluded.access_mode`,
    )
    .run(workspaceId, mode, now, now);
}

describe("handleMcpRequest", () => {
  it("answers non-POST with 405 and an allow header (stateless: no SSE/session)", async () => {
    const res = await handleMcpRequest(new Request("http://emcp.test/mcp"), runtime);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("rejects a missing key with the standalone server's exact 401 shape", async () => {
    const res = await handleMcpRequest(mcpRequest(INITIALIZE, { authorization: "" }), runtime);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "Send Authorization: Bearer <emcp API key> — create one in the web UI under Admin → Agents.",
    });
  });

  it("rejects an unknown key with 401", async () => {
    const res = await handleMcpRequest(mcpRequest(INITIALIZE, { authorization: "Bearer emcp_bogus" }), runtime);
    expect(res.status).toBe(401);
  });

  it("answers 501 mcp_unavailable on a non-SQLite runtime instead of crashing", async () => {
    const hosted = { adapter: "postgres" } as unknown as AnyRuntime;
    const res = await handleMcpRequest(mcpRequest(INITIALIZE), hosted);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toBe("mcp_unavailable");
  });

  it("serves an authorized initialize + tools/list JSON-RPC roundtrip", async () => {
    const init = await handleMcpRequest(mcpRequest(INITIALIZE), runtime);
    expect(init.status).toBe(200);
    const initPayload = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(initPayload.result.serverInfo.name).toBe(SERVER_INFO.name);

    const list = await handleMcpRequest(
      mcpRequest(rpc("tools/list", {}, 2), { "mcp-protocol-version": "2025-03-26" }),
      runtime,
    );
    expect(list.status).toBe(200);
    const listPayload = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listPayload.result.tools.map((t) => t.name)).toContain("company_list");
  });

  it("rejects tool calls for a locked workspace at the JSON-RPC layer", async () => {
    setAccess("locked");
    const res = await handleMcpRequest(
      mcpRequest(rpc("tools/call", { name: "company_list", arguments: {} }, 3), {
        "mcp-protocol-version": "2025-03-26",
      }),
      runtime,
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { error: { code: number; data: { code: string } } };
    expect(payload.error.code).toBe(WORKSPACE_LOCKED_RPC_CODE);
    expect(payload.error.data.code).toBe("workspace_locked");
  });
});
