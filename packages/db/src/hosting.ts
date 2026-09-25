/**
 * The hosting-control data interface: everything the private hosting control
 * API (packages/hosting-control) reads and writes, as narrow operations with
 * one implementation per database adapter — SQLite (./sqlite-hosting.ts) and
 * PostgreSQL (./pg/hosting.ts). Hosting control keeps the business rules
 * (versions, eligibility, error codes, idempotency, one-time-code handling)
 * and never touches a database handle.
 *
 * Transactions: `withTransaction(fn)` is the identity store's transaction
 * (./identity.ts) — code issuance through `identity` joins it — so one
 * hosting request commits its idempotency receipt, lifecycle change, CRM and
 * service audit, and delivery outbox together or not at all.
 *
 * Workspace scope: every operation that names a workspace runs bound to it.
 * On PostgreSQL that installs the workspace as the transaction's row-level
 * security context (a transaction can never switch workspaces). Receipts,
 * the service audit and the outbox are hosting-control's own records and are
 * not workspace-bound: a receipt is read before any target is known, and the
 * outbox sweep runs across workspaces.
 */
import type { AuthCodePurpose } from "./openauth.ts";
import type { IdentityStore } from "./identity.ts";
import { openDatabase, resolveDbPath } from "./connection.ts";
import { isPostgresUrl, isSqliteFileUrl, unsupportedDatabaseUrl } from "./runtime.ts";
import { createSqliteHostingStore } from "./sqlite-hosting.ts";

export interface Receipt {
  idempotencyKey: string;
  action: string;
  requestHash: string;
  targetHash: string | null;
  state: "pending" | "completed";
  httpStatus: number | null;
  responseBody: string | null;
  requestId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AccessState {
  workspaceId: string;
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  version: number;
}

export interface ServiceAuditInput {
  id: string;
  requestId: string;
  idempotencyKey: string | null;
  action: string;
  method: string;
  path: string;
  workspaceId: string | null;
  targetHash: string | null;
  reason: string | null;
  serviceIdentity: string;
  resultCode: string;
  httpStatus: number;
  retryable: boolean;
  productVersion: string | null;
  startedAt: string;
  completedAt: string;
}

export interface OutboxRow {
  id: string;
  workspaceId: string;
  userId: string;
  purpose: AuthCodePurpose;
  state: "pending" | "sent" | "abandoned";
  attempts: number;
}

/** A workspace member as hosting control judges eligibility. */
export interface HostedMember {
  id: string;
  email: string;
  status: string | null;
  disabledAt: string | null;
  /** Legacy fallback for rows predating the status column. */
  hasPassword: boolean;
}

export interface HostingStore {
  readonly adapter: "sqlite" | "postgres";
  /** Code issuance, credential and subject lookups — same transaction scope. */
  readonly identity: IdentityStore;
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Create hosting-control's own tables where the adapter needs it (idempotent). */
  ensureSchema(): Promise<void>;
  schemaVersion(): Promise<number>;

  // --- idempotency receipts (not workspace-bound) ---------------------------
  /**
   * Claim the key. Exactly one concurrent caller wins; the others get the
   * existing receipt (pending → in progress, completed → replay). A pending
   * claim older than the takeover window may be taken over after a crash.
   */
  beginReceipt(
    idempotencyKey: string,
    action: string,
    requestHash: string,
    requestId: string,
  ): Promise<{ started: true } | { started: false; receipt: Receipt }>;
  completeReceipt(
    idempotencyKey: string,
    done: { targetHash: string | null; httpStatus: number; responseBody: string | null },
  ): Promise<void>;
  /** Release a claimed key after a failed execution so the caller may retry. */
  abandonReceipt(idempotencyKey: string): Promise<void>;
  getReceipt(idempotencyKey: string): Promise<Receipt | null>;

  // --- service audit (not workspace-bound) -----------------------------------
  writeAudit(entry: ServiceAuditInput): Promise<void>;
  /** After permanent deletion only the one-way target hash may remain. */
  redactAudit(workspaceId: string): Promise<void>;

