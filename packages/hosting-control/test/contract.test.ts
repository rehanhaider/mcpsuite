/**
 * The hosting-control contract, run identically on every database adapter
 * (issue #5): the HTTP API over a real listener, backed by the adapter's
 * HostingStore, with the CRM reading the result through its own identity
 * store the way every CRM surface does.
 *
 *   - every lifecycle operation: provision, access set, inspect, owner
 *     transfer, owner recovery, permanent delete (with audit redaction);
 *   - idempotency: replay returns the stored response, a different body
 *     under the same key is a conflict;
 *   - atomicity: a fault injected after the change, after the receipt, or
 *     after the service audit rolls the whole request back and releases the
 *     key for a retry;
 *   - concurrency: two requests guarded by the same expectedVersion — one
 *     wins, the other is a version_conflict;
 *   - hosted delivery: the outbox row commits with the request (and rolls
 *     back with it), a failed send stays pending, and the sweep delivers it;
 *   - a locked workspace is refused by the CRM's access read;
 *   - PostgreSQL only: role proofs for crm_operator and crm_app.
 *
 * SQLite runs always, on a temp file. PostgreSQL runs with
 *
 *   docker run --rm -d --name mcpsuite-pg-test \
 *     -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55442:5432 postgres:17-alpine
 *   cd packages/hosting-control && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55442/postgres \
 *     mise exec -- pnpm vitest run contract
 *
 * DATABASE_URL must be a superuser: the suite creates its own database
 * (mcpsuite_hc_contract), sets throwaway passwords for crm_app and
 * crm_operator, and connects hosting control as crm_operator.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ports } from "@mcpsuite/core";
import {
  createSqliteHostingStore,
  createSqliteIdentity,
  openDatabase,
  sha256Hex,
  type HostingStore,
  type IdentityStore,
} from "@mcpsuite/db";
import { createPorts } from "../../db/src/repositories.ts";
import { connectPg, createPgPorts, type PgHandle } from "../../db/src/pg/repositories.ts";
import { initPgSchema } from "../../db/src/pg/init.ts";
import { createPgIdentity } from "../../db/src/pg/identity.ts";
import { connectPgHostingStore } from "../../db/src/pg/hosting.ts";
import { createHostingControlServer, retryPendingAuthDeliveries, type HostingControlServer } from "../src/index.ts";

const PG_ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const KEY = "hc_contract_service_key_0123456789abcdef";
const CONTRACT_DB = "mcpsuite_hc_contract";
const APP_ROLE_TEST_PASSWORD = "crm_app_test_pw"; // same constant as the db package's pg suites
const OPERATOR_ROLE_TEST_PASSWORD = "crm_operator_test_pw";

/**
 * Drop a test database once its pools have really disconnected. Closing a
 * pool returns before the server has ended its backends; a FORCE drop then
 * terminates a connection the client is still closing, which surfaces as an
 * uncaught "terminating connection" error.
 */
