/**
 * The CRM side of the hosted access read contract
 * (packages/hosting-control/README.md, "The read contract").
 *
 * `hc_workspace_access` is owned and created by @emcp/hosting-control; the
 * CRM only ever READS it, here:
 *
 *   - table missing (self-host: hosting control never ran)   -> active
 *   - no row for the workspace                                -> active
 *   - access_mode = 'locked'                                  -> locked
 *   - access_mode = 'active' with access_expires_at <= now    -> locked
 *     (expiry-at-read-time: an active workspace locks itself the moment its
 *     expiry passes, without another hosting request)
 *
 * ISO-8601 UTC timestamps compare lexicographically, so expiry is a plain
 * string comparison. The CRM knows nothing beyond this generic state — no
 * plans, trials, or billing concepts.
 *
 * @emcp/hosting-control re-exports `resolveWorkspaceAccess`; the
 * implementation lives here so every CRM surface (web server functions,
 * /api routes, MCP transports) can consult it through their existing
 * @emcp/db dependency.
 */
import { nowIso, type OpResult } from "@emcp/core";
import type { Db } from "./connection.ts";

export interface WorkspaceAccess {
  mode: "active" | "locked";
  expiresAt: string | null;
}

/**
 * Clients whose database is known to contain hc_workspace_access. Hosting
 * control creates the table once and never drops it, so a positive probe can
 * be cached per connection; a negative probe re-checks every time (hosting
 * control may start later against the same file).
 */
const clientsWithAccessTable = new WeakSet<object>();

function hasAccessTable(db: Db): boolean {
  if (clientsWithAccessTable.has(db.$client)) return true;
  const row = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hc_workspace_access'")
    .get();
  if (!row) return false;
  clientsWithAccessTable.add(db.$client);
  return true;
}

/** Resolve the generic hosted access state for one workspace, at read time. */
export function resolveWorkspaceAccess(db: Db, workspaceId: string, now: string = nowIso()): WorkspaceAccess {
  if (!hasAccessTable(db)) return { mode: "active", expiresAt: null };
  const row = db.$client
    .prepare("SELECT access_mode, access_expires_at FROM hc_workspace_access WHERE workspace_id = ?")
    .get(workspaceId) as { access_mode: string; access_expires_at: string | null } | undefined;
  if (!row) return { mode: "active", expiresAt: null };
  const expiresAt = row.access_expires_at ?? null;
  const locked = row.access_mode === "locked" || (expiresAt !== null && expiresAt <= now);
  return { mode: locked ? "locked" : "active", expiresAt };
}

export const WORKSPACE_LOCKED_MESSAGE =
  "This workspace is locked by its hosting provider. CRM data and operations are unavailable until access is restored.";

/** The catalog error envelope every surface returns for a locked workspace. */
export function workspaceLockedResult(): OpResult {
  return { status: "error", error: { code: "workspace_locked", message: WORKSPACE_LOCKED_MESSAGE } };
}
