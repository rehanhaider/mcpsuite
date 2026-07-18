export { createHostingControlServer, canonicalJson, type HostingControlOptions, type HostingControlServer } from "./server.ts";
export {
  deleteWorkspacePermanently,
  getWorkspaceControlState,
  provisionWorkspace,
  setWorkspaceAccess,
  type ProvisionInput,
  type ProvisionResult,
  type SetAccessInput,
  type WorkspaceControlState,
} from "./lifecycle.ts";
export {
  ensureHcTables,
  getAccess,
  getReceipt,
  type AccessState,
  type Receipt,
} from "./hc-store.ts";
// The CRM-side read contract for hc_workspace_access ("no row = active",
// locked when mode = 'locked' or expiry <= now, missing table = active).
// The implementation lives in @emcp/db so CRM surfaces can consult it without
// depending on this package; it is re-exported here as part of the hosting
// contract this package owns.
export { resolveWorkspaceAccess, type WorkspaceAccess } from "@emcp/db";
export { HcError } from "./errors.ts";
