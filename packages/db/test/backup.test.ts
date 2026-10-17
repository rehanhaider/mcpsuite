import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCatalog,
  runOperation,
  systemContext,
  type AuditEvent,
  type Catalog,
  type Company,
  type OpResult,
  type PendingAction,
  type Ports,
  type RequestContext,
} from "@mcpsuite/core";
import { initSchema, type Db } from "../src/connection.ts";
import * as schema from "../src/schema.ts";
import { createPorts } from "../src/repositories.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { authServices, csvServices } from "../src/services.ts";

let dir: string;
let db: Db;
let catalog: Catalog;
let ports: Ports;
let owner: RequestContext;

function run(ctx: RequestContext, name: string, input: unknown = {}): Promise<OpResult> {
  return runOperation(catalog, ports, ctx, name, input);
}

async function ok<T>(result: OpResult | Promise<OpResult>): Promise<T> {
  const r = await result;
  expect(r.status, JSON.stringify(r)).toBe("ok");
  return (r as { status: "ok"; data: T }).data;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-backup-"));
  const sqlite = new Database(join(dir, "mcpsuite.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("wal_autocheckpoint = 0");
  sqlite.pragma("foreign_keys = ON");
  initSchema(sqlite);
  db = drizzle(sqlite, { schema }) as Db;
  const boot = bootstrap(db, { ownerEmail: "test@local", ownerName: "Test" });
  // Match catalog tests by simulating completed owner setup and activation.
  sqlite.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(boot.ownerUserId);
  catalog = buildCatalog({ auth: authServices, csv: csvServices });
  ports = createPorts(db, boot.workspaceId);
  owner = { ...systemContext(boot.workspaceId), actorType: "human", userId: boot.ownerUserId, surface: "web" };
});

afterEach(() => {
  db?.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("data.backup", () => {
  it("creates distinct files for back-to-back backups", async () => {
    const first = await ok<{ path: string }>(run(owner, "data.backup"));
    const second = await ok<{ path: string }>(run(owner, "data.backup"));

    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("backs up committed WAL data through the catalog and records an audit event", async () => {
    const company = await ok<Company>(run(owner, "company.create", { name: "Before backup" }));

    const backup = await ok<{ path: string }>(run(owner, "data.backup"));
    expect(dirname(backup.path)).toBe(join(dir, "backups"));
    expect(existsSync(backup.path)).toBe(true);

    const snapshot = new Database(backup.path, { readonly: true, fileMustExist: true });
    try {
      expect(snapshot.prepare("SELECT name FROM companies WHERE id = ?").get(company.id)).toEqual({
        name: company.name,
      });
    } finally {
      snapshot.close();
    }

    const audit = await ok<{ items: AuditEvent[] }>(run(owner, "audit.list"));
    expect(audit.items.some((event) => event.operation === "data.backup")).toBe(true);
  });

  it("backs up after a human approves an agent request", async () => {
    const agent: RequestContext = {
      ...owner,
      actorType: "agent",
      userId: null,
      clientId: "client-1",
      role: "admin",
      scopes: ["admin"],
      trust: "review_risky_actions",
      surface: "mcp_http",
    };
    const pending = await run(agent, "data.backup");
    expect(pending.status, JSON.stringify(pending)).toBe("pending_approval");
    if (pending.status !== "pending_approval") throw new Error("Expected pending approval");
    expect(existsSync(join(dir, "backups"))).toBe(false);

    const approval = await ok<{ pendingAction: PendingAction; result: { path: string } }>(
      run(owner, "pendingAction.approve", { id: pending.pendingActionId }),
    );
    expect(approval.pendingAction.status).toBe("approved");
    expect(dirname(approval.result.path)).toBe(join(dir, "backups"));
    expect(existsSync(approval.result.path)).toBe(true);
    expect((await ports.pendingActions.get(pending.pendingActionId))?.status).toBe("approved");
  });
});
