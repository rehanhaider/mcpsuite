/**
 * The request's ambient PostgreSQL transaction, shared by the business ports
 * (./repositories.ts) and the identity store (./identity.ts).
 *
 * One AsyncLocalStorage per database handle holds the transaction the current
 * async call chain opened. A nested call — through another Ports object or
 * through the identity store — joins it instead of opening a second
 * transaction on another pooled connection, so the whole request commits or
 * rolls back together. Other requests never see it: the store is scoped to
 * the call chain, not to the handle.
 *
 * Workspace context: the transaction installs `app.workspace_id` (the
 * transaction-local GUC every RLS policy reads) the first time something in it
 * needs a workspace. Identity flows start before the workspace is known — a
 * login discovers it — so a transaction may begin without one and bind it
 * later. Once bound it can never change: a request cannot act on two
 * workspaces in one transaction.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { PgDb } from "./repositories.ts";

interface Ambient {
  x: PgDb;
  workspaceId: string | null;
}

const stores = new WeakMap<object, AsyncLocalStorage<Ambient>>();

function storeFor(db: PgDb): AsyncLocalStorage<Ambient> {
  let store = stores.get(db);
  if (!store) {
    store = new AsyncLocalStorage<Ambient>();
    stores.set(db, store);
  }
  return store;
}

async function bindWorkspace(ambient: Ambient, workspaceId: string): Promise<void> {
  if (ambient.workspaceId === workspaceId) return;
  if (ambient.workspaceId !== null) {
    throw new Error("A transaction is bound to one workspace and cannot switch to another");
  }
  await ambient.x.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
  ambient.workspaceId = workspaceId;
}

/**
 * Run fn in the call chain's transaction, opening one when there is none.
 * With a workspaceId, the transaction is bound to that workspace before fn
 * runs (joining a transaction bound to a different workspace throws).
 */
export function inPgTransaction<T>(db: PgDb, workspaceId: string | null, fn: (x: PgDb) => Promise<T>): Promise<T> {
  const store = storeFor(db);
  const ambient = store.getStore();
  if (ambient) {
    return (async () => {
      if (workspaceId !== null) await bindWorkspace(ambient, workspaceId);
      return fn(ambient.x);
    })();
  }
  return db.transaction(async (txx) => {
    const opened: Ambient = { x: txx as unknown as PgDb, workspaceId: null };
    if (workspaceId !== null) await bindWorkspace(opened, workspaceId);
    return store.run(opened, () => fn(opened.x));
  });
}

/**
 * Bind the call chain's open transaction to a workspace discovered part-way
 * through (after a code or key resolved it). Throws outside a transaction.
 */
export async function bindAmbientWorkspace(db: PgDb, workspaceId: string): Promise<void> {
  const ambient = storeFor(db).getStore();
  if (!ambient) throw new Error("bindAmbientWorkspace needs an open transaction");
  await bindWorkspace(ambient, workspaceId);
}
