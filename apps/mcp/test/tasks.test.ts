import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { OperationDef, RequestContext } from "@mcpsuite/core";
import { createRuntime, mcpContext, openDatabase, type Db, type Runtime } from "@mcpsuite/db";
import { handleMcpRequest } from "../src/handler.ts";
import { WORKSPACE_LOCKED_RPC_CODE } from "../src/server.ts";

type Rpc = Record<string, any>;
let dir: string;
let db: Db;
let runtime: Runtime;
let human: RequestContext;
let key: string;
let otherKey: string;
let baseUrl: string | undefined;

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): Rpc {
  return { jsonrpc: "2.0", id, method, params };
}

async function send(body: Rpc, token = key): Promise<Rpc> {
  const response = await handleMcpRequest(new Request("http://mcpsuite.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  }), runtime);
  expect(response.status).toBe(200);
  return await response.json() as Rpc;
}

function optIn(): object {
  return { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } };
}

async function company(): Promise<string> {
  const created = await runtime.run(human, "company.create", { name: "Task test company" });
  expect(created.status).toBe("ok");
  if (created.status !== "ok") throw new Error("company.create failed");
  return (created.data as { id: string }).id;
}

async function requestDelete(id: string, opted = true): Promise<Rpc> {
  return send(rpc("tools/call", {
    name: "company_delete",
    arguments: { id },
    ...(opted ? { _meta: optIn() } : {}),
  }));
}

async function pending(id: string): Promise<string> {
  const response = await requestDelete(id);
  expect(response.result.resultType).toBe("task");
  return response.result.taskId as string;
}

async function createKey(name: string, scopes: RequestContext["scopes"]): Promise<string> {
  const created = await runtime.run(human, "mcpClient.create", { name, scopes, trust: "review_risky_actions" });
  expect(created.status).toBe("ok");
  if (created.status !== "ok") throw new Error("mcpClient.create failed");
  return (created.data as { token: string }).token;
}

function setAccess(mode: "active" | "locked"): void {
  db.$client.exec(`CREATE TABLE IF NOT EXISTS hc_workspace_access (
    workspace_id TEXT PRIMARY KEY, access_mode TEXT NOT NULL,
    access_expires_at TEXT, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  db.$client.prepare(`INSERT INTO hc_workspace_access
    (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
    VALUES (?, ?, NULL, 1, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET access_mode = excluded.access_mode`)
    .run(human.workspaceId, mode, now, now);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-mcp-tasks-"));
  db = openDatabase(join(dir, "tasks.db"));
  runtime = createRuntime(db);
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(runtime.bootstrapResult.ownerUserId);
  human = {
    workspaceId: runtime.bootstrapResult.workspaceId,
    actorType: "human", userId: runtime.bootstrapResult.ownerUserId,
    clientId: null, role: "owner", scopes: [], trust: "fully_authorized_agent", surface: "web",
  };
  key = await createKey("task-requester", ["read", "write"]);
  otherKey = await createKey("different-client", ["read", "write"]);
  baseUrl = process.env.MCPSUITE_BASE_URL;
  process.env.MCPSUITE_BASE_URL = "https://crm.example.test/";
});

afterEach(() => {
  if (baseUrl === undefined) delete process.env.MCPSUITE_BASE_URL;
  else process.env.MCPSUITE_BASE_URL = baseUrl;
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP approval tasks over HTTP", () => {
  it("advertises the extension during initialize", async () => {
    const response = await send(rpc("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    }));
    expect(response.result.capabilities.extensions["io.modelcontextprotocol/tasks"]).toEqual({});
  });

  it("keeps the original CallToolResult for a client without per-call opt-in", async () => {
    const response = await requestDelete(await company(), false);
    expect(response.result.resultType).toBeUndefined();
    const text = JSON.parse(response.result.content[0].text);
    expect(text).toMatchObject({ pendingApproval: true, operation: "company.delete" });
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(text.pendingActionId))?.status).toBe("pending");
  });

  it("leaves an opted-in tool call with no approval as a normal CallToolResult", async () => {
    const response = await send(rpc("tools/call", {
      name: "company_list", arguments: {}, _meta: optIn(),
    }));
    expect(response.result.resultType).toBeUndefined();
    expect(response.result.content[0].type).toBe("text");
    expect(response.result.isError).toBeUndefined();
  });

  it("returns a durable task handle and a URL request for only an opted-in pending call", async () => {
    const target = await company();
    const response = await requestDelete(target);
    const task = response.result;
    const action = await runtime.portsFor(human.workspaceId).pendingActions.get(task.taskId);
    expect(task).toMatchObject({ resultType: "task", taskId: action?.id, status: "input_required", pollIntervalMs: 5000 });
    expect(task.statusMessage).toContain("human approval");
    expect(task.createdAt).toBe(action?.requestedAt);
    expect(task.lastUpdatedAt).toBe(action?.requestedAt);
    expect(task.ttlMs).toBe(new Date(action!.expiresAt).getTime() - new Date(action!.requestedAt).getTime());
    const polled = await send(rpc("tasks/get", { taskId: task.taskId }));
    expect(polled.result).toMatchObject({ resultType: "complete", status: "input_required" });
    expect(polled.result.inputRequests).toEqual({
      approval: {
        method: "elicitation/create",
        params: {
          mode: "url", elicitationId: task.taskId,
          url: `https://crm.example.test/app/approvals?status=pending&action=${task.taskId}`,
          message: expect.stringContaining(`company.delete (destructive). Preview:`),
        },
      },
    });
    expect(polled.result.inputRequests.approval.params.message).toContain(target);
    expect(await runtime.portsFor(human.workspaceId).companies.get(target)).not.toBeNull();
  });

  it("returns the actual tool result after a human approves and executes the write", async () => {
    const target = await company();
    const taskId = await pending(target);
    const approved = await runtime.run(human, "pendingAction.approve", { id: taskId });
    expect(approved.status).toBe("ok");
    const state = (await send(rpc("tasks/get", { taskId }))).result;
    expect(state).toMatchObject({ resultType: "complete", status: "completed" });
    expect(state.result.isError).toBeUndefined();
    expect(JSON.parse(state.result.content[0].text)).toEqual({ deleted: target });
    expect(await runtime.portsFor(human.workspaceId).companies.get(target)).toBeNull();
  });

  it("returns a completed tool error for rejection with the reviewer's note", async () => {
    const rejectedId = await pending(await company());
    expect((await runtime.run(human, "pendingAction.reject", { id: rejectedId, note: "Keep this customer" })).status).toBe("ok");
    const rejected = (await send(rpc("tasks/get", { taskId: rejectedId }))).result;
    expect(rejected.status).toBe("completed");
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0].text).toContain("Keep this customer");
  });

  it("maps an existing failed row to a completed tool error", async () => {
    const failedId = await pending(await company());
    await runtime.portsFor(human.workspaceId).pendingActions.setStatus(failedId, {
      status: "failed", reviewedByUserId: human.userId,
      result: { error: { code: "not_found", message: "Stored execution failure" } },
    });
    const failed = (await send(rpc("tasks/get", { taskId: failedId }))).result;
    expect(failed.status).toBe("completed");
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toContain("Stored execution failure");
  });

  it("keeps a failed SQLite approval pending and rolls back the target's partial write", async () => {
    runtime.catalog.set("test.partialWrite", {
      name: "test.partialWrite", title: "Partial write test", description: "Test approval rollback",
      input: z.object({ id: z.string() }), minRole: "admin", scope: "write",
      risk: "destructive", mcpExpose: true,
      handler: async ({ ports }, { id }) => {
        await ports.companies.update(id, { name: "Partial write" });
        throw new Error("forced failure after write");
      },
    } as OperationDef);
    const target = await company();
    const called = await send(rpc("tools/call", {
      name: "test_partialWrite", arguments: { id: target }, _meta: optIn(),
    }));
    const taskId = called.result.taskId;
    expect(called.result.status).toBe("input_required");
    expect((await runtime.run(human, "pendingAction.approve", { id: taskId })).status).toBe("error");
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("pending");
    expect((await send(rpc("tasks/get", { taskId }))).result.status).toBe("input_required");
    expect((await runtime.portsFor(human.workspaceId).companies.get(target))?.name).toBe("Task test company");
  });

  it("reports an expired pending request as cancelled without executing it", async () => {
    const target = await company();
    const taskId = await pending(target);
    db.$client.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), taskId);
    const state = (await send(rpc("tasks/get", { taskId }))).result;
    expect(state).toMatchObject({ resultType: "complete", status: "cancelled", statusMessage: "expired" });
    expect(state.result).toBeUndefined();
    const stored = await runtime.portsFor(human.workspaceId).pendingActions.get(taskId);
    expect(stored).toMatchObject({ status: "cancelled", reviewNote: "expired" });
    const stillPending = await runtime.run(human, "pendingAction.list", { status: "pending" });
    expect(stillPending.status).toBe("ok");
    if (stillPending.status === "ok") expect((stillPending.data as Array<{ id: string }>).some((pa) => pa.id === taskId)).toBe(false);
    const audit = await runtime.portsFor(human.workspaceId).audit.list({ operation: "pendingAction.expire", limit: 10, offset: 0 });
    expect(audit.items.some((event) => event.entityId === taskId)).toBe(true);
    expect(await runtime.portsFor(human.workspaceId).companies.get(target)).not.toBeNull();
  });

  it("acknowledges inputResponses without approving and cancels through the audited catalog operation", async () => {
    const taskId = await pending(await company());
    expect((await send(rpc("tasks/update", {
      taskId, inputResponses: { approval: { action: "accept" }, unknown: true },
    }))).result).toEqual({ resultType: "complete" });
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("pending");
    expect((await send(rpc("tasks/cancel", { taskId }))).result).toEqual({ resultType: "complete" });
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("cancelled");
    expect((await send(rpc("tasks/get", { taskId }))).result.status).toBe("cancelled");
    expect((await send(rpc("tasks/cancel", { taskId }))).result).toEqual({ resultType: "complete" });
    const audit = await runtime.portsFor(human.workspaceId).audit.list({ operation: "pendingAction.cancel", limit: 10, offset: 0 });
    expect(audit.items.some((event) => event.entityId === taskId)).toBe(true);
  });

  it("acks cancellation even when the requester's write scope was removed", async () => {
    const taskId = await pending(await company());
    const client = await runtime.identity.resolveMcpToken(key);
    expect(client).not.toBeNull();
    expect((await runtime.run(human, "mcpClient.update", { id: client!.clientId, scopes: ["read"] })).status).toBe("ok");
    expect((await runtime.identity.resolveMcpToken(key))?.scopes).toEqual(["read"]);
    expect((await send(rpc("tasks/cancel", { taskId }))).result).toEqual({ resultType: "complete" });
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("cancelled");
    expect((await send(rpc("tasks/get", { taskId }))).result.status).toBe("cancelled");
  });

  it("lets read-only and admin-only clients poll and cancel their own tasks", async () => {
    for (const fixture of [
      { name: "read-only", scopes: ["read"] as RequestContext["scopes"], tool: "export_csv", args: { entityType: "company" } },
      { name: "admin-only", scopes: ["admin"] as RequestContext["scopes"], tool: "workspace_update", args: { name: "Unapproved name" } },
    ]) {
      const token = await createKey(fixture.name, fixture.scopes);
      const called = await send(rpc("tools/call", { name: fixture.tool, arguments: fixture.args, _meta: optIn() }), token);
      expect(called.result).toMatchObject({ resultType: "task", status: "input_required" });
      const taskId = called.result.taskId as string;
      expect((await send(rpc("tasks/get", { taskId }), token)).result.status).toBe("input_required");
      expect((await send(rpc("tasks/cancel", { taskId }), token)).result).toEqual({ resultType: "complete" });
      expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("cancelled");
      expect((await send(rpc("tasks/get", { taskId }), token)).result.status).toBe("cancelled");
    }
  });

  it("keeps requester-only operations out of tools and the catalog resource", async () => {
    const hidden = ["pendingAction.getOwnTask", "pendingAction.cancelOwnTask"];
    const listed = await send(rpc("tools/list"));
    const toolNames = listed.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of hidden) expect(toolNames).not.toContain(name.replace(".", "_"));
    const catalog = await send(rpc("resources/read", { uri: "mcpsuite://catalog" }));
    const operations = JSON.parse(catalog.result.contents[0].text) as Array<{ name: string }>;
    for (const name of hidden) expect(operations.map((op) => op.name)).not.toContain(name);
  });

  it("hides tasks from other client keys with the same error as an unknown id", async () => {
    const taskId = await pending(await company());
    const unknown = await send(rpc("tasks/get", { taskId: "unknown" }));
    expect((await send(rpc("tasks/get", { taskId }), otherKey)).error).toEqual(unknown.error);
    expect((await send(rpc("tasks/cancel", { taskId }), otherKey)).error).toEqual(unknown.error);
    const other = await runtime.identity.resolveMcpToken(otherKey);
    expect(other).not.toBeNull();
    const direct = await runtime.run(mcpContext(other!), "pendingAction.getOwnTask", { id: taskId });
    expect(direct).toMatchObject({ status: "error", error: { code: "not_found" } });
    expect((await runtime.portsFor(human.workspaceId).pendingActions.get(taskId))?.status).toBe("pending");
  });

  it("rejects every tasks method at the workspace lock gate", async () => {
    const taskId = await pending(await company());
    setAccess("locked");
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const response = await send(rpc(method, { taskId, inputResponses: {} }));
      expect(response.error.code).toBe(WORKSPACE_LOCKED_RPC_CODE);
      expect(response.error.data.code).toBe("workspace_locked");
    }
  });

  it("lets the web approval operation complete an unpolled task", async () => {
    const target = await company();
    const taskId = await pending(target);
    expect((await runtime.run(human, "pendingAction.approve", { id: taskId })).status).toBe("ok");
    expect(await runtime.portsFor(human.workspaceId).companies.get(target)).toBeNull();
  });
});