  // --- delivery outbox (not workspace-bound: the sweep spans workspaces) -----
  insertOutbox(row: { id: string; workspaceId: string; userId: string; purpose: AuthCodePurpose }): Promise<void>;
  markOutbox(id: string, state: "sent" | "abandoned" | "pending", lastError?: string): Promise<void>;
  listPendingOutbox(): Promise<OutboxRow[]>;
  deleteOutbox(workspaceId: string): Promise<void>;

  // --- workspace access state (workspace-bound) -------------------------------
  getAccess(workspaceId: string): Promise<AccessState | null>;
  insertAccess(workspaceId: string, mode: "active" | "locked", expiresAt: string | null): Promise<void>;
  /** Sets mode and expiry and bumps the version. */
  updateAccess(workspaceId: string, mode: "active" | "locked", expiresAt: string | null): Promise<void>;
  deleteAccess(workspaceId: string): Promise<void>;

  // --- CRM rows (workspace-bound) ---------------------------------------------
  workspaceExists(workspaceId: string): Promise<boolean>;
  /** Insert the workspace row with default settings. The id is generated by the caller. */
  createWorkspace(input: { id: string; name: string; defaultCurrency: string; timezone: string }): Promise<void>;
  /**
   * Create the owner user and its owner membership. `email_taken` when the
   * (deployment-wide unique) email already belongs to a user anywhere — the
   * answer reveals nothing else about that user.
   */
  createOwner(
    workspaceId: string,
    owner: { id: string; email: string; name: string; status: "pending" | "active"; authSubject: string | null },
  ): Promise<"created" | "email_taken">;
  /** Default engagement ("Outreach") and deal ("Sales") pipelines with their stages. */
  seedDefaultPipelines(workspaceId: string): Promise<void>;
  /** The current owner, if any. */
  ownerOf(workspaceId: string): Promise<HostedMember | null>;
  /** A member of THIS workspace by user id or email; other workspaces never match. */
  findMember(workspaceId: string, by: { userId: string } | { email: string }): Promise<HostedMember | null>;
  /** Demote every current owner to admin, then promote the target to owner. */
  swapOwner(workspaceId: string, targetUserId: string): Promise<void>;
  /** A CRM audit event on the workspace, recorded as a system action. */
  workspaceAuditEvent(workspaceId: string, operation: string, summary: string, meta?: Record<string, unknown>): Promise<void>;
  /** The user an outbox row targets, for re-delivery. */
  memberForDelivery(workspaceId: string, userId: string): Promise<HostedMember | null>;
  /**
   * Physically remove the workspace: every workspace-scoped CRM row, users
   * whose only membership it was, their sessions, and the workspace row
   * (PostgreSQL also purges those users' issuer credentials). Hosting-control's
   * own rows are handled by the caller. Returns false when the workspace did
   * not exist.
   */
  deleteWorkspace(workspaceId: string): Promise<boolean>;
}

/**
 * The hosting store for this process, chosen from DATABASE_URL with the same
 * rules as the CRM runtime: postgresql:// → PostgreSQL, unset or file: → the
 * SQLite file. On PostgreSQL the URL must carry hosting control's own
 * `crm_operator` login — never the CRM's `crm_app`, never a superuser.
 */
export async function createHostingStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: HostingStore; close(): Promise<void> }> {
  const url = env.DATABASE_URL?.trim();
  if (url && isPostgresUrl(url)) {
    // Lazy import: the SQLite default never loads the pg adapter's modules.
    const { connectPgHostingStore } = await import("./pg/hosting.ts");
    return connectPgHostingStore(url);
  }
  if (url && !isSqliteFileUrl(url)) throw unsupportedDatabaseUrl(url);
  const db = openDatabase(resolveDbPath(env));
  return { store: createSqliteHostingStore(db), close: async () => void db.$client.close() };
}
