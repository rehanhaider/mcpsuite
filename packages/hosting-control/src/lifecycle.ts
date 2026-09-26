/**
 * Workspace lifecycle for the hosting control API: provision, access set,
 * inspect, owner transfer, owner recovery, and permanent delete.
 *
 * The business rules live here — versions, eligibility, error codes — and
 * every read and write goes through the adapter's HostingStore
 * (@mcpsuite/db hosting.ts), so the same lifecycle runs on SQLite and
 * PostgreSQL. Every mutation MUST run inside `store.withTransaction` owned by
 * the HTTP layer, so product changes, CRM audit events, hosting-control's own
 * rows and idempotency completion commit or roll back together. Delivery of
 * setup/reset codes happens AFTER that commit (the committed outbox row is
 * the durable acknowledgement).
 *
 * Owners provisioned by email are created PENDING (no password, no
 * credential material in the request); they activate through a single-use
 * setup code routed via the delivery seam.
 */
import { OpError, newId } from "@mcpsuite/core";
import type { AuthCodePurpose, HostedMember, HostingStore } from "@mcpsuite/db";
import { deliveryMode, type DeliveryMode } from "./auth-delivery.ts";
import { HcError } from "./errors.ts";

export type { AccessState } from "@mcpsuite/db";

// --- Provision --------------------------------------------------------------

export interface ProvisionInput {
  organizationName: string;
  /**
   * The owner's verified OpenAuth subject (trial-first signup). Resolved to
   * its registered email; the owner is created ACTIVE with the subject bound.
   */
  authSubject?: string;
  /** Plain-email identity (staff/manual provisioning → pending owner). */
  ownerEmail?: string;
  ownerName?: string;
  accessMode?: "active" | "locked";
  accessExpiresAt?: string | null;
  defaultCurrency?: string;
  timezone?: string;
}

/** One-time setup material — the HTTP layer decides what a response may show. */
export interface SetupInitiation {
  /** Single-use code. Display mode may return it ONCE; it is never stored or logged. */
  code: string;
  /** Delivery target, for the post-commit send only — never in responses. */
  email: string;
  purpose: AuthCodePurpose;
  delivery: "queued" | "display";
  outboxId: string | null;
}

export interface ProvisionResult {
  workspaceId: string;
  ownerUserId: string;
  /** "active" when a verified OpenAuth credential already existed (trial-first signup). */
  ownerStatus: "pending" | "active";
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  version: number;
  /** null when the owner is active — no setup code exists. */
  setup: SetupInitiation | null;
}

export async function provisionWorkspace(store: HostingStore, input: ProvisionInput): Promise<ProvisionResult> {
  let resolvedEmail = input.ownerEmail?.trim().toLowerCase() ?? null;
  if (input.authSubject) {
    const fromSubject = await store.identity.emailForAuthSubject(input.authSubject);
    if (!fromSubject) {
      throw new HcError(404, "not_found", "authSubject does not resolve to a registered identity");
    }
    if (resolvedEmail && resolvedEmail !== fromSubject) {
      throw new HcError(400, "validation_error", "authSubject and ownerEmail identify different identities");
    }
    resolvedEmail = fromSubject;
  }
  const email = resolvedEmail!;

  // Trial-first signup (docs/auth-api.md §Hosted open registration): when a
  // completed OpenAuth credential already exists for this email — proof the
  // holder registered and verified on this deployment — the owner is created
  // ACTIVE with no setup code (they set their password during registration;
  // the session resolver binds the subject on their next request). Without a
  // credential the owner starts PENDING and activation happens through the
  // single-use setup code issued below via the CRM code store.
  const hasCredential = await store.identity.hasPasswordCredential(email);
  const ownerStatus = hasCredential ? ("active" as const) : ("pending" as const);
  const boundSubject = input.authSubject && hasCredential ? input.authSubject : null;

  // The id is generated first; on PostgreSQL creating the workspace installs
  // it as the transaction's row-level security context.
  const workspaceId = newId();
  await store.createWorkspace({
    id: workspaceId,
    name: input.organizationName,
    defaultCurrency: input.defaultCurrency ?? "USD",
    timezone: input.timezone ?? "UTC",
  });
  const ownerUserId = newId();
  const created = await store.createOwner(workspaceId, {
    id: ownerUserId,
    email,
    name: input.ownerName ?? "Owner",
    status: ownerStatus,
    authSubject: boundSubject,
  });
  if (created === "email_taken") {
    // Stable conflict that reveals nothing about the other workspace; the
    // request's transaction rolls the new workspace back.
    throw new HcError(409, "identity_unavailable", "This identity is already attached to a workspace");
  }
  await store.seedDefaultPipelines(workspaceId);

  const accessMode = input.accessMode ?? "active";
  const accessExpiresAt = input.accessExpiresAt ?? null;
  await store.insertAccess(workspaceId, accessMode, accessExpiresAt);

  const setup = hasCredential ? null : await initiateCodeDelivery(store, workspaceId, ownerUserId, email, "setup");

  await store.workspaceAuditEvent(workspaceId, "hosting.workspace.provision", "Workspace provisioned by hosting control", {
    accessMode,
    accessExpiresAt,
    ownerStatus,
    setupDelivery: setup?.delivery ?? "none",
  });

  return { workspaceId, ownerUserId, ownerStatus, accessMode, accessExpiresAt, version: 1, setup };
}

