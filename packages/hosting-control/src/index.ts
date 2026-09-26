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
// The data interface this package runs on, per database adapter
// (@mcpsuite/db hosting.ts). The CRM reads the access state it writes through
// the identity interface (`runtime.identity.workspaceAccess`).
export {
  createHostingStoreFromEnv,
  createSqliteHostingStore,
  deliverAuthCode,
  type AccessState,
  type AuthCodePurpose,
  type HostingStore,
  type OutboxRow,
  type Receipt,
} from "@mcpsuite/db";
export { HcError } from "./errors.ts";
