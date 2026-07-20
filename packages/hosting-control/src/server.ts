/**
 * The hosting control API: a standalone node:http service for the PRIVATE
 * network address. It is never routed from the public domain, accepts no
 * human sessions and no MCP keys — only dedicated hosting-control service
 * keys, verified timing-safe. There is no keyless mode (health excepted, so
 * a load balancer can probe readiness without a secret).
 *
 * Endpoints (base /api/v1, per docs/architecture/hosting-control-api.md):
 *   GET    /healthz | /api/v1/health          — readiness, versions; no product data
 *   GET    /api/v1/workspaces/:id             — limited workspace control state
 *   POST   /api/v1/workspaces                 — provision workspace + PENDING owner + defaults;
 *                                               routes a setup code through the delivery seam
 *   PUT    /api/v1/workspaces/:id/access      — set generic active/locked access state
 *   PUT    /api/v1/workspaces/:id/owner       — bounded owner transfer to an existing
 *                                               active user of the same workspace
 *   POST   /api/v1/workspaces/:id/owner/recovery — initiate owner credential recovery
 *   DELETE /api/v1/workspaces/:id             — idempotent permanent delete
 *
 * Every mutation requires an Idempotency-Key header; the same key with the
 * same canonical request replays the original response, a different request
 * with the same key is a stable conflict, and mutations + their idempotency
 * receipt + the service audit row commit in one database transaction.
 * Setup/reset codes are one-time material: they may appear in the LIVE
 * response only when no delivery URL is configured (display mode), are
 * stripped from the stored receipt, and are never logged; only their
 * redemption hash rests in the CRM code store (issueAuthCodeSync).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { newId, nowIso } from "@emcp/core";
import { deliverAuthCode, sha256Hex, type Db } from "@emcp/db";
import { HcError } from "./errors.ts";
import { errorNote, retryPendingAuthDeliveries } from "./auth-delivery.ts";
import {
  abandonReceipt,
  beginReceipt,
  completeReceipt,
  ensureHcTables,
  markOutbox,
  writeAudit,
  type Receipt,
} from "./hc-store.ts";
import {
  deleteWorkspacePermanently,
  getWorkspaceControlState,
  initiateOwnerRecovery,
  provisionWorkspace,
  setWorkspaceAccess,
  transferWorkspaceOwner,
  type ProvisionInput,
  type SetAccessInput,
  type SetupInitiation,
  type TransferOwnerInput,
} from "./lifecycle.ts";

const MIN_KEY_LENGTH = 32; // the doc requires at least 32 random bytes
const MAX_BODY_BYTES = 1_000_000;

export interface HostingControlOptions {
  db: Db;
  /** One or more raw service keys (>= 32 chars each) so rotation can overlap. */
  serviceKeys: string[];
  /** Default 127.0.0.1 — the service must stay off the public interface. */
  host?: string;
  /** Default HC_PORT env or 8787. Tests pass 0 for an ephemeral port. */
  port?: number;
  serviceIdentity?: string;
}

export interface HostingControlServer {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

interface RequestState {
  requestId: string;
  method: string;
  path: string;
  startedAt: string;
  identity: string;
  action: string;
  audited: boolean;
  workspaceId: string | null;
  targetHash: string | null;
  idempotencyKey: string | null;
  reason: string | null;
}

interface MutationOutcome {
  status: number;
  data?: unknown;
  workspaceId?: string | null;
  targetHash?: string | null;
  reason?: string | null;
  resultCode?: string;
  /**
   * Top-level `data` keys holding one-time material (setup/reset codes).
   * They appear in the LIVE response only; the stored receipt — and thus
   * every replay — carries the confirmation without them, so credential
   * material never enters storage.
   */
  oneTimeFields?: string[];
  /** Runs after the transaction commits, before the response is sent. Must not throw. */
  afterCommit?: () => Promise<void>;
}

export function createHostingControlServer(opts: HostingControlOptions): HostingControlServer {
  const db = opts.db;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.HC_PORT ?? 8787);
  if (opts.serviceKeys.length === 0) throw new Error("hosting-control requires at least one service key");
  for (const key of opts.serviceKeys) {
    if (typeof key !== "string" || key.length < MIN_KEY_LENGTH) {
      throw new Error(`hosting-control service keys must be at least ${MIN_KEY_LENGTH} characters`);
    }
  }
  const keyDigests = opts.serviceKeys.map((k) => createHash("sha256").update(k).digest());
  const baseIdentity = opts.serviceIdentity ?? "hosting-control";

  ensureHcTables(db);
  const productVersion = readProductVersion();

