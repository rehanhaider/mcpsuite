/**
 * Hosted access enforcement on the web HTTP surface, against a real SQLite
 * file in a temp directory (never data/): POST /api/ops/:name refuses a
 * locked workspace with the workspace_locked error envelope, while
 * GET /api/me stays available and reports the access state (the same
 * resolution `whoami` serves the app shell).
 *
 * Self-host invariant: without an hc_workspace_access table everything
 * behaves exactly as today.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The runtime opens DB_PATH lazily on first use — point it at a temp file
// before any handler runs.
const dir = mkdtempSync(join(tmpdir(), "emcp-web-lock-"));
process.env.DB_PATH = join(dir, "web-test.db");

import { closeDb, createSession, getRuntime } from "@emcp/db";
import { Route as OpsRoute } from "../src/routes/api.ops.$name.ts";
import { Route as MeRoute } from "../src/routes/api.me.ts";

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;

const opsPost = (OpsRoute.options as any).server.handlers.POST as Handler;
const meGet = (MeRoute.options as any).server.handlers.GET as Handler;

let cookie: string;
let workspaceId: string;

beforeAll(() => {
  const runtime = getRuntime(); // opens the temp DB and bootstraps the owner
  workspaceId = runtime.bootstrapResult.workspaceId;
  // Bootstrap creates the owner PENDING (OpenAuth setup-code flow); sessions
  // only resolve for active users — simulate the completed first login.
  runtime.db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(runtime.bootstrapResult.ownerUserId);
  const { token } = createSession(runtime.db, runtime.bootstrapResult.ownerUserId);
  cookie = `emcp_session=${encodeURIComponent(token)}`;
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Simulates hosting control having run: its table + one access row. */
function setAccess(mode: "active" | "locked", expiresAt: string | null): void {
  const db = getRuntime().db;
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

async function callOp(name: string, input: unknown = {}): Promise<{ status: number; json: any }> {
  const request = new Request(`http://test.local/api/ops/${name}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const response = await opsPost({ request, params: { name } });
  return { status: response.status, json: await response.json() };
}

async function callMe(): Promise<{ status: number; json: any }> {
  const response = await meGet({ request: new Request("http://test.local/api/me", { headers: { cookie } }), params: {} });
  return { status: response.status, json: await response.json() };
}

describe("web hosted access enforcement", () => {
  it("behaves exactly as today with no hosting-control table (self-host)", async () => {
    const list = await callOp("company.list");
    expect(list.status).toBe(200);
    expect(list.json.status).toBe("ok");

    const me = await callMe();
    expect(me.status).toBe(200);
    expect(me.json.accessMode).toBe("active");
    expect(me.json.accessExpiresAt).toBeNull();
  });

  it("stays active with a future expiry", async () => {
    setAccess("active", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const list = await callOp("company.list");
    expect(list.status).toBe(200);
    expect(list.json.status).toBe("ok");
  });

  it("rejects op calls for a locked workspace with the workspace_locked envelope", async () => {
    setAccess("locked", null);
    const list = await callOp("company.list");
    expect(list.status).toBe(403);
    expect(list.json.status).toBe("error");
    expect(list.json.error.code).toBe("workspace_locked");

    const create = await callOp("company.create", { name: "Should Never Exist" });
    expect(create.status).toBe(403);
    expect(create.json.error.code).toBe("workspace_locked");
    const count = getRuntime()
      .db.$client.prepare("SELECT COUNT(*) AS c FROM companies WHERE name = 'Should Never Exist'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("keeps /api/me available while locked and reports the access state", async () => {
    setAccess("locked", null);
    const me = await callMe();
    expect(me.status).toBe(200);
    expect(me.json.accessMode).toBe("locked");
    expect(me.json.userId).toBeTruthy();
  });

  it("locks once an active expiry passes (expiry-at-read-time)", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    setAccess("active", past);
    const list = await callOp("company.list");
    expect(list.status).toBe(403);
    expect(list.json.error.code).toBe("workspace_locked");

    const me = await callMe();
    expect(me.json.accessMode).toBe("locked");
    expect(me.json.accessExpiresAt).toBe(past);
  });
});