/**
 * Issue a single-use code through the CRM code store (redeemable by the login
 * flow; only its hash is at rest) and, in hosted mode, commit the outbox row
 * that makes its delivery durable. Issuance joins the request's open
 * transaction; a retried delivery later issues a fresh code.
 */
async function initiateCodeDelivery(
  store: HostingStore,
  workspaceId: string,
  userId: string,
  email: string,
  purpose: AuthCodePurpose,
): Promise<SetupInitiation> {
  let code: string;
  try {
    code = (await store.identity.issueCode(workspaceId, userId, purpose)).code;
  } catch (err) {
    if (err instanceof OpError && err.code === "conflict") {
      // The per-email issue window is exhausted (openauth's fixed-window limit).
      throw new HcError(429, "rate_limited", "Too many codes issued for this identity — retry later", undefined, true);
    }
    throw err;
  }
  const mode: DeliveryMode = deliveryMode();
  let outboxId: string | null = null;
  if (mode === "hosted") {
    outboxId = newId();
    await store.insertOutbox({ id: outboxId, workspaceId, userId, purpose });
  }
  return { code, email, purpose, delivery: mode === "hosted" ? "queued" : "display", outboxId };
}

/**
 * Resolve a user's auth state: `status` (pending | active | disabled) is
 * authoritative, with `disabledAt` honored as a hard override and a legacy
 * fallback (no credential ⇒ pending) for rows predating the status column.
 * Unknown status values count as ineligible.
 */
export function userAuthState(member: Pick<HostedMember, "status" | "disabledAt" | "hasPassword">): "pending" | "active" | "disabled" {
  if (member.disabledAt) return "disabled";
  if (typeof member.status === "string") {
    return member.status === "active" ? "active" : member.status === "pending" ? "pending" : "disabled";
  }
  return member.hasPassword ? "active" : "pending";
}

// --- Access -----------------------------------------------------------------

export interface SetAccessInput {
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  expectedVersion?: number | null;
  reason?: string | null;
}

export async function setWorkspaceAccess(store: HostingStore, workspaceId: string, input: SetAccessInput) {
  if (!(await store.lockWorkspace(workspaceId))) throw new HcError(404, "not_found", "Unknown workspace");

  const current = await store.getAccess(workspaceId);
  const currentVersion = current?.version ?? 0;
  if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
    throw new HcError(409, "version_conflict", `Access state version conflict; current version is ${currentVersion}`, {
      currentVersion,
    });
  }

  // Setting the current state again succeeds with no duplicate effect.
  if (current && current.accessMode === input.accessMode && current.accessExpiresAt === input.accessExpiresAt) {
    return current;
  }

  if (!current) await store.insertAccess(workspaceId, input.accessMode, input.accessExpiresAt);
  else await store.updateAccess(workspaceId, input.accessMode, input.accessExpiresAt);

  await store.workspaceAuditEvent(
    workspaceId,
    "hosting.workspace.access_set",
    `Hosting access set to ${input.accessMode}${input.accessExpiresAt ? ` (expires ${input.accessExpiresAt})` : ""}`,
    { accessMode: input.accessMode, accessExpiresAt: input.accessExpiresAt, reason: input.reason ?? null },
  );

  const next = await store.getAccess(workspaceId);
  if (!next) throw new HcError(500, "internal_error", "Access state write failed", undefined, true);
  return next;
}

// --- Inspect ----------------------------------------------------------------

export interface WorkspaceControlState {
  workspaceId: string;
  accessMode: "active" | "locked";
  accessExpiresAt: string | null;
  ownerUserId: string | null;
  version: number;
}

export async function getWorkspaceControlState(store: HostingStore, workspaceId: string): Promise<WorkspaceControlState | null> {
  if (!(await store.workspaceExists(workspaceId))) return null;
  const owner = await store.ownerOf(workspaceId);
  const access = await store.getAccess(workspaceId);
  return {
    workspaceId,
    accessMode: access?.accessMode ?? "active",
    accessExpiresAt: access?.accessExpiresAt ?? null,
    ownerUserId: owner?.id ?? null,
    version: access?.version ?? 0,
  };
}

// --- Owner transfer ---------------------------------------------------------

export interface TransferOwnerInput {
  /** Exactly one of targetUserId / targetEmail identifies the target. */
  targetUserId?: string;
  targetEmail?: string;
  /** Optional control-state version guard (the version GET /workspaces/:id returns). */
  expectedVersion?: number | null;
  reason: string;
}

export interface TransferOwnerResult {
  workspaceId: string;
  ownerUserId: string;
  previousOwnerUserId: string | null;
  version: number;
  /** false when the target already was the owner (semantic no-op repeat). */
  changed: boolean;
}