  // --- helpers --------------------------------------------------------------

  function authenticate(req: IncomingMessage): { ok: boolean; identity: string } {
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return { ok: false, identity: "anonymous" };
    const presented = createHash("sha256").update(token).digest();
    let matched = -1;
    for (let i = 0; i < keyDigests.length; i++) {
      // Compare against every configured key (no early exit) — constant work.
      const same = timingSafeEqual(presented, keyDigests[i]!);
      if (same && matched === -1) matched = i;
    }
    if (matched === -1) return { ok: false, identity: "anonymous" };
    return { ok: true, identity: `${baseIdentity}#key${matched}` };
  }

  function schemaVersion(): number {
    try {
      return Number(db.$client.pragma("user_version", { simple: true })) || 0;
    } catch {
      return 0;
    }
  }

  function writeAuditRow(rc: RequestState, resultCode: string, httpStatus: number, retryable: boolean): void {
    writeAudit(db, {
      id: newId(),
      requestId: rc.requestId,
      idempotencyKey: rc.idempotencyKey,
      action: rc.action,
      method: rc.method,
      path: rc.path,
      workspaceId: rc.workspaceId,
      targetHash: rc.targetHash,
      reason: rc.reason,
      serviceIdentity: rc.identity,
      resultCode,
      httpStatus,
      retryable,
      productVersion,
      startedAt: rc.startedAt,
      completedAt: nowIso(),
    });
  }