async function dropDatabase(root: PgHandle, name: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await root.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name]);
    if (Number(res.rows[0]?.n ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await root.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

type FaultPoint = "afterChange" | "afterReceipt" | "afterAudit";
const FAULT_POINTS: FaultPoint[] = ["afterChange", "afterReceipt", "afterAudit"];

/** A logical table, named per adapter by `table()`. */
type Table =
  | "workspaces"
  | "users"
  | "memberships"
  | "pipelines"
  | "audit_events"
  | "access"
  | "service_audit"
  | "outbox"
  | "receipts";

interface Harness {
  name: "sqlite" | "postgres";
  store: HostingStore;
  /** The CRM's identity store (crm_app on PostgreSQL). */
  crm: IdentityStore;
  portsFor(workspaceId: string): Ports;
  /** Row count, read with full visibility (superuser on PostgreSQL). */
  count(table: Table, where?: Record<string, unknown>): Promise<number>;
  ownerOf(workspaceId: string): Promise<string | null>;
  close(): Promise<void>;
}

async function sqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mcpsuite-hc-contract-"));
  const db = openDatabase(join(dir, "contract.db"));
  const names: Record<Table, string> = {
    workspaces: "workspaces",
    users: "users",
    memberships: "memberships",
    pipelines: "pipelines",
    audit_events: "audit_events",
    access: "hc_workspace_access",
    service_audit: "hc_service_audit",
    outbox: "hc_auth_delivery_outbox",
    receipts: "hc_idempotency_receipts",
  };
  return {
    name: "sqlite",
    store: createSqliteHostingStore(db),
    crm: createSqliteIdentity(db),
    portsFor: (workspaceId) => createPorts(db, workspaceId),
    async count(table, where = {}) {
      const keys = Object.keys(where);
      const clause = keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}` : "";
      const row = db.$client.prepare(`SELECT COUNT(*) AS c FROM ${names[table]}${clause}`).get(...Object.values(where)) as {
        c: number;
      };
      return row.c;
    },
    async ownerOf(workspaceId) {
      const row = db.$client
        .prepare("SELECT user_id AS id FROM memberships WHERE workspace_id = ? AND role = 'owner'")
        .get(workspaceId) as { id: string } | undefined;
      return row?.id ?? null;
    },
    async close() {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface PgHarness extends Harness {
  admin: PgHandle;
  app: PgHandle;
  operatorUrl: string;
}

async function pgHarness(): Promise<PgHarness> {
  const rootUrl = process.env.DATABASE_URL!;
  const root = await connectPg({ databaseUrl: rootUrl, max: 1 });
  await root.pool.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB} WITH (FORCE)`);
  await root.pool.query(`CREATE DATABASE ${CONTRACT_DB}`);
  const adminUrl = new URL(rootUrl);
  adminUrl.pathname = `/${CONTRACT_DB}`;
  const admin = await connectPg({ databaseUrl: adminUrl.toString(), max: 2 });
  // Roles are cluster-global; another suite may be creating them in parallel
  // on a virgin cluster. schema.sql is one transaction, so a retry is clean.
  let initError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await initPgSchema(admin.pool);
      initError = null;
      break;
    } catch (e) {
      initError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (initError) throw initError;
  await admin.pool.query(`ALTER ROLE crm_app WITH PASSWORD '${APP_ROLE_TEST_PASSWORD}'`);
  await admin.pool.query(`ALTER ROLE crm_operator WITH PASSWORD '${OPERATOR_ROLE_TEST_PASSWORD}'`);

  const appUrl = new URL(adminUrl.toString());
  appUrl.username = "crm_app";
  appUrl.password = APP_ROLE_TEST_PASSWORD;
  const operatorUrl = new URL(adminUrl.toString());
  operatorUrl.username = "crm_operator";
  operatorUrl.password = OPERATOR_ROLE_TEST_PASSWORD;

  const app = await connectPg({ databaseUrl: appUrl.toString(), max: 4 });
  const hosting = await connectPgHostingStore(operatorUrl.toString());
  const names: Record<Table, string> = {
    workspaces: "crm.workspaces",
    users: "crm.users",
    memberships: "crm.memberships",
    pipelines: "crm.pipelines",
    audit_events: "crm.audit_events",
    access: "hosting.workspace_access",
    service_audit: "hosting.service_audit",
    outbox: "hosting.auth_delivery_outbox",
    receipts: "hosting.idempotency_receipts",
  };
  return {
    name: "postgres",
    admin,
    app,
    operatorUrl: operatorUrl.toString(),
    store: hosting.store,
    crm: createPgIdentity(app.db),
    portsFor: (workspaceId) => createPgPorts(app.db, workspaceId) as unknown as Ports,
    async count(table, where = {}) {
      const keys = Object.keys(where);
      const clause = keys.length ? ` WHERE ${keys.map((k, i) => `${k}::text = $${i + 1}`).join(" AND ")}` : "";
      const res = await admin.pool.query(`SELECT COUNT(*)::int AS c FROM ${names[table]}${clause}`, Object.values(where));
      return Number(res.rows[0]?.c ?? 0);
    },
    async ownerOf(workspaceId) {
      const res = await admin.pool.query(
        "SELECT user_id::text AS id FROM crm.memberships WHERE workspace_id = $1 AND role = 'owner'",
        [workspaceId],
      );
      return (res.rows[0]?.id as string | undefined) ?? null;
    },
    async close() {
      await hosting.close();
      await app.close();
      await admin.close();
      await dropDatabase(root, CONTRACT_DB).catch(() => {});
      await root.close();
    },
  };
}

interface CallResult {
  status: number;
  json: any;
}

function contractSuite(name: "sqlite" | "postgres", makeHarness: () => Promise<Harness>): void {
  describe(`hosting-control contract — ${name}`, () => {
    let h: Harness;
    let hc: HostingControlServer;
    let port: number;
    let armed: FaultPoint | null = null;
    let seq = 0;

    const fault = (point: FaultPoint) => () => {
      if (armed === point) throw new Error(`injected fault ${point}`);
    };

    beforeAll(async () => {
      delete process.env.MCPSUITE_AUTH_DELIVERY_URL;
      delete process.env.MCPSUITE_AUTH_DELIVERY_KEY;
      h = await makeHarness();
      hc = createHostingControlServer({
        store: h.store,
        serviceKeys: [KEY],
        host: "127.0.0.1",
        port: 0,
        faults: { afterChange: fault("afterChange"), afterReceipt: fault("afterReceipt"), afterAudit: fault("afterAudit") },
      });
      port = (await hc.listen()).port;
    }, 120_000);

    afterAll(async () => {
      await hc?.close();
      await h?.close();
    });

    async function call(method: string, path: string, opts: { idem?: string; body?: unknown } = {}): Promise<CallResult> {
      const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
      if (opts.idem) headers["idempotency-key"] = opts.idem;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    }

    const email = (tag: string): string => `${tag}-${++seq}@${name}.contract.test`.toLowerCase();
    const idem = (tag: string): string => `${name}-${tag}-${++seq}`;

    async function provision(ownerEmail: string, key = idem("provision")): Promise<CallResult> {
      return call("POST", "/api/v1/workspaces", {
        idem: key,
        body: { organizationName: "Contract Co", ownerEmail, ownerName: "Contract Owner" },
      });
    }

    /** A provisioned workspace with its pending owner and setup code. */
    async function workspace(): Promise<{ id: string; ownerId: string; ownerEmail: string; setupCode: string }> {
      const ownerEmail = email("owner");
      const res = await provision(ownerEmail);
      expect(res.status).toBe(201);
      const d = res.json.data;
      return { id: d.workspaceId, ownerId: d.ownerUserId, ownerEmail, setupCode: d.setupCode };
    }

    async function activeMember(workspaceId: string): Promise<string> {
      const user = await h.portsFor(workspaceId).users.create({
        name: "Successor",
        email: email("member"),
        role: "member",
        passwordHash: null,
      });
      return user.id;
    }

    // --- every lifecycle operation --------------------------------------------

    it("provisions a workspace with a pending owner whose setup code the CRM redeems", async () => {
      const ws = await workspace();
      expect(await h.count("workspaces", { id: ws.id })).toBe(1);
      expect(await h.count("memberships", { workspace_id: ws.id, role: "owner" })).toBe(1);
      expect(await h.count("pipelines", { workspace_id: ws.id })).toBe(2);
      expect(await h.count("access", { workspace_id: ws.id })).toBe(1);
      expect(await h.count("audit_events", { workspace_id: ws.id, operation: "hosting.workspace.provision" })).toBe(1);
      expect(await h.count("service_audit", { workspace_id: ws.id, action: "workspace.provision" })).toBe(1);

      const redeemed = await h.crm.redeemCodeAndSetPassword({
        email: ws.ownerEmail,
        purpose: "setup",
        code: ws.setupCode,
        password: "contract-password-1",
      });
      expect(redeemed).toEqual({ ok: true, userId: ws.ownerId });
      expect(await h.crm.verifyPassword(ws.ownerEmail, "contract-password-1")).toBe(true);
    });

    it("refuses an email already attached to any workspace", async () => {
      const ws = await workspace();
      const again = await provision(ws.ownerEmail);
      expect(again.status).toBe(409);
      expect(again.json.error.code).toBe("identity_unavailable");
      expect(await h.count("users", { email: ws.ownerEmail })).toBe(1);
    });

    it("locks, expires and unlocks access; the CRM's access read follows", async () => {
      const ws = await workspace();
      expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "active", expiresAt: null });

      const locked = await call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
        idem: idem("lock"),
        body: { accessMode: "locked", accessExpiresAt: null, reason: "contract" },
      });
      expect(locked.status).toBe(200);
      expect(locked.json.data).toEqual({ workspaceId: ws.id, accessMode: "locked", accessExpiresAt: null, version: 2 });
      expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "locked", expiresAt: null });

      const past = "2020-01-01T00:00:00.000Z";
      await call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
        idem: idem("expire"),
        body: { accessMode: "active", accessExpiresAt: past },
      });
      expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "locked", expiresAt: past });

      const unlocked = await call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
        idem: idem("unlock"),
        body: { accessMode: "active", accessExpiresAt: null },
      });
      expect(unlocked.json.data.version).toBe(4);
      expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "active", expiresAt: null });

      // Setting the current state again changes nothing.
      const same = await call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
        idem: idem("same"),
        body: { accessMode: "active", accessExpiresAt: null },
      });
      expect(same.json.data.version).toBe(4);
    });

    it("a workspace never provisioned by hosting control reads as active", async () => {
      expect(await h.crm.workspaceAccess("01890000-0000-7000-8000-00000000beef")).toEqual({ mode: "active", expiresAt: null });
      const inspect = await call("GET", "/api/v1/workspaces/01890000-0000-7000-8000-00000000beef");
      expect(inspect.status).toBe(404);
    });

    it("inspects, transfers ownership to an active member, and initiates owner recovery", async () => {
      const ws = await workspace();
      const successor = await activeMember(ws.id);

      const inspect = await call("GET", `/api/v1/workspaces/${ws.id}`);
      expect(inspect.json.data).toMatchObject({ workspaceId: ws.id, ownerUserId: ws.ownerId, accessMode: "active", version: 1 });

      const transferred = await call("PUT", `/api/v1/workspaces/${ws.id}/owner`, {
        idem: idem("transfer"),
        body: { targetUserId: successor, reason: "contract" },
      });
      expect(transferred.status).toBe(200);
      expect(transferred.json.data).toEqual({ workspaceId: ws.id, ownerUserId: successor, previousOwnerUserId: ws.ownerId, version: 2 });
      expect(await h.ownerOf(ws.id)).toBe(successor);
      expect(await h.count("memberships", { workspace_id: ws.id, role: "owner" })).toBe(1);

      // A member of another workspace is never an eligible target.
      const other = await workspace();
      const foreign = await call("PUT", `/api/v1/workspaces/${ws.id}/owner`, {
        idem: idem("foreign"),
        body: { targetUserId: other.ownerId, reason: "contract" },
      });
      expect(foreign.status).toBe(409);
      expect(foreign.json.error.code).toBe("target_not_eligible");

      // Recovery for the (active) new owner issues a reset code.
      const recovery = await call("POST", `/api/v1/workspaces/${ws.id}/owner/recovery`, {
        idem: idem("recover"),
        body: { reason: "contract" },
      });
      expect(recovery.status).toBe(202);
      expect(recovery.json.data).toMatchObject({ workspaceId: ws.id, recovery: "initiated", purpose: "reset", delivery: "display" });
      expect(await h.count("audit_events", { workspace_id: ws.id, operation: "hosting.workspace.owner_recovery" })).toBe(1);
    });

    it("deletes a workspace permanently, leaving only the hashed service audit", async () => {
      const keep = await workspace();
      const ws = await workspace();
      await h.crm.redeemCodeAndSetPassword({ email: ws.ownerEmail, purpose: "setup", code: ws.setupCode, password: "gone-password-1" });
      await call("PUT", `/api/v1/workspaces/${ws.id}/access`, { idem: idem("pre-lock"), body: { accessMode: "locked" } });

      const del = await call("DELETE", `/api/v1/workspaces/${ws.id}`, { idem: idem("delete"), body: { reason: "contract" } });
      expect(del.status).toBe(204);

      expect(await h.count("workspaces", { id: ws.id })).toBe(0);
      expect(await h.count("users", { email: ws.ownerEmail })).toBe(0);
      expect(await h.count("memberships", { workspace_id: ws.id })).toBe(0);
      expect(await h.count("pipelines", { workspace_id: ws.id })).toBe(0);
      expect(await h.count("audit_events", { workspace_id: ws.id })).toBe(0);
      expect(await h.count("access", { workspace_id: ws.id })).toBe(0);
      expect(await h.count("service_audit", { workspace_id: ws.id })).toBe(0);
      expect(await h.count("service_audit", { target_hash: sha256Hex(ws.id) })).toBeGreaterThan(0);
      expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "active", expiresAt: null });
      expect((await call("GET", `/api/v1/workspaces/${ws.id}`)).status).toBe(404);

      // The other workspace is untouched.
      expect(await h.count("workspaces", { id: keep.id })).toBe(1);
      expect(await h.count("users", { email: keep.ownerEmail })).toBe(1);
      expect(await h.count("access", { workspace_id: keep.id })).toBe(1);
    });

    // --- idempotency ----------------------------------------------------------

    it("replays a completed request and refuses the key for a different body", async () => {
      const ownerEmail = email("replay");
      const key = idem("replay");
      const first = await provision(ownerEmail, key);
      expect(first.status).toBe(201);
      const replay = await provision(ownerEmail, key);
      expect(replay.status).toBe(201);
      expect(replay.json.data.workspaceId).toBe(first.json.data.workspaceId);
      // The one-time code rides the live response only, never the replay.
      expect(first.json.data.setupCode).toBeTruthy();
      expect(replay.json.data.setupCode).toBeUndefined();
      expect(await h.count("users", { email: ownerEmail })).toBe(1);

      const conflict = await provision(email("other"), key);
      expect(conflict.status).toBe(409);
      expect(conflict.json.error.code).toBe("idempotency_conflict");
    });

    // --- atomicity ------------------------------------------------------------

    // --- concurrency ----------------------------------------------------------

    it("two access changes guarded by the same version: one wins, one conflicts", async () => {
      for (let round = 0; round < 10; round += 1) {
        const ws = await workspace();
        const [a, b] = await Promise.all([
          call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
            idem: idem("race-lock"),
            body: { accessMode: "locked", expectedVersion: 1 },
          }),
          call("PUT", `/api/v1/workspaces/${ws.id}/access`, {
            idem: idem("race-expire"),
            body: { accessMode: "active", accessExpiresAt: "2099-01-01T00:00:00.000Z", expectedVersion: 1 },
          }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.json.error.code).toBe("version_conflict");
        expect((await call("GET", `/api/v1/workspaces/${ws.id}`)).json.data.version).toBe(2);
      }
    });

    it("two owner transfers guarded by the same version: one wins, one conflicts", async () => {
      for (let round = 0; round < 10; round += 1) {
        const ws = await workspace();
        const [first, second] = [await activeMember(ws.id), await activeMember(ws.id)];
        const transfer = (target: string) =>
          call("PUT", `/api/v1/workspaces/${ws.id}/owner`, {
            idem: idem("race-transfer"),
            body: { targetUserId: target, reason: "contract", expectedVersion: 1 },
          });
        const [a, b] = await Promise.all([transfer(first), transfer(second)]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect((a.status === 409 ? a : b).json.error.code).toBe("version_conflict");
        expect(await h.count("memberships", { workspace_id: ws.id, role: "owner" })).toBe(1);
      }
    });

    // --- hosted delivery (the outbox) -----------------------------------------

    describe("hosted delivery", () => {
      let sink: ReturnType<typeof createServer>;
      let failing = false;
      const hits: Array<{ email?: string; code?: string; purpose?: string }> = [];

      beforeAll(async () => {
        sink = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            if (failing) {
              res.statusCode = 503;
              return res.end();
            }
            hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            res.statusCode = 204;
            res.end();
          });
        });
        await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
        process.env.MCPSUITE_AUTH_DELIVERY_URL = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/deliver`;
      });

      afterAll(async () => {
        delete process.env.MCPSUITE_AUTH_DELIVERY_URL;
        await new Promise<void>((r) => sink.close(() => r()));
      });

      it("commits the outbox row with the request and marks it sent after delivery", async () => {
        const ownerEmail = email("hosted");
        const res = await provision(ownerEmail);
        expect(res.status).toBe(201);
        const ws = res.json.data.workspaceId as string;
        expect(res.json.data.setupDelivery).toBe("queued");
        expect(res.json.data.setupCode).toBeUndefined();
        expect(await h.count("outbox", { workspace_id: ws, state: "sent" })).toBe(1);
        expect(hits.at(-1)).toMatchObject({ email: ownerEmail, purpose: "setup" });
      });

      it.each(FAULT_POINTS)("a fault %s rolls the outbox row back with the request", async (point) => {
        const ownerEmail = email(`hosted-fault-${point}`);
        const before = await h.count("outbox");
        const sent = hits.length;
        armed = point;
        try {
          expect((await provision(ownerEmail)).status).toBe(500);
        } finally {
          armed = null;
        }
        expect(await h.count("outbox")).toBe(before);
        expect(hits.length).toBe(sent);
      });

      it("a failed send stays pending; the sweep delivers it with a fresh code", async () => {
        const ws = await workspace();
        failing = true;
        let queued: CallResult;
        try {
          queued = await call("POST", `/api/v1/workspaces/${ws.id}/owner/recovery`, {
            idem: idem("hosted-recover"),
            body: { reason: "contract" },
          });
        } finally {
          failing = false;
        }
        expect(queued.status).toBe(202);
        expect(queued.json.data.delivery).toBe("queued");
        expect(await h.count("outbox", { workspace_id: ws.id, state: "pending" })).toBe(1);

        const swept = await retryPendingAuthDeliveries(h.store);
        expect(swept.sent).toBeGreaterThanOrEqual(1);
        expect(await h.count("outbox", { workspace_id: ws.id, state: "pending" })).toBe(0);
        // Provisioning's setup delivery plus the swept recovery.
        expect(await h.count("outbox", { workspace_id: ws.id, state: "sent" })).toBe(2);
        const delivered = hits.at(-1)!;
        expect(delivered).toMatchObject({ email: ws.ownerEmail, purpose: "setup" });
        // The swept code is live: it redeems.
        expect(
          await h.crm.redeemCodeAndSetPassword({ email: ws.ownerEmail, purpose: "setup", code: delivered.code!, password: "swept-password-1" }),
        ).toEqual({ ok: true, userId: ws.ownerId });
      });

      it("permanent deletion removes the workspace's deliveries", async () => {
        const ws = await workspace();
        expect(await h.count("outbox", { workspace_id: ws.id })).toBe(1);
        expect((await call("DELETE", `/api/v1/workspaces/${ws.id}`, { idem: idem("hosted-delete"), body: { reason: "contract" } })).status).toBe(204);
        expect(await h.count("outbox", { workspace_id: ws.id })).toBe(0);
      });
    });

    describe.each(FAULT_POINTS)("a fault %s rolls the request back and frees its key", (point) => {
      /** Arm the fault for one call, then prove the same key succeeds disarmed. */
      async function faulted(run: (key: string) => Promise<CallResult>, retryStatus: number): Promise<void> {
        const key = idem(`fault-${point}`);
        armed = point;
        try {
          const failed = await run(key);
          expect(failed.status).toBe(500);
          expect(await h.count("receipts", { idempotency_key: key })).toBe(0);
        } finally {
          armed = null;
        }
        return void (await afterRollback(run, key, retryStatus));
      }
      let afterRollback: (run: (key: string) => Promise<CallResult>, key: string, status: number) => Promise<void>;

      it("provision", async () => {
        const ownerEmail = email(`fault-provision-${point}`);
        const workspacesBefore = await h.count("workspaces");
        afterRollback = async (run, key, status) => {
          expect(await h.count("workspaces")).toBe(workspacesBefore);
          expect(await h.count("users", { email: ownerEmail })).toBe(0);
          expect((await run(key)).status).toBe(status);
          expect(await h.count("users", { email: ownerEmail })).toBe(1);
        };
        await faulted((key) => provision(ownerEmail, key), 201);
      });

      it("access set", async () => {
        const ws = await workspace();
        afterRollback = async (run, key, status) => {
          expect(await h.crm.workspaceAccess(ws.id)).toEqual({ mode: "active", expiresAt: null });
          expect(await h.count("audit_events", { workspace_id: ws.id, operation: "hosting.workspace.access_set" })).toBe(0);
          expect(await h.count("service_audit", { workspace_id: ws.id, action: "workspace.access.set", result_code: "ok" })).toBe(0);
          expect((await run(key)).status).toBe(status);
          expect((await h.crm.workspaceAccess(ws.id)).mode).toBe("locked");
        };
        await faulted(
          (key) => call("PUT", `/api/v1/workspaces/${ws.id}/access`, { idem: key, body: { accessMode: "locked" } }),
          200,
        );
      });

      it("owner transfer", async () => {
        const ws = await workspace();
        const successor = await activeMember(ws.id);
        afterRollback = async (run, key, status) => {
          expect(await h.ownerOf(ws.id)).toBe(ws.ownerId);
          expect((await call("GET", `/api/v1/workspaces/${ws.id}`)).json.data.version).toBe(1);
          expect((await run(key)).status).toBe(status);
          expect(await h.ownerOf(ws.id)).toBe(successor);
        };
        await faulted(
          (key) =>
            call("PUT", `/api/v1/workspaces/${ws.id}/owner`, {
              idem: key,
              body: { targetUserId: successor, reason: "contract" },
            }),
          200,
        );
      });

      it("owner recovery", async () => {
        const ws = await workspace();
        afterRollback = async (run, key, status) => {
          expect(await h.count("audit_events", { workspace_id: ws.id, operation: "hosting.workspace.owner_recovery" })).toBe(0);
          expect((await run(key)).status).toBe(status);
          expect(await h.count("audit_events", { workspace_id: ws.id, operation: "hosting.workspace.owner_recovery" })).toBe(1);
        };
        await faulted(
          (key) => call("POST", `/api/v1/workspaces/${ws.id}/owner/recovery`, { idem: key, body: { reason: "contract" } }),
          202,
        );
      });

      it("permanent delete", async () => {
        const ws = await workspace();
        afterRollback = async (run, key, status) => {
          expect(await h.count("workspaces", { id: ws.id })).toBe(1);
          expect(await h.count("users", { email: ws.ownerEmail })).toBe(1);
          expect(await h.count("access", { workspace_id: ws.id })).toBe(1);
          expect(await h.count("service_audit", { workspace_id: ws.id })).toBeGreaterThan(0);
          expect((await run(key)).status).toBe(status);
          expect(await h.count("workspaces", { id: ws.id })).toBe(0);
        };
        await faulted(
          (key) => call("DELETE", `/api/v1/workspaces/${ws.id}`, { idem: key, body: { reason: "contract" } }),
          204,
        );
      });
    });
  });
}

contractSuite("sqlite", sqliteHarness);

describe.runIf(PG_ENABLED)("hosting-control on PostgreSQL — role proofs", () => {
  let h: PgHarness;
  let operator: PgHandle;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    h = await pgHarness();
    operator = await connectPg({ databaseUrl: h.operatorUrl, max: 2 });
    for (const tag of ["a", "b"]) {
      const hc = createHostingControlServer({ store: h.store, serviceKeys: [KEY], host: "127.0.0.1", port: 0 });
      const { port } = await hc.listen();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "idempotency-key": `roles-${tag}`, "content-type": "application/json" },
        body: JSON.stringify({ organizationName: `Roles ${tag}`, ownerEmail: `${tag}@roles.test` }),
      });
      const id = ((await res.json()) as { data: { workspaceId: string } }).data.workspaceId;
      if (tag === "a") wsA = id;
      else wsB = id;
      await hc.close();
    }
  }, 120_000);

  afterAll(async () => {
    await operator?.close();
    await h?.close();
  });

  /** Run statements as crm_operator bound to a workspace, then roll back. */
  async function asOperatorIn<T>(workspaceId: string | null, fn: (q: (text: string, v?: unknown[]) => Promise<any[]>) => Promise<T>) {
    const c = await operator.pool.connect();
    try {
      await c.query("BEGIN");
      if (workspaceId) await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return await fn(async (text, v) => (await c.query(text, v)).rows);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }

  it("crm_operator is neither superuser nor BYPASSRLS", async () => {
    const role = await h.admin.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'crm_operator'");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("crm_operator cannot list across workspaces: unbound it sees none, bound it sees one", async () => {
    expect(await h.count("workspaces")).toBeGreaterThanOrEqual(2);
    await asOperatorIn(null, async (q) => {
      expect((await q("SELECT count(*)::int AS n FROM crm.workspaces"))[0].n).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM crm.users"))[0].n).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM hosting.workspace_access"))[0].n).toBe(0);
    });
    await asOperatorIn(wsA, async (q) => {
      expect((await q("SELECT id::text AS id FROM crm.workspaces")).map((r) => r.id)).toEqual([wsA]);
      expect((await q("SELECT workspace_id::text AS id FROM hosting.workspace_access")).map((r) => r.id)).toEqual([wsA]);
      expect((await q("SELECT email FROM crm.users")).map((r) => r.email)).toEqual(["a@roles.test"]);
      // Writing another workspace's rows is refused by the policy.
      await expect(
        q("INSERT INTO hosting.workspace_access (workspace_id, created_at, updated_at) VALUES ($1, now(), now())", [wsB]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("the outbox is workspace-bound; only the sweep's definer lists pending deliveries", async () => {
    await h.admin.pool.query(
      `INSERT INTO hosting.auth_delivery_outbox (id, workspace_id, user_id, purpose, state, created_at, updated_at)
       SELECT gen_random_uuid(), m.workspace_id, m.user_id, 'setup', 'pending', now(), now()
       FROM crm.memberships m WHERE m.workspace_id IN ($1, $2)`,
      [wsA, wsB],
    );
    try {
      await asOperatorIn(null, async (q) => {
        expect((await q("SELECT count(*)::int AS n FROM hosting.auth_delivery_outbox"))[0].n).toBe(0);
        const pending = await q("SELECT workspace_id::text AS ws FROM hosting.pending_auth_deliveries()");
        expect(pending.map((r) => r.ws).sort()).toEqual([wsA, wsB].sort());
      });
      await asOperatorIn(wsA, async (q) => {
        expect((await q("SELECT workspace_id::text AS ws FROM hosting.auth_delivery_outbox")).map((r) => r.ws)).toEqual([wsA]);
        const touched = await q("UPDATE hosting.auth_delivery_outbox SET attempts = attempts + 1 WHERE workspace_id = $1 RETURNING 1", [wsB]);
        expect(touched).toHaveLength(0);
      });
      await expect(h.app.pool.query("SELECT * FROM hosting.pending_auth_deliveries()")).rejects.toThrow(/permission denied/i);
    } finally {
      await h.admin.pool.query("DELETE FROM hosting.auth_delivery_outbox WHERE workspace_id IN ($1, $2)", [wsA, wsB]);
    }
  });

  it("crm_operator has no generic issuer storage, sessions or schema changes", async () => {
    await asOperatorIn(null, async (q) => {
      await expect(q("SELECT crm.openauth_kv_get('x')")).rejects.toThrow(/permission denied/i);
    });
    await asOperatorIn(null, async (q) => {
      await expect(q("SELECT * FROM crm.openauth_kv")).rejects.toThrow(/permission denied/i);
    });
    await asOperatorIn(null, async (q) => {
      await expect(q("SELECT * FROM crm.sessions")).rejects.toThrow(/permission denied/i);
    });
    await asOperatorIn(null, async (q) => {
      await expect(q("CREATE TABLE hosting.evil (id int)")).rejects.toThrow(/permission denied/i);
    });
  });

  it("crm_app cannot reach the hosting schema; the access reader answers only for its own workspace", async () => {
    await expect(h.app.pool.query("SELECT * FROM hosting.workspace_access")).rejects.toThrow(/permission denied for schema hosting/i);
    await expect(h.app.pool.query("SELECT * FROM hosting.service_audit")).rejects.toThrow(/permission denied for schema hosting/i);

    const lock = await h.admin.pool.query(
      "UPDATE hosting.workspace_access SET access_mode = 'locked' WHERE workspace_id = $1 RETURNING 1",
      [wsB],
    );
    expect(lock.rowCount).toBe(1);
    const c = await h.app.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      expect((await c.query("SELECT * FROM crm.workspace_access_state($1)", [wsB])).rows).toEqual([]);
      expect((await c.query("SELECT access_mode FROM crm.workspace_access_state($1)", [wsA])).rows).toEqual([
        { access_mode: "active" },
      ]);
      await c.query("ROLLBACK");
      expect((await c.query("SELECT * FROM crm.workspace_access_state($1)", [wsB])).rows).toEqual([]);
    } finally {
      c.release();
    }
    expect(await h.crm.workspaceAccess(wsB)).toEqual({ mode: "locked", expiresAt: null });
  });
});

if (PG_ENABLED) contractSuite("postgres", pgHarness);
