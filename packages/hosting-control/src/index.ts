export { createHostingControlServer, canonicalJson, type HostingControlOptions, type HostingControlServer } from "./server.ts";
export {
  deleteWorkspacePermanently,
  getWorkspaceControlState,
  initiateOwnerRecovery,
  provisionWorkspace,
  setWorkspaceAccess,
  transferWorkspaceOwner,
  userAuthState,
  type OwnerRecoveryInitiation,
  type ProvisionInput,
  type ProvisionResult,
  type SetAccessInput,
  type SetupInitiation,
  type TransferOwnerInput,
  type TransferOwnerResult,
  type WorkspaceControlState,
} from "./lifecycle.ts";
export { deliveryMode, retryPendingAuthDeliveries, type DeliveryMode } from "./auth-delivery.ts";
// The product-owned auth-code seams this package rides on (@emcp/db openauth):
// issue-at-send + hosted/display delivery, re-exported for hosting callers.
export { deliverAuthCode, issueAuthCodeSync, type AuthCodePurpose } from "@emcp/db";
export {
  ensureHcTables,
  getAccess,
  getReceipt,
  listPendingOutbox,
  type AccessState,
  type OutboxRow,
  type Receipt,
} from "./hc-store.ts";
// The CRM-side read contract for hc_workspace_access ("no row = active",
// locked when mode = 'locked' or expiry <= now, missing table = active).
// The implementation lives in @emcp/db so CRM surfaces can consult it without
// depending on this package; it is re-exported here as part of the hosting
// contract this package owns.
export { resolveWorkspaceAccess, type WorkspaceAccess } from "@emcp/db";
export { HcError } from "./errors.ts";
