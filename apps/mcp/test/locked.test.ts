/**
 * Hosted access enforcement over MCP, end-to-end through the SDK against a
 * real SQLite file in a temp directory (never data/), using linked in-memory
 * transports (no ports).
 *
 * Self-host invariant: with no hc_workspace_access table the server behaves
 * exactly as today. Locked workspaces: every tool call answers the
 * workspace_locked error envelope and every resource read fails with a
 * workspace_locked JSON-RPC error, while the connection itself (identify +
 * list) stays up.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestContext } from "@emcp/core";
import { createRuntime, openDatabase, type Db, type Runtime } from "@emcp/db";
import { createMcpServer, lockedRpcRejection, WORKSPACE_LOCKED_RPC_CODE } from "../src/server.ts";

let dir: string;
let db: Db;
let runtime: Runtime;
let workspaceId: string;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "emcp-mcp-lock-"));
  db = openDatabase(join(dir, "mcp-test.db"));
  runtime = createRuntime(db);
  workspaceId = runtime.bootstrapResult.workspaceId;
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
  const server = createMcpServer(runtime, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "lock-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Simulates hosting control having run: its table + one access row. */
function setAccess(mode: "active" | "locked", expiresAt: string | null): void {
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
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET access_mode = excluded.access_mode, access_expires_at = excluded.access_expires_at`,
    )
    .run(workspaceId, mode, expiresAt, now, now);
}

async function callCompanyList(): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name: "company_list", arguments: {} })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
}

describe("MCP hosted access enforcement", () => {
  it("works unchanged when hosting control never ran (no hc table)", async () => {
    const result = await callCompanyList();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toHaveProperty("total");
  });

  it("rejects tool calls for a locked workspace with the workspace_locked envelope", async () => {
    setAccess("locked", null);
    const result = await callCompanyList();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).error.code).toBe("workspace_locked");
  });

  it("rejects resource reads for a locked workspace with a workspace_locked JSON-RPC error", async () => {
    setAccess("locked", null);
    await expect(client.readResource({ uri: "emcp://pipelines" })).rejects.toThrow(/workspace_locked/);
    await expect(client.readResource({ uri: "emcp://catalog" })).rejects.toThrow(/workspace_locked/);
  });

  it("honors expiry at read time: future expiry passes, past expiry locks mid-session", async () => {
    setAccess("active", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    expect((await callCompanyList()).isError).toBe(false);

    setAccess("active", new Date(Date.now() - 1000).toISOString());
    const locked = await callCompanyList();
    expect(locked.isError).toBe(true);
    expect(JSON.parse(locked.text).error.code).toBe("workspace_locked");
  });
});

describe("lockedRpcRejection (HTTP transport pre-dispatch)", () => {
  it("rejects tool calls and resource reads with a JSON-RPC error, preserving the id", () => {
    const rejection = lockedRpcRejection({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string; data: { code: string } };
    };
    expect(rejection.id).toBe(7);
    expect(rejection.error.code).toBe(WORKSPACE_LOCKED_RPC_CODE);
    expect(rejection.error.message).toContain("workspace_locked");
    expect(rejection.error.data.code).toBe("workspace_locked");

    expect(lockedRpcRejection({ jsonrpc: "2.0", id: "r1", method: "resources/read", params: {} })).not.toBeNull();
  });

  it("lets identification and listing methods through, and ignores notifications", () => {
    expect(lockedRpcRejection({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBeNull();
    expect(lockedRpcRejection({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBeNull();
    expect(lockedRpcRejection({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toBeNull();
    expect(lockedRpcRejection({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(lockedRpcRejection(undefined)).toBeNull();
  });

  it("answers batches with one error per blocked request", () => {
    const rejection = lockedRpcRejection([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} },
      { jsonrpc: "2.0", method: "notifications/progress" },
    ]) as Array<{ id: number }>;
    expect(Array.isArray(rejection)).toBe(true);
    expect(rejection).toHaveLength(1);
    expect(rejection[0]?.id).toBe(2);
  });
});