  function finishAudit(rc: RequestState, resultCode: string, httpStatus: number, retryable: boolean): void {
    if (rc.audited) return;
    rc.audited = true;
    try {
      writeAuditRow(rc, resultCode, httpStatus, retryable);
    } catch (err) {
      console.error("[hosting-control] failed to write service audit row:", err);
    }
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  function sendError(res: ServerResponse, requestId: string, e: HcError): void {
    sendJson(res, e.status, {
      error: { code: e.code, message: e.message, retryable: e.retryable, ...(e.extra ?? {}) },
      requestId,
    });
  }

  function sendStored(res: ServerResponse, receipt: Receipt): void {
    const status = receipt.httpStatus ?? 200;
    if (receipt.responseBody == null) {
      res.statusCode = status;
      res.end();
    } else {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(receipt.responseBody);
    }
  }

  async function runMutation(
    req: IncomingMessage,
    res: ServerResponse,
    rc: RequestState,
    action: string,
    build: (body: Record<string, unknown>) => MutationOutcome,
  ): Promise<void> {
    rc.action = action;
    const idemKey = headerValue(req, "idempotency-key");
    if (!idemKey || idemKey.length > 200) {
      throw new HcError(400, "validation_error", "Idempotency-Key header is required");
    }
    rc.idempotencyKey = idemKey;
    const body = await readJsonObject(req);
    const requestHash = sha256Hex(`${action}\n${rc.path}\n${canonicalJson(body)}`);

    const begin = beginReceipt(db, idemKey, action, requestHash, rc.requestId);
    if (!begin.started) {
      const receipt = begin.receipt;
      if (receipt.action !== action || receipt.requestHash !== requestHash) {
        throw new HcError(409, "idempotency_conflict", "This idempotency key was already used for a different request");
      }
      if (receipt.state === "pending") {
        throw new HcError(409, "request_in_progress", "A request with this idempotency key is in progress", undefined, true);
      }
      rc.targetHash = receipt.targetHash;
      finishAudit(rc, "replayed", receipt.httpStatus ?? 200, false);
      sendStored(res, receipt);
      return;
    }

    try {
      const execute = db.$client.transaction(() => {
        const out = build(body);
        const responseBody = out.status === 204 ? null : JSON.stringify({ data: out.data, requestId: rc.requestId });
        // One-time material may leave through the live response exactly once;
        // the stored receipt (replayed verbatim later) never contains it.
        let storedBody = responseBody;
        if (
          responseBody != null &&
          out.oneTimeFields?.length &&
          out.data &&
          typeof out.data === "object" &&
          !Array.isArray(out.data)
        ) {
          const redacted: Record<string, unknown> = { ...(out.data as Record<string, unknown>) };
          for (const field of out.oneTimeFields) delete redacted[field];
          storedBody = JSON.stringify({ data: redacted, requestId: rc.requestId });
        }
        rc.workspaceId = out.workspaceId ?? null;
        rc.targetHash = out.targetHash ?? null;
        rc.reason = out.reason ?? null;
        completeReceipt(db, idemKey, { targetHash: out.targetHash ?? null, httpStatus: out.status, responseBody: storedBody });
        // The audit row commits atomically with the mutation and the receipt.
        writeAuditRow(rc, out.resultCode ?? "ok", out.status, false);
        return { status: out.status, responseBody, afterCommit: out.afterCommit };
      });
      const { status, responseBody, afterCommit } = execute();
      rc.audited = true;
      // Post-commit work (auth-code delivery). The durable state is already
      // committed; a failure here defers to the outbox, never to the caller.
      if (afterCommit) await afterCommit();
      if (responseBody == null) {
        res.statusCode = status;
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(responseBody);
      }
    } catch (err) {
      try {
        abandonReceipt(db, idemKey); // release the key so the caller may retry
      } catch {
        /* keep the original error */
      }
      throw err;
    }
  }

  /**
   * Post-commit immediate delivery attempt for a queued setup/reset code.
   * The committed outbox row is the durable acknowledgement; this attempt is
   * best-effort acceleration. Failure marks the row for the boot-time sweep
   * and NEVER surfaces to the caller (and never logs the code).
   */
  function attemptDelivery(setup: SetupInitiation): (() => Promise<void>) | undefined {
    if (setup.delivery !== "queued" || !setup.outboxId) return undefined;
    const { email, code, purpose, outboxId } = setup;
    return async () => {
      try {
        await deliverAuthCode({ email, code, purpose });
        markOutbox(db, outboxId, "sent");
      } catch (err) {
        try {
          markOutbox(db, outboxId, "pending", errorNote(err));
        } catch {
          /* the pending row already carries the retry */
        }
        console.error(`[hosting-control] auth-code delivery deferred to the outbox (${outboxId}): ${errorNote(err)}`);
      }
    };
  }

  // --- request handling -----------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = nowIso();
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://hosting-control.internal");
    const path = url.pathname;
    const requestId = sanitizeRequestId(headerValue(req, "x-request-id")) ?? `req_${randomUUID()}`;
    res.setHeader("X-Request-Id", requestId);

    // Health carries no workspace, user, credential, or CRM data and may be
    // probed by the load balancer without the service key.
    if (method === "GET" && (path === "/healthz" || path === "/api/v1/health")) {
      sendJson(res, 200, { data: { status: "ok", productVersion, schemaVersion: schemaVersion() }, requestId });
      return;
    }

    const rc: RequestState = {
      requestId,
      method,
      path,
      startedAt,
      identity: "anonymous",
      action: "route.unknown",
      audited: false,
      workspaceId: null,
      targetHash: null,
      idempotencyKey: null,
      reason: null,
    };

    const auth = authenticate(req);
    rc.identity = auth.identity;
    if (!auth.ok) {
      rc.action = "auth.rejected";
      finishAudit(rc, "unauthorized", 401, false);
      sendError(res, requestId, new HcError(401, "unauthorized", "Missing or invalid hosting-control service key"));
      return;
    }

    try {
      const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)$/);
      const accessMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/access$/);
      const ownerMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/owner$/);
      const recoveryMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/owner\/recovery$/);

      if (method === "POST" && path === "/api/v1/workspaces") {
        await runMutation(req, res, rc, "workspace.provision", (body) => {
          const input = parseProvisionBody(body);
          const result = provisionWorkspace(db, input);
          return {
            status: 201,
            data: {
              workspaceId: result.workspaceId,
              ownerUserId: result.ownerUserId,
              ownerStatus: result.ownerStatus,
              accessMode: result.accessMode,
              accessExpiresAt: result.accessExpiresAt,
              version: result.version,
              setupDelivery: result.setup?.delivery ?? "none",
              // Display mode only (self-host/dev, no delivery URL): the
              // one-time setup code rides the live response ONCE. An active
              // owner (verified credential, trial-first signup) has no code.
              ...(result.setup?.delivery === "display" ? { setupCode: result.setup.code } : {}),
            },
            workspaceId: result.workspaceId,
            targetHash: sha256Hex(result.workspaceId),
            resultCode: "created",
            oneTimeFields: ["setupCode"],
            afterCommit: result.setup ? attemptDelivery(result.setup) : undefined,
          };
        });
      } else if (method === "PUT" && ownerMatch) {
        const workspaceId = decodeURIComponent(ownerMatch[1]!);
        rc.workspaceId = workspaceId;
        rc.targetHash = sha256Hex(workspaceId);
        await runMutation(req, res, rc, "workspace.owner.transfer", (body) => {
          const input = parseTransferBody(body);
          const result = transferWorkspaceOwner(db, workspaceId, input);
          return {
            status: 200,
            data: {
              workspaceId,
              ownerUserId: result.ownerUserId,
              previousOwnerUserId: result.previousOwnerUserId,
              version: result.version,
            },
            workspaceId,
            targetHash: sha256Hex(workspaceId),
            reason: input.reason,
            resultCode: result.changed ? "transferred" : "already_owner",
          };
        });
      } else if (method === "POST" && recoveryMatch) {
        const workspaceId = decodeURIComponent(recoveryMatch[1]!);
        rc.workspaceId = workspaceId;
        rc.targetHash = sha256Hex(workspaceId);
        await runMutation(req, res, rc, "workspace.owner.recovery", (body) => {
          const reason = requiredReason(body);
          const result = initiateOwnerRecovery(db, workspaceId, reason);
          return {
            // 202: the recovery event is durably queued once the transaction
            // (outbox row + receipt + audits) commits.
            status: 202,
            data: {
              workspaceId,
              recovery: "initiated",
              purpose: result.setup.purpose,
              delivery: result.setup.delivery,
              ...(result.setup.delivery === "display" ? { code: result.setup.code } : {}),
            },
            workspaceId,
            targetHash: sha256Hex(workspaceId),
            reason,
            resultCode: "initiated",
            oneTimeFields: ["code"],
            afterCommit: attemptDelivery(result.setup),
          };
        });
      } else if (method === "PUT" && accessMatch) {
        const workspaceId = decodeURIComponent(accessMatch[1]!);
        rc.workspaceId = workspaceId;
        rc.targetHash = sha256Hex(workspaceId);
        await runMutation(req, res, rc, "workspace.access.set", (body) => {
          const input = parseAccessBody(body);
          const state = setWorkspaceAccess(db, workspaceId, input);
          return {
            status: 200,
            data: {
              workspaceId,
              accessMode: state.accessMode,
              accessExpiresAt: state.accessExpiresAt,
              version: state.version,
            },
            workspaceId,
            targetHash: sha256Hex(workspaceId),
            reason: input.reason ?? null,
          };
        });
      } else if (method === "DELETE" && workspaceMatch) {
        const workspaceId = decodeURIComponent(workspaceMatch[1]!);
        rc.targetHash = sha256Hex(workspaceId);
        await runMutation(req, res, rc, "workspace.delete", (body) => {
          const reason = optionalString(body, "reason", 500);
          const { existed } = deleteWorkspacePermanently(db, workspaceId);
          return {
            // After deletion only the one-way hash may remain in the receipt.
            status: 204,
            workspaceId: null,
            targetHash: sha256Hex(workspaceId),
            reason: reason ?? null,
            resultCode: existed ? "deleted" : "already_absent",
          };
        });
      } else if (method === "GET" && workspaceMatch) {
        rc.action = "workspace.read";
        const workspaceId = decodeURIComponent(workspaceMatch[1]!);
        const state = getWorkspaceControlState(db, workspaceId);
        // Deleted and never-existed answer identically.
        if (!state) throw new HcError(404, "not_found", "Unknown workspace");
        rc.workspaceId = workspaceId;
        rc.targetHash = sha256Hex(workspaceId);
        finishAudit(rc, "ok", 200, false);
        sendJson(res, 200, { data: state, requestId });
      } else {
        throw new HcError(404, "not_found", "Unknown route");
      }
    } catch (err) {
      let e: HcError;
      if (err instanceof HcError) {
        e = err;
      } else {
        // Never leak SQL, stack traces, or table names to the caller.
        console.error("[hosting-control] unexpected failure:", err);
        e = new HcError(500, "internal_error", "Unexpected internal failure", undefined, true);
      }
      finishAudit(rc, e.code, e.status, e.retryable);
      sendError(res, requestId, e);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = addr && typeof addr === "object" ? addr.port : port;
          // Deliver auth codes whose 202/201 was acknowledged before a crash
          // (committed outbox rows). Never throws; sweeps before serving.
          void retryPendingAuthDeliveries(db)
            .catch((err) => console.error("[hosting-control] outbox sweep failed:", err))
            .finally(() => resolveListen({ host, port: actualPort }));
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}

