/**
 * End-to-end tests for the hosting control API over real HTTP against a real
 * SQLite file in a temp directory (never data/). The server binds 127.0.0.1
 * on an EPHEMERAL port (port 0) for every test, and the auth-code delivery
 * seam is exercised against a local ephemeral sink listener (also port 0).
 *
 * Delivery modes: with EMCP_AUTH_DELIVERY_URL unset the seam is in "display"
 * mode (responses may carry a one-time code); with it set, codes are POSTed
 * to the URL and must never appear in responses or storage. Both env vars are
 * cleared around every test.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeAuthCode, openDatabase, sha256Hex, type Db } from "@emcp/db";
import {
  createHostingControlServer,
  resolveWorkspaceAccess,
  retryPendingAuthDeliveries,
  type HostingControlServer,
} from "../src/index.ts";

const KEY = "hc_test_service_key_0123456789abcdef"; // 36 chars >= 32 minimum
const DELIVERY_KEY = "delivery_endpoint_key_abcdef012345";

let dir: string;
let db: Db;
let hc: HostingControlServer;
let port: number;

beforeEach(async () => {
  delete process.env.EMCP_AUTH_DELIVERY_URL;
  delete process.env.EMCP_AUTH_DELIVERY_KEY;
  dir = mkdtempSync(join(tmpdir(), "emcp-hc-"));
  // `await` tolerates the db layer staying sync or becoming async.
  db = await openDatabase(join(dir, "hc-test.db"));
  hc = createHostingControlServer({ db, serviceKeys: [KEY], host: "127.0.0.1", port: 0 });
  port = (await hc.listen()).port;
});

afterEach(async () => {
  delete process.env.EMCP_AUTH_DELIVERY_URL;
  delete process.env.EMCP_AUTH_DELIVERY_KEY;
  await hc.close();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult {
  status: number;
  json: any;
  text: string;
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
  return { status: res.status, json: text ? JSON.parse(text) : null, text, headers: res.headers };
}

function count(sql: string, ...args: unknown[]): number {
  return (db.$client.prepare(sql).get(...args) as { c: number }).c;
}

function provisionBody(email: string, organizationName = "Acme Corp"): Record<string, unknown> {
  return { organizationName, ownerEmail: email, ownerName: "Owner Person" };
}

async function provision(email: string, idem: string, organizationName?: string): Promise<CallResult> {
  return call("POST", "/api/v1/workspaces", { idem, body: provisionBody(email, organizationName) });
}

// --- delivery sink (local ephemeral listener standing in for hosted mail) ---

interface DeliveryHit {
  body: { email?: string; code?: string; purpose?: string };
  auth: string | null;
}

async function startDeliverySink(): Promise<{ url: string; hits: DeliveryHit[]; close: () => Promise<void> }> {
  const hits: DeliveryHit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let parsed: DeliveryHit["body"] = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* keep {} */
      }
      hits.push({ body: parsed, auth: (req.headers.authorization as string | undefined) ?? null });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/deliver`,
    hits,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// --- user-state helpers (users.status: pending | active | disabled) ---------

function expectUserPending(userId: string): void {
  const row = db.$client.prepare("SELECT status, password_hash AS ph FROM users WHERE id = ?").get(userId) as {
    status: string;
    ph: string | null;
  };
  expect(row.status).toBe("pending");
  expect(row.ph).toBeNull(); // provisioning never creates credential material
}

function activateUser(userId: string): void {
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(userId);
}

function disableUser(userId: string): void {
  db.$client
    .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
    .run(new Date().toISOString(), userId);
}

function addWorkspaceUser(
  workspaceId: string,
  email: string,
  state: "active" | "pending" | "disabled",
  role: "member" | "admin" = "member",
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.$client
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'pending', ?, ?)",
    )
    .run(id, email, "Team Member", now, now);
  db.$client
    .prepare("INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), workspaceId, id, role, now);
  if (state === "active") activateUser(id);
  if (state === "disabled") disableUser(id);
  return id;
}

/** The hash of the newest live code for a user+purpose (proves redeemability). */
function activeCodeHash(userId: string, purpose: "setup" | "reset"): string | null {
  const row = db.$client
    .prepare(
      `SELECT code_hash AS h FROM auth_codes
       WHERE user_id = ? AND purpose = ? AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, purpose) as { h: string } | undefined;
  return row?.h ?? null;
}

