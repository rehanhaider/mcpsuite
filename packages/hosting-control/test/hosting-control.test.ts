/**
 * End-to-end tests for the hosting control API over real HTTP against a real
 * SQLite file in a temp directory (never data/). The server binds 127.0.0.1
 * on an EPHEMERAL port (port 0) for every test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, sha256Hex, verifyUserPassword, type Db } from "@emcp/db";
import { createHostingControlServer, resolveWorkspaceAccess, type HostingControlServer } from "../src/index.ts";

const KEY = "hc_test_service_key_0123456789abcdef"; // 36 chars >= 32 minimum

let dir: string;
let db: Db;
let hc: HostingControlServer;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "emcp-hc-"));
  // `await` tolerates the db layer staying sync or becoming async.
  db = await openDatabase(join(dir, "hc-test.db"));
  hc = createHostingControlServer({ db, serviceKeys: [KEY], host: "127.0.0.1", port: 0 });
  port = (await hc.listen()).port;
});

afterEach(async () => {
  await hc.close();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult {
  status: number;
  json: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  opts: { key?: string | null; idem?: string; body?: unknown; rawBody?: string } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? KEY}`;
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    headers["content-type"] = "application/json";
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

function count(sql: string, ...args: unknown[]): number {
  return (db.$client.prepare(sql).get(...args) as { c: number }).c;
}

function provisionBody(email: string, organizationName = "Acme Corp"): Record<string, unknown> {
  return { organizationName, ownerEmail: email, ownerName: "Owner Person", ownerPassword: "supersecretpw" };
}

async function provision(email: string, idem: string, organizationName?: string): Promise<CallResult> {
  return call("POST", "/api/v1/workspaces", { idem, body: provisionBody(email, organizationName) });
}

describe("service key auth", () => {
  it("rejects requests without a key", async () => {
    const res = await call("GET", "/api/v1/workspaces/some-id", { key: null });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("unauthorized");
    expect(res.json.requestId).toBeTruthy();
  });

  it("rejects wrong keys of any length identically", async () => {
    const sameLength = `${KEY.slice(0, -1)}X`;
    for (const bad of [sameLength, "short", `${KEY}-and-more`]) {
      const res = await call("POST", "/api/v1/workspaces", {
        key: bad,
        idem: "idem-auth",
        body: provisionBody("auth@example.com"),
      });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("unauthorized");
    }
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(0);
  });

  it("serves health without a key and without product data", async () => {
    for (const path of ["/healthz", "/api/v1/health"]) {
      const res = await call("GET", path, { key: null });
      expect(res.status).toBe(200);
      expect(res.json.data.status).toBe("ok");
      expect(Object.keys(res.json.data).sort()).toEqual(["productVersion", "schemaVersion", "status"]);
    }
  });

  it("audits rejected requests without key material", async () => {
    await call("GET", "/api/v1/workspaces/whatever", { key: "totally-wrong-key-totally-wrong-key" });
    const rows = db.$client
      .prepare("SELECT action, result_code AS rc, service_identity AS ident FROM hc_service_audit")
      .all() as Array<{ action: string; rc: string; ident: string }>;
    expect(rows.some((r) => r.action === "auth.rejected" && r.rc === "unauthorized")).toBe(true);
    for (const row of rows) expect(JSON.stringify(row)).not.toContain("totally-wrong-key");
  });
});

describe("workspace provisioning", () => {
  it("creates workspace, owner, and defaults atomically", async () => {
    const res = await provision("owner@acme.com", "create-1");
    expect(res.status).toBe(201);
    const data = res.json.data;
    expect(data.workspaceId).toBeTruthy();
    expect(data.ownerUserId).toBeTruthy();
    expect(data.accessMode).toBe("active");
    expect(data.version).toBe(1);

    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(1);
    const user = db.$client.prepare("SELECT email, password_hash AS ph FROM users WHERE id = ?").get(data.ownerUserId) as {
      email: string;
      ph: string | null;
    };
    expect(user.email).toBe("owner@acme.com");
    expect(user.ph).toBeTruthy();
    expect(await verifyUserPassword(db, "owner@acme.com", "supersecretpw")).toEqual({ id: data.ownerUserId });
    expect(
      count("SELECT COUNT(*) AS c FROM memberships WHERE workspace_id = ? AND role = 'owner'", data.workspaceId),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM pipelines WHERE workspace_id = ?", data.workspaceId)).toBe(2);
    expect(count("SELECT COUNT(*) AS c FROM stages WHERE workspace_id = ?", data.workspaceId)).toBe(14);
    expect(count("SELECT COUNT(*) AS c FROM hc_workspace_access WHERE workspace_id = ?", data.workspaceId)).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.provision'",
        data.workspaceId,
      ),
    ).toBe(1);
    const audit = count(
      "SELECT COUNT(*) AS c FROM hc_service_audit WHERE action = 'workspace.provision' AND workspace_id = ?",
      data.workspaceId,
    );
    expect(audit).toBe(1);
  });

  it("creates the owner without a password when none is supplied", async () => {
    const res = await call("POST", "/api/v1/workspaces", {
      idem: "create-nopw",
      body: { organizationName: "NoPw Inc", ownerEmail: "nopw@acme.com" },
    });
    expect(res.status).toBe(201);
    const user = db.$client.prepare("SELECT password_hash AS ph FROM users WHERE email = 'nopw@acme.com'").get() as {
      ph: string | null;
    };
    expect(user.ph).toBeNull();
  });

  it("replays the same idempotency key without creating a duplicate", async () => {
    const first = await provision("owner@acme.com", "same-key");
    const second = await provision("owner@acme.com", "same-key");
    expect(second.status).toBe(201);
    expect(second.json).toEqual(first.json); // original response verbatim
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM users")).toBe(1);
  });

  it("rejects the same key with a different request body", async () => {
    await provision("owner@acme.com", "conflict-key");
    const res = await provision("other@acme.com", "conflict-key");
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("idempotency_conflict");
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(1);
  });

  it("requires the Idempotency-Key header", async () => {
    const res = await call("POST", "/api/v1/workspaces", { body: provisionBody("nokey@acme.com") });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_error");
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(0);
  });

  it("returns identity_unavailable for an already-bound identity under a new key", async () => {
    await provision("owner@acme.com", "id-1");
    const res = await provision("owner@acme.com", "id-2");
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("identity_unavailable");
    expect(res.json.error.retryable).toBe(false);
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(1);
  });

  it("provisions independent workspaces for different identities", async () => {
    const a = await provision("a@acme.com", "multi-a", "A Corp");
    const b = await provision("b@acme.com", "multi-b", "B Corp");
    expect(a.json.data.workspaceId).not.toBe(b.json.data.workspaceId);
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(2);
    expect(count("SELECT COUNT(*) AS c FROM pipelines")).toBe(4);
  });

  it("rejects malformed JSON and invalid fields", async () => {
    const bad = await call("POST", "/api/v1/workspaces", { idem: "bad-json", rawBody: "not json {" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("validation_error");

    const noEmail = await call("POST", "/api/v1/workspaces", {
      idem: "bad-email",
      body: { organizationName: "X", ownerEmail: "not-an-email" },
    });
    expect(noEmail.status).toBe(400);
    expect(noEmail.json.error.code).toBe("validation_error");
  });

  it("reports pending requests as in progress and takes over stale claims", async () => {
    db.$client
      .prepare(
        `INSERT INTO hc_idempotency_receipts (idempotency_key, action, request_hash, state, request_id, created_at)
         VALUES (?, ?, ?, 'pending', 'req_x', ?)`,
      )
      .run("fresh-pending", "workspace.provision", "hash-mismatch-is-checked-first", new Date().toISOString());
    // A same-key request with a different body is an idempotency conflict even while pending.
    const conflicting = await provision("pending@acme.com", "fresh-pending");
    expect(conflicting.status).toBe(409);
    expect(conflicting.json.error.code).toBe("idempotency_conflict");

    // A stale pending claim (crashed process) is taken over and executed.
    const staleCreatedAt = new Date(Date.now() - 120_000).toISOString();
    db.$client
      .prepare(
        `INSERT INTO hc_idempotency_receipts (idempotency_key, action, request_hash, state, request_id, created_at)
         VALUES (?, 'workspace.provision', 'whatever', 'pending', 'req_y', ?)`,
      )
      .run("stale-pending", staleCreatedAt);
    const recovered = await provision("stale@acme.com", "stale-pending");
    expect(recovered.status).toBe(201);
  });
});

describe("workspace access state", () => {
  let workspaceId: string;

  beforeEach(async () => {
    const res = await provision("owner@acme.com", "access-setup");
    workspaceId = res.json.data.workspaceId;
  });

  it("locks and reactivates with version bumps, audit rows, and reasons", async () => {
    const locked = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "lock-1",
      body: { accessMode: "locked", accessExpiresAt: null, reason: "Hosted access decision" },
    });
    expect(locked.status).toBe(200);
    expect(locked.json.data).toEqual({ workspaceId, accessMode: "locked", accessExpiresAt: null, version: 2 });

    const read = await call("GET", `/api/v1/workspaces/${workspaceId}`);
    expect(read.status).toBe(200);
    expect(read.json.data.accessMode).toBe("locked");
    expect(read.json.data.ownerUserId).toBeTruthy();
    expect(read.json.data.version).toBe(2);

    const audit = db.$client
      .prepare("SELECT workspace_id AS wsId, reason FROM hc_service_audit WHERE action = 'workspace.access.set'")
      .all() as Array<{ wsId: string | null; reason: string | null }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.wsId).toBe(workspaceId);
    expect(audit[0]!.reason).toBe("Hosted access decision");
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.access_set'",
        workspaceId,
      ),
    ).toBe(1);

    const active = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "unlock-1",
      body: { accessMode: "active", accessExpiresAt: "2027-01-01T00:00:00.000Z" },
    });
    expect(active.json.data.version).toBe(3);
    expect(active.json.data.accessExpiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("setting the same state again succeeds with no duplicate effect", async () => {
    await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "noop-1",
      body: { accessMode: "locked", accessExpiresAt: null },
    });
    const repeat = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "noop-2", // a NEW idempotency key — semantic idempotency, not replay
      body: { accessMode: "locked", accessExpiresAt: null },
    });
    expect(repeat.status).toBe(200);
    expect(repeat.json.data.version).toBe(2); // unchanged
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.access_set'",
        workspaceId,
      ),
    ).toBe(1); // no second CRM audit event
  });

  it("accepts the {state, expiresAt} field aliases", async () => {
    const res = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "alias-1",
      body: { state: "locked", expiresAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(res.status).toBe(200);
    expect(res.json.data.accessMode).toBe("locked");
    expect(res.json.data.accessExpiresAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("enforces expectedVersion", async () => {
    const stale = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "stale-1",
      body: { accessMode: "locked", expectedVersion: 99 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("version_conflict");
    expect(stale.json.error.currentVersion).toBe(1);

    const ok = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "stale-2",
      body: { accessMode: "locked", expectedVersion: 1 },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.version).toBe(2);
  });

  it("feeds the CRM read contract: lock, expiry-at-read-time, and no-row default", async () => {
    // Freshly provisioned: active with no expiry; unknown workspace: no row -> active.
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "active", expiresAt: null });
    expect(resolveWorkspaceAccess(db, "never-provisioned")).toEqual({ mode: "active", expiresAt: null });

    await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "rc-lock",
      body: { accessMode: "locked" },
    });
    expect(resolveWorkspaceAccess(db, workspaceId).mode).toBe("locked");

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "rc-active-future",
      body: { accessMode: "active", accessExpiresAt: future },
    });
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "active", expiresAt: future });

    const past = new Date(Date.now() - 1000).toISOString();
    await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "rc-active-past",
      body: { accessMode: "active", accessExpiresAt: past },
    });
    // Still "active" in the row, but the expiry has passed: reads say locked
    // without any further hosting request.
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "locked", expiresAt: past });
  });

  it("returns not_found for unknown workspaces and validates the mode", async () => {
    const missing = await call("PUT", "/api/v1/workspaces/does-not-exist/access", {
      idem: "missing-1",
      body: { accessMode: "locked" },
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("not_found");

    const bad = await call("PUT", `/api/v1/workspaces/${workspaceId}/access`, {
      idem: "badmode-1",
      body: { accessMode: "suspended" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("validation_error");
  });
});

describe("permanent workspace deletion", () => {
  it("removes every workspace row, is idempotent, and keeps only hashed audit", async () => {
    const a = await provision("a@acme.com", "del-a", "A Corp");
    const b = await provision("b@acme.com", "del-b", "B Corp");
    const wsA = a.json.data.workspaceId as string;
    const wsB = b.json.data.workspaceId as string;
    await call("PUT", `/api/v1/workspaces/${wsA}/access`, { idem: "del-lock", body: { accessMode: "locked" } });

    const del = await call("DELETE", `/api/v1/workspaces/${wsA}`, {
      idem: "del-1",
      body: { reason: "Customer owner request" },
    });
    expect(del.status).toBe(204);

    // Workspace A is fully gone…
    expect(count("SELECT COUNT(*) AS c FROM workspaces WHERE id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM memberships WHERE workspace_id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM pipelines WHERE workspace_id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM stages WHERE workspace_id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM users WHERE email = 'a@acme.com'")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hc_workspace_access WHERE workspace_id = ?", wsA)).toBe(0);

    // …while workspace B is untouched.
    expect(count("SELECT COUNT(*) AS c FROM workspaces WHERE id = ?", wsB)).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM users WHERE email = 'b@acme.com'")).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM pipelines WHERE workspace_id = ?", wsB)).toBe(2);
    expect(count("SELECT COUNT(*) AS c FROM hc_workspace_access WHERE workspace_id = ?", wsB)).toBe(1);

    // Global service audit keeps only the one-way hash for A.
    expect(count("SELECT COUNT(*) AS c FROM hc_service_audit WHERE workspace_id = ?", wsA)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hc_service_audit WHERE target_hash = ?", sha256Hex(wsA))).toBeGreaterThan(0);

    // Reads answer as never-existed.
    const read = await call("GET", `/api/v1/workspaces/${wsA}`);
    expect(read.status).toBe(404);
    expect(read.json.error.code).toBe("not_found");

    // Replaying the delete with the same key is the same 204…
    const replay = await call("DELETE", `/api/v1/workspaces/${wsA}`, {
      idem: "del-1",
      body: { reason: "Customer owner request" },
    });
    expect(replay.status).toBe(204);

    // …and deleting an absent workspace under a fresh key is also 204.
    const absent = await call("DELETE", `/api/v1/workspaces/${wsA}`, { idem: "del-2", body: { reason: "Retry sweep" } });
    expect(absent.status).toBe(204);
    const absentAudit = db.$client
      .prepare("SELECT result_code AS rc FROM hc_service_audit WHERE idempotency_key = 'del-2'")
      .get() as { rc: string };
    expect(absentAudit.rc).toBe("already_absent");
  });
});