/**
 * Bounded hosting-superuser owner transfer (contract §Transfer ownership):
 * the target must already be an ACTIVE user of this workspace — never a new
 * user, never a cross-workspace move, never an email acting as authority (an
 * email here only *resolves* to an existing member). One transaction demotes
 * the previous owner to admin, promotes the target, preserves exactly one
 * owner, bumps the control-state version, and records both audits.
 */
export async function transferWorkspaceOwner(
  store: HostingStore,
  workspaceId: string,
  input: TransferOwnerInput,
): Promise<TransferOwnerResult> {
  if (!(await store.lockWorkspace(workspaceId))) throw new HcError(404, "not_found", "Unknown workspace");

  const access = await store.getAccess(workspaceId);
  const currentVersion = access?.version ?? 0;
  if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
    throw new HcError(409, "version_conflict", `Control state version conflict; current version is ${currentVersion}`, {
      currentVersion,
    });
  }

  // Resolve the target inside this workspace only. Absent, foreign-workspace,
  // pending, and disabled targets all answer the same stable conflict so the
  // response can never leak another workspace's membership.
  const target = await store.findMember(
    workspaceId,
    input.targetUserId ? { userId: input.targetUserId } : { email: input.targetEmail ?? "" },
  );
  if (!target || userAuthState(target) !== "active") {
    throw new HcError(409, "target_not_eligible", "Target must be an existing active user of this workspace");
  }

  const owner = await store.ownerOf(workspaceId);

  // Repeating a completed transfer to the same target succeeds (no-op).
  if (owner?.id === target.id) {
    return { workspaceId, ownerUserId: target.id, previousOwnerUserId: null, version: currentVersion, changed: false };
  }

  // Atomic swap: demote every current owner, promote the target — exactly one
  // owner holds after commit even from a corrupt multi-owner state.
  await store.swapOwner(workspaceId, target.id);

  // The transfer is a control-state change (ownerUserId is part of the
  // inspect response), so it advances the same version `expectedVersion`
  // guards. Workspaces without a control row (never hosted) stay at 0.
  let version = currentVersion;
  if (access) {
    await store.updateAccess(workspaceId, access.accessMode, access.accessExpiresAt);
    version = currentVersion + 1;
  }

  await store.workspaceAuditEvent(workspaceId, "hosting.workspace.owner_transfer", "Workspace ownership transferred by hosting control", {
    previousOwnerUserId: owner?.id ?? null,
    newOwnerUserId: target.id,
    reason: input.reason,
  });

  return { workspaceId, ownerUserId: target.id, previousOwnerUserId: owner?.id ?? null, version, changed: true };
}

// --- Owner recovery ---------------------------------------------------------

export interface OwnerRecoveryInitiation {
  workspaceId: string;
  ownerUserId: string;
  setup: SetupInitiation;
}

/**
 * Initiate credential recovery for the CURRENT owner (contract §Initiate
 * owner recovery): issue a single-use code and route it through the delivery
 * seam. A still-pending owner gets a fresh "setup" code, an active owner a
 * "reset" code. The response layer never returns credentials in hosted mode;
 * a disabled or absent owner is a stable conflict — recovery never picks a
 * different person (that is what owner transfer is for).
 */
export async function initiateOwnerRecovery(
  store: HostingStore,
  workspaceId: string,
  reason: string,
): Promise<OwnerRecoveryInitiation> {
  if (!(await store.lockWorkspace(workspaceId))) throw new HcError(404, "not_found", "Unknown workspace");

  const owner = await store.ownerOf(workspaceId);
  const state = owner ? userAuthState(owner) : null;
  if (!owner || state === "disabled") {
    throw new HcError(409, "owner_not_available", "The current owner cannot receive recovery for this workspace");
  }

  const purpose: AuthCodePurpose = state === "pending" ? "setup" : "reset";
  const setup = await initiateCodeDelivery(store, workspaceId, owner.id, owner.email, purpose);

  await store.workspaceAuditEvent(
    workspaceId,
    "hosting.workspace.owner_recovery",
    `Owner credential recovery initiated by hosting control (${purpose})`,
    { ownerUserId: owner.id, purpose, delivery: setup.delivery, reason },
  );

  return { workspaceId, ownerUserId: owner.id, setup };
}

// --- Permanent delete -------------------------------------------------------

/**
 * Physically removes every row belonging to the workspace (the adapter's
 * deleteWorkspace: CRM rows, users whose only membership it was, their
 * sessions), its access state and queued deliveries; the service audit keeps
 * only one-way hashes.
 *
 * Deleting an absent workspace is a successful no-op (idempotent retry).
 */
export async function deleteWorkspacePermanently(store: HostingStore, workspaceId: string): Promise<{ existed: boolean }> {
  if (!(await store.deleteWorkspace(workspaceId))) return { existed: false };
  await store.deleteAccess(workspaceId);
  await store.deleteOutbox(workspaceId);
  await store.redactAudit(workspaceId);
  return { existed: true };
}
