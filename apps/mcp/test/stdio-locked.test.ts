/**
 * The stdio transport enforces the hosted-access lock PER CALL, end to end:
 * this spawns the real src/stdio.ts process exactly like production (tsx +
 * EMCP_API_KEY, DB_PATH pointing at a temp file — never data/) and speaks
 * newline-delimited JSON-RPC over its stdin/stdout.
 *
 * The workspace is locked MID-SESSION (an hc_workspace_access row written by
 * this parent process while the child keeps running): the long-lived stdio
 * server must answer the workspace_locked error envelope for tool calls and
 * a workspace_locked JSON-RPC error for resource reads, without a restart.
 * This also exercises the async DATABASE_URL runtime selection on its
 * default (unset -> SQLite at DB_PATH) path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@emcp/core";
import { createRuntime, openDatabase, type Db, type Runtime } from "@emcp/db";
import { WORKSPACE_LOCKED_RPC_CODE } from "../src/server.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESPONSE_TIMEOUT_MS = 20_000;

let dir: string;
let db: Db;
let runtime: Runtime;
let workspaceId: string;
let child: ChildProcessWithoutNullStreams;
let stderrLog = "";
let nextId = 1;

type RpcResponse = {
  id: number;
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    serverInfo?: { name: string };
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
};

const pending = new Map<number, { resolve: (msg: RpcResponse) => void; reject: (err: Error) => void }>();

function failAllPending(reason: string): void {
  for (const [, waiter] of pending) waiter.reject(new Error(`${reason}\nchild stderr:\n${stderrLog}`));
  pending.clear();
}

function request(method: string, params: unknown): Promise<RpcResponse> {
  const id = nextId++;
  const promise = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Timed out waiting for ${method} (id ${id})\nchild stderr:\n${stderrLog}`));
    }, RESPONSE_TIMEOUT_MS);
    timer.unref();
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

function notify(method: string): void {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "emcp-stdio-lock-"));
  const dbPath = join(dir, "stdio-test.db");

  // Pre-bootstrap in the parent (also keeps the one-time owner-password log
  // off the child's protocol stdout) and mint a real API key via the catalog.
  db = openDatabase(dbPath);
  runtime = createRuntime(db);
  workspaceId = runtime.bootstrapResult.workspaceId;
  // Bootstrap creates the owner PENDING (OpenAuth setup-code flow); an MCP
  // key is only live while its creating user is active — simulate the
  // completed first login before minting the key.
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(runtime.bootstrapResult.ownerUserId);
  const owner: RequestContext = {
    workspaceId,
    actorType: "human",
    userId: runtime.bootstrapResult.ownerUserId,
    clientId: null,
    role: "owner",
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "web",
  };
  const created = await runtime.run(owner, "mcpClient.create", {
    name: "stdio lock test",
    scopes: ["read", "write"],
    trust: "trusted_agent",
  });
  if (created.status !== "ok") throw new Error(`mcpClient.create failed: ${JSON.stringify(created)}`);
  const apiKey = (created.data as { token: string }).token;

  const env = { ...process.env, DB_PATH: dbPath, EMCP_API_KEY: apiKey } as NodeJS.ProcessEnv;
  delete env.DATABASE_URL; // the child must take the unset -> SQLite default path

  child = spawn(join(appDir, "node_modules", ".bin", "tsx"), ["src/stdio.ts"], {
    cwd: appDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrLog += chunk.toString("utf8");
  });
  child.on("exit", (code) => failAllPending(`stdio child exited early (code ${code})`));
  child.on("error", (error) => failAllPending(`stdio child failed to spawn: ${error.message}`));

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        continue; // not a protocol line
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
}, 60_000);

afterAll(async () => {
  child?.removeAllListeners("exit");
  child?.kill();
  db?.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function callResult(response: RpcResponse): { isError: boolean; payload: unknown } {
  const content = response.result?.content?.[0]?.text ?? "null";
  return { isError: response.result?.isError === true, payload: JSON.parse(content) };
}

describe("stdio transport hosted access enforcement (real child process)", () => {
  it("initializes and serves tool calls while the workspace is active", async () => {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stdio-lock-test", version: "0.0.0" },
    });
    expect(init.error).toBeUndefined();
    expect(init.result?.serverInfo?.name).toBe("emcp-crm");
    notify("notifications/initialized");

    const call = callResult(await request("tools/call", { name: "company_list", arguments: {} }));
    expect(call.isError).toBe(false);
    expect(call.payload).toHaveProperty("total");
  }, 30_000);

  it("answers the workspace_locked envelope for tool calls after a mid-session lock (no restart)", async () => {
    setAccess("locked", null);
    const call = callResult(await request("tools/call", { name: "company_list", arguments: {} }));
    expect(call.isError).toBe(true);
    expect((call.payload as { error: { code: string } }).error.code).toBe("workspace_locked");
  }, 30_000);

  it("fails resource reads with the workspace_locked JSON-RPC error while locked", async () => {
    const pipelines = await request("resources/read", { uri: "emcp://pipelines" });
    expect(pipelines.result).toBeUndefined();
    expect(pipelines.error?.code).toBe(WORKSPACE_LOCKED_RPC_CODE);
    expect(String(pipelines.error?.message)).toContain("workspace_locked");

    const catalog = await request("resources/read", { uri: "emcp://catalog" });
    expect(catalog.error?.code).toBe(WORKSPACE_LOCKED_RPC_CODE);
  }, 30_000);

  it("recovers per call when the lock is lifted (still no restart)", async () => {
    setAccess("active", null);
    const call = callResult(await request("tools/call", { name: "company_list", arguments: {} }));
    expect(call.isError).toBe(false);
    expect(call.payload).toHaveProperty("total");
  }, 30_000);
});