function ownerOf(workspaceId: string): string | null {
  const row = db.$client
    .prepare("SELECT user_id AS u FROM memberships WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId) as { u: string } | undefined;
  return row?.u ?? null;
}

/** Everything persisted around a code's lifecycle — proves raw codes never reach storage. */
function storedText(): string {
  const dump = (sql: string) => db.$client.prepare(sql).all();
  return JSON.stringify({
    receipts: dump("SELECT * FROM hc_idempotency_receipts"),
    serviceAudit: dump("SELECT * FROM hc_service_audit"),
    outbox: dump("SELECT * FROM hc_auth_delivery_outbox"),
    events: dump("SELECT * FROM audit_events"),
    authCodes: dump("SELECT * FROM auth_codes"), // hash-at-rest only
  });
}

// openauth's generateAuthCode: 12 unambiguous chars grouped in fours.
const CODE_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/;

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
  it("creates workspace and PENDING owner atomically; display mode returns the setup code once", async () => {
    const res = await provision("owner@acme.com", "create-1");
    expect(res.status).toBe(201);
    const data = res.json.data;
    expect(data.workspaceId).toBeTruthy();
    expect(data.ownerUserId).toBeTruthy();
    expect(data.ownerStatus).toBe("pending");
    expect(data.accessMode).toBe("active");
    expect(data.version).toBe(1);
    // No delivery URL configured -> display mode: the one-time code rides the
    // live response exactly once.
    expect(data.setupDelivery).toBe("display");
    expect(data.setupCode).toMatch(CODE_RE);

    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(1);
    const user = db.$client.prepare("SELECT email FROM users WHERE id = ?").get(data.ownerUserId) as { email: string };
    expect(user.email).toBe("owner@acme.com");
    expectUserPending(data.ownerUserId);
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

    // Display mode queues nothing, and the code itself never enters storage.
    expect(count("SELECT COUNT(*) AS c FROM hc_auth_delivery_outbox")).toBe(0);
    expect(storedText()).not.toContain(data.setupCode);
    // …but it IS real: its hash sits in the CRM code store, redeemable by the
    // login flow, committed in the same transaction as the workspace.
    expect(activeCodeHash(data.ownerUserId, "setup")).toBe(sha256Hex(normalizeAuthCode(data.setupCode)));
  });

  it("rejects ownerPassword — provisioning carries no credential material", async () => {
    const res = await call("POST", "/api/v1/workspaces", {
      idem: "pw-rejected",
      body: { ...provisionBody("pw@acme.com"), ownerPassword: "supersecretpw" },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_error");
    expect(res.text).not.toContain("supersecretpw");
    expect(count("SELECT COUNT(*) AS c FROM workspaces")).toBe(0);
    expect(storedText()).not.toContain("supersecretpw");
  });

  it("hosted mode: POSTs {email, code, purpose} with the delivery key and never returns the code", async () => {
    const sink = await startDeliverySink();
    try {
      process.env.EMCP_AUTH_DELIVERY_URL = sink.url;
      process.env.EMCP_AUTH_DELIVERY_KEY = DELIVERY_KEY;
      const res = await provision("hosted@acme.com", "hosted-1");
      expect(res.status).toBe(201);
      expect(res.json.data.setupDelivery).toBe("queued");
      expect(res.json.data.setupCode).toBeUndefined();

      expect(sink.hits).toHaveLength(1);
      const hit = sink.hits[0]!;
      expect(hit.body.email).toBe("hosted@acme.com");
      expect(hit.body.purpose).toBe("setup");
      expect(hit.body.code).toMatch(CODE_RE);
      expect(hit.auth).toBe(`Bearer ${DELIVERY_KEY}`);

      // The delivered code appears in NO response and NO stored row.
      expect(res.text).not.toContain(hit.body.code!);
      expect(storedText()).not.toContain(hit.body.code!);

      const outbox = db.$client
        .prepare("SELECT state, attempts, purpose FROM hc_auth_delivery_outbox")
        .all() as Array<{ state: string; attempts: number; purpose: string }>;
      expect(outbox).toEqual([{ state: "sent", attempts: 1, purpose: "setup" }]);
    } finally {
      await sink.close();
    }
  });

  it("hosted mode: a delivery outage keeps the 201, defers to the outbox, and the sweep delivers", async () => {
    process.env.EMCP_AUTH_DELIVERY_URL = "http://127.0.0.1:1/unreachable"; // connection refused
    const res = await provision("deferred@acme.com", "deferred-1");
    expect(res.status).toBe(201); // the committed outbox row IS the acknowledgement
    expect(res.json.data.setupDelivery).toBe("queued");
    expect(res.json.data.setupCode).toBeUndefined();
    const pending = db.$client
      .prepare("SELECT state, attempts, last_error AS le FROM hc_auth_delivery_outbox")
      .get() as { state: string; attempts: number; le: string | null };
    expect(pending.state).toBe("pending");
    expect(pending.attempts).toBe(1);
    expect(pending.le).toBeTruthy();

    const sink = await startDeliverySink();
    try {
      process.env.EMCP_AUTH_DELIVERY_URL = sink.url;
      process.env.EMCP_AUTH_DELIVERY_KEY = DELIVERY_KEY;
      const swept = await retryPendingAuthDeliveries(db);
      expect(swept).toEqual({ attempted: 1, sent: 1 });
      expect(sink.hits).toHaveLength(1);
      expect(sink.hits[0]!.body.email).toBe("deferred@acme.com");
      expect(sink.hits[0]!.body.purpose).toBe("setup");
      // Codes are never stored, so the retried delivery carries a FRESH code.
      expect(sink.hits[0]!.body.code).toMatch(CODE_RE);
      const row = db.$client.prepare("SELECT state FROM hc_auth_delivery_outbox").get() as { state: string };
      expect(row.state).toBe("sent");
    } finally {
      await sink.close();
    }
  });

  it("replays the same idempotency key without creating a duplicate (and without the one-time code)", async () => {
    const first = await provision("owner@acme.com", "same-key");
    const second = await provision("owner@acme.com", "same-key");
    expect(second.status).toBe(201);
    // The stored receipt is the original response minus one-time material.
    expect(second.json.requestId).toBe(first.json.requestId);
    expect(second.json.data.setupCode).toBeUndefined();
    const { setupCode: _stripped, ...firstRest } = first.json.data;
    expect(second.json.data).toEqual(firstRest);
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

describe("owner transfer", () => {
  let workspaceId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    const res = await provision("owner@acme.com", "transfer-setup");
    workspaceId = res.json.data.workspaceId;
    ownerUserId = res.json.data.ownerUserId;
  });

  function transfer(idem: string, body: Record<string, unknown>): Promise<CallResult> {
    return call("PUT", `/api/v1/workspaces/${workspaceId}/owner`, { idem, body: { reason: "Support recovery", ...body } });
  }

  it("promotes an active member, demotes the previous owner, bumps the version, and audits", async () => {
    const target = addWorkspaceUser(workspaceId, "successor@acme.com", "active");
    const res = await transfer("tr-1", { targetUserId: target });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      workspaceId,
      ownerUserId: target,
      previousOwnerUserId: ownerUserId,
      version: 2,
    });

    // Exactly one owner; the previous owner became an admin.
    expect(ownerOf(workspaceId)).toBe(target);
    expect(count("SELECT COUNT(*) AS c FROM memberships WHERE workspace_id = ? AND role = 'owner'", workspaceId)).toBe(1);
    const previous = db.$client
      .prepare("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, ownerUserId) as { role: string };
    expect(previous.role).toBe("admin");

    // Control state: the inspect version advanced with the transfer.
    const read = await call("GET", `/api/v1/workspaces/${workspaceId}`);
    expect(read.json.data.ownerUserId).toBe(target);
    expect(read.json.data.version).toBe(2);

    // CRM audit + service audit committed with the swap.
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_transfer'",
        workspaceId,
      ),
    ).toBe(1);
    const audit = db.$client
      .prepare("SELECT reason, result_code AS rc FROM hc_service_audit WHERE action = 'workspace.owner.transfer'")
      .all() as Array<{ reason: string | null; rc: string }>;
    expect(audit).toEqual([{ reason: "Support recovery", rc: "transferred" }]);
  });

  it("resolves the target by email, replays by key, and no-ops on a repeat to the same target", async () => {
    const target = addWorkspaceUser(workspaceId, "by-email@acme.com", "active");
    const first = await transfer("tr-email", { targetEmail: "By-Email@acme.com" }); // case-insensitive
    expect(first.status).toBe(200);
    expect(first.json.data.ownerUserId).toBe(target);

    // Same key -> stored replay, byte-identical.
    const replay = await transfer("tr-email", { targetEmail: "By-Email@acme.com" });
    expect(replay.json).toEqual(first.json);

    // New key, same target -> semantic no-op success, no extra bump/audit.
    const repeat = await transfer("tr-email-2", { targetEmail: "by-email@acme.com" });
    expect(repeat.status).toBe(200);
    expect(repeat.json.data.ownerUserId).toBe(target);
    expect(repeat.json.data.previousOwnerUserId).toBeNull();
    expect(repeat.json.data.version).toBe(2); // unchanged
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_transfer'",
        workspaceId,
      ),
    ).toBe(1);
    const repeatAudit = db.$client
      .prepare("SELECT result_code AS rc FROM hc_service_audit WHERE idempotency_key = 'tr-email-2'")
      .get() as { rc: string };
    expect(repeatAudit.rc).toBe("already_owner");
  });

  it("rejects pending, disabled, foreign-workspace, and unknown targets — owner unchanged", async () => {
    const pending = addWorkspaceUser(workspaceId, "pending@acme.com", "pending");
    const disabled = addWorkspaceUser(workspaceId, "disabled@acme.com", "disabled");
    const other = await provision("other-owner@acme.com", "tr-foreign-ws", "Other Corp");
    const foreign = addWorkspaceUser(other.json.data.workspaceId, "foreign@acme.com", "active");

    const cases: Array<[string, Record<string, unknown>]> = [
      ["tr-pending", { targetUserId: pending }],
      ["tr-disabled", { targetUserId: disabled }],
      ["tr-foreign", { targetUserId: foreign }],
      ["tr-foreign-email", { targetEmail: "foreign@acme.com" }],
      ["tr-unknown", { targetUserId: "no-such-user" }],
    ];
    for (const [idem, body] of cases) {
      const res = await transfer(idem, body);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("target_not_eligible");
      expect(ownerOf(workspaceId)).toBe(ownerUserId); // unchanged on every failure
    }
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_transfer'",
        workspaceId,
      ),
    ).toBe(0);
  });

  it("validates the body: exactly one target selector and a mandatory reason", async () => {
    const target = addWorkspaceUser(workspaceId, "sel@acme.com", "active");
    const both = await transfer("tr-both", { targetUserId: target, targetEmail: "sel@acme.com" });
    expect(both.status).toBe(400);
    expect(both.json.error.code).toBe("validation_error");

    const neither = await transfer("tr-neither", {});
    expect(neither.status).toBe(400);

    const noReason = await call("PUT", `/api/v1/workspaces/${workspaceId}/owner`, {
      idem: "tr-no-reason",
      body: { targetUserId: target },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.json.error.code).toBe("validation_error");

    const noKey = await call("PUT", `/api/v1/workspaces/${workspaceId}/owner`, {
      body: { targetUserId: target, reason: "Support recovery" },
    });
    expect(noKey.status).toBe(400);

    expect(ownerOf(workspaceId)).toBe(ownerUserId);
  });

  it("enforces expectedVersion against the control state and 404s unknown workspaces", async () => {
    const target = addWorkspaceUser(workspaceId, "versioned@acme.com", "active");
    const stale = await transfer("tr-stale", { targetUserId: target, expectedVersion: 99 });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("version_conflict");
    expect(stale.json.error.currentVersion).toBe(1);
    expect(ownerOf(workspaceId)).toBe(ownerUserId);

    const ok = await transfer("tr-fresh", { targetUserId: target, expectedVersion: 1 });
    expect(ok.status).toBe(200);
    expect(ok.json.data.version).toBe(2);

    const missing = await call("PUT", "/api/v1/workspaces/does-not-exist/owner", {
      idem: "tr-missing",
      body: { targetUserId: target, reason: "Support recovery" },
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("not_found");
  });
});

describe("owner recovery", () => {
  let workspaceId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    const res = await provision("owner@acme.com", "recovery-setup");
    workspaceId = res.json.data.workspaceId;
    ownerUserId = res.json.data.ownerUserId;
  });

  function recover(idem: string, body: Record<string, unknown> = {}): Promise<CallResult> {
    return call("POST", `/api/v1/workspaces/${workspaceId}/owner/recovery`, {
      idem,
      body: { reason: "Owner lost access", ...body },
    });
  }

  it("display mode: initiates with a one-time code (setup for a pending owner, reset once active)", async () => {
    const first = await recover("rec-1");
    expect(first.status).toBe(202);
    expect(first.json.data.recovery).toBe("initiated");
    expect(first.json.data.purpose).toBe("setup"); // the owner never activated
    expect(first.json.data.delivery).toBe("display");
    expect(first.json.data.code).toMatch(CODE_RE);
    expect(storedText()).not.toContain(first.json.data.code);
    // Redeemable: the code store holds the (superseding) hash for this owner.
    expect(activeCodeHash(ownerUserId, "setup")).toBe(sha256Hex(normalizeAuthCode(first.json.data.code)));

    activateUser(ownerUserId);
    const second = await recover("rec-2");
    expect(second.status).toBe(202);
    expect(second.json.data.purpose).toBe("reset");
    expect(activeCodeHash(ownerUserId, "reset")).toBe(sha256Hex(normalizeAuthCode(second.json.data.code)));

    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_recovery'",
        workspaceId,
      ),
    ).toBe(2);
    const audit = db.$client
      .prepare("SELECT reason FROM hc_service_audit WHERE action = 'workspace.owner.recovery'")
      .all() as Array<{ reason: string | null }>;
    expect(audit).toEqual([{ reason: "Owner lost access" }, { reason: "Owner lost access" }]);
  });

  it("hosted mode: delivers to the owner, never returns credentials, and one key queues at most one event", async () => {
    activateUser(ownerUserId);
    const sink = await startDeliverySink();
    try {
      process.env.EMCP_AUTH_DELIVERY_URL = sink.url;
      process.env.EMCP_AUTH_DELIVERY_KEY = DELIVERY_KEY;
      const res = await recover("rec-hosted");
      expect(res.status).toBe(202);
      expect(res.json.data).toEqual({
        workspaceId,
        recovery: "initiated",
        purpose: "reset",
        delivery: "queued",
      });

      expect(sink.hits).toHaveLength(1);
      const hit = sink.hits[0]!;
      expect(hit.body.email).toBe("owner@acme.com");
      expect(hit.body.purpose).toBe("reset");
      expect(hit.body.code).toMatch(CODE_RE);
      expect(hit.auth).toBe(`Bearer ${DELIVERY_KEY}`);
      expect(res.text).not.toContain(hit.body.code!);
      expect(storedText()).not.toContain(hit.body.code!);

      // Idempotent replay: re-confirmation only — no new code, no new email.
      const replay = await recover("rec-hosted");
      expect(replay.status).toBe(202);
      expect(replay.json).toEqual(res.json);
      expect(sink.hits).toHaveLength(1);
      expect(count("SELECT COUNT(*) AS c FROM hc_auth_delivery_outbox")).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_recovery'",
          workspaceId,
        ),
      ).toBe(1);
    } finally {
      await sink.close();
    }
  });

  it("maps the per-identity code-issue window to 429 rate_limited and rolls back cleanly", async () => {
    // Provisioning already issued 1 setup code for this email; openauth's
    // fixed window allows 5 per 15 minutes, so four more initiations pass…
    for (let i = 1; i <= 4; i++) {
      const ok = await recover(`rate-${i}`);
      expect(ok.status).toBe(202);
    }
    // …and the fifth is refused as a retryable rate limit.
    const limited = await recover("rate-5");
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("rate_limited");
    expect(limited.json.error.retryable).toBe(true);
    // Rolled back + key released so the caller can retry after the window.
    const receipt = db.$client
      .prepare("SELECT state FROM hc_idempotency_receipts WHERE idempotency_key = 'rate-5'")
      .get();
    expect(receipt).toBeUndefined();
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_recovery'",
        workspaceId,
      ),
    ).toBe(4);
  });

  it("display mode: a replay confirms without repeating the one-time code", async () => {
    const first = await recover("rec-replay");
    expect(first.json.data.code).toMatch(CODE_RE);
    const replay = await recover("rec-replay");
    expect(replay.status).toBe(202);
    expect(replay.json.data.code).toBeUndefined();
    const { code: _code, ...firstRest } = first.json.data;
    expect(replay.json.data).toEqual(firstRest);
  });

  it("rejects recovery when the owner is disabled or absent, requires a reason, 404s unknown workspaces", async () => {
    const noReason = await call("POST", `/api/v1/workspaces/${workspaceId}/owner/recovery`, {
      idem: "rec-no-reason",
      body: {},
    });
    expect(noReason.status).toBe(400);
    expect(noReason.json.error.code).toBe("validation_error");

    disableUser(ownerUserId);
    const disabled = await recover("rec-disabled");
    expect(disabled.status).toBe(409);
    expect(disabled.json.error.code).toBe("owner_not_available");

    db.$client.prepare("DELETE FROM memberships WHERE workspace_id = ? AND role = 'owner'").run(workspaceId);
    const absent = await recover("rec-absent");
    expect(absent.status).toBe(409);
    expect(absent.json.error.code).toBe("owner_not_available");

    const missing = await call("POST", "/api/v1/workspaces/does-not-exist/owner/recovery", {
      idem: "rec-missing",
      body: { reason: "Owner lost access" },
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("not_found");

    // No recovery event was queued or audited for the failures.
    expect(count("SELECT COUNT(*) AS c FROM hc_auth_delivery_outbox")).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND operation = 'hosting.workspace.owner_recovery'",
        workspaceId,
      ),
    ).toBe(0);
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

  it("removes the workspace's queued auth-code deliveries", async () => {
    process.env.EMCP_AUTH_DELIVERY_URL = "http://127.0.0.1:1/unreachable"; // leave the outbox row pending
    const res = await provision("gone@acme.com", "del-outbox");
    const wsId = res.json.data.workspaceId as string;
    expect(count("SELECT COUNT(*) AS c FROM hc_auth_delivery_outbox WHERE workspace_id = ?", wsId)).toBe(1);

    const del = await call("DELETE", `/api/v1/workspaces/${wsId}`, { idem: "del-outbox-1", body: { reason: "Cleanup" } });
    expect(del.status).toBe(204);
    expect(count("SELECT COUNT(*) AS c FROM hc_auth_delivery_outbox WHERE workspace_id = ?", wsId)).toBe(0);
  });
});