// --- parsing / validation ---------------------------------------------------

function parseProvisionBody(body: Record<string, unknown>): ProvisionInput {
  if (body.ownerPassword != null) {
    // Provisioning carries no credential material. The owner is created
    // pending and activates through a delivered single-use setup code.
    throw new HcError(
      400,
      "validation_error",
      "ownerPassword is not accepted — owners are provisioned pending and activate through a delivered setup code",
    );
  }
  const organizationName = optionalString(body, "organizationName", 200);
  if (!organizationName?.trim()) throw new HcError(400, "validation_error", "organizationName is required");
  // Contract (hosting-control-api.md + auth-api.md §Hosted open registration):
  // the owner identity is EITHER an OpenAuth subject (trial-first signup — the
  // registered+verified identity provisions itself) OR a plain email
  // (staff/manual provisioning; the owner starts pending with a setup code).
  const authSubject = optionalString(body, "authSubject", 200)?.trim() || null;
  const ownerEmail = optionalString(body, "ownerEmail", 320)?.trim() || null;
  if (!authSubject && !ownerEmail) {
    throw new HcError(400, "validation_error", "one of authSubject or ownerEmail is required");
  }
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new HcError(400, "validation_error", "ownerEmail must be a valid email address");
  }
  const ownerName = optionalString(body, "ownerName", 200);
  const accessMode = parseAccessMode(body.accessMode ?? "active");
  const accessExpiresAt = parseIsoOrNull(body.accessExpiresAt, "accessExpiresAt");
  const defaultCurrency = optionalString(body, "defaultCurrency", 3);
  if (defaultCurrency != null && !/^[A-Z]{3}$/.test(defaultCurrency)) {
    throw new HcError(400, "validation_error", "defaultCurrency must be a 3-letter ISO code");
  }
  const timezone = optionalString(body, "timezone", 100);
  return {
    organizationName: organizationName.trim(),
    ...(authSubject ? { authSubject } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(ownerName != null ? { ownerName } : {}),
    accessMode,
    accessExpiresAt,
    ...(defaultCurrency != null ? { defaultCurrency } : {}),
    ...(timezone != null ? { timezone } : {}),
  };
}

function parseTransferBody(body: Record<string, unknown>): TransferOwnerInput {
  const targetUserId = optionalString(body, "targetUserId", 100)?.trim();
  const targetEmail = optionalString(body, "targetEmail", 320)?.trim();
  if ((targetUserId ? 1 : 0) + (targetEmail ? 1 : 0) !== 1) {
    throw new HcError(400, "validation_error", "Provide exactly one of targetUserId or targetEmail");
  }
  let expectedVersion: number | null = null;
  if (body.expectedVersion != null) {
    if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
      throw new HcError(400, "validation_error", "expectedVersion must be a non-negative integer");
    }
    expectedVersion = body.expectedVersion;
  }
  return {
    ...(targetUserId ? { targetUserId } : {}),
    ...(targetEmail ? { targetEmail } : {}),
    expectedVersion,
    reason: requiredReason(body),
  };
}

/** Transfer and recovery are hosting-superuser actions: the reason is mandatory. */
function requiredReason(body: Record<string, unknown>): string {
  const reason = optionalString(body, "reason", 500)?.trim();
  if (!reason) throw new HcError(400, "validation_error", "reason is required for hosting-superuser actions");
  return reason;
}

function parseAccessBody(body: Record<string, unknown>): SetAccessInput {
  // Canonical field names follow the architecture doc (accessMode /
  // accessExpiresAt); state / expiresAt are accepted as aliases.
  const accessMode = parseAccessMode(body.accessMode ?? body.state);
  const expiresRaw = "accessExpiresAt" in body ? body.accessExpiresAt : body.expiresAt;
  const accessExpiresAt = parseIsoOrNull(expiresRaw, "accessExpiresAt");
  let expectedVersion: number | null = null;
  if (body.expectedVersion != null) {
    if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
      throw new HcError(400, "validation_error", "expectedVersion must be a non-negative integer");
    }
    expectedVersion = body.expectedVersion;
  }
  const reason = optionalString(body, "reason", 500);
  return { accessMode, accessExpiresAt, expectedVersion, reason: reason ?? null };
}

function parseAccessMode(value: unknown): "active" | "locked" {
  if (value !== "active" && value !== "locked") {
    throw new HcError(400, "validation_error", 'accessMode must be "active" or "locked"');
  }
  return value;
}

function parseIsoOrNull(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HcError(400, "validation_error", `${field} must be an ISO-8601 timestamp or null`);
  }
  return new Date(value).toISOString();
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new HcError(400, "validation_error", `${field} must be a string`);
  if (value.length > maxLength) throw new HcError(400, "validation_error", `${field} must be at most ${maxLength} characters`);
  return value;
}

// --- small utilities --------------------------------------------------------

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeRequestId(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._-]{1,120}$/.test(value) ? value : null;
}

/** Stable stringify (sorted object keys) so semantically equal bodies hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HcError(400, "validation_error", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HcError(400, "validation_error", "Body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HcError(400, "validation_error", "Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readProductVersion(): string {
  try {
    // packages/hosting-control/src/ -> repository root package.json
    const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
