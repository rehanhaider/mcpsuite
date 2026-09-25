/**
 * Request-scoped transaction control for one shared better-sqlite3 connection.
 *
 * Every request in a process shares ONE SQLite connection, so a statement
 * runs inside whatever transaction that connection has open — including
 * another request's. Two rules keep requests apart:
 *
 *   1. `txLock` (per connection) serializes every top-level unit of work:
 *      transactions AND plain reads/writes. While request A holds it, request
 *      B waits instead of executing inside A's BEGIN.
 *   2. Nesting is scoped to the request's async call chain through one
 *      AsyncLocalStorage per connection — not to an object (a nested call
 *      through a different object must join, not wait on the lock it already
 *      holds) and not to the connection (a counter shared by the connection
 *      would let request B join request A's open transaction).
 *
 * Callers inside a transaction must await only microtasks, never real I/O
 * (network, timers): the lock is held for the whole unit, so real I/O would
 * stall every other request. Anything that talks to the network runs after
 * commit.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

interface Scope {
  /** True once this call chain has issued BEGIN on the connection. */
  inTransaction: boolean;
}

const txLock = new WeakMap<object, Promise<void>>();
const scopes = new WeakMap<object, AsyncLocalStorage<Scope>>();

function scopeStore(sqlite: Database.Database): AsyncLocalStorage<Scope> {
  let store = scopes.get(sqlite);
  if (!store) {
    store = new AsyncLocalStorage<Scope>();
    scopes.set(sqlite, store);
  }
  return store;
}

/** Wait for the connection, run fn as its sole user, then hand it on. */
async function acquire<T>(sqlite: Database.Database, fn: () => Promise<T>): Promise<T> {
  const previous = txLock.get(sqlite) ?? Promise.resolve();
  let release!: () => void;
  txLock.set(
    sqlite,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Whether the current async call chain already holds this connection. */
export function holdsConnection(sqlite: Database.Database): boolean {
  return scopeStore(sqlite).getStore() !== undefined;
}

/**
 * Run fn with the connection to itself but without opening a transaction
 * (each statement autocommits). Joins the caller's scope when it already
 * holds the connection.
 */
export function withConnection<T>(sqlite: Database.Database, fn: () => Promise<T> | T): Promise<T> {
  const store = scopeStore(sqlite);
  if (store.getStore()) return Promise.resolve().then(fn);
  return acquire(sqlite, () => store.run({ inTransaction: false }, async () => fn()));
}

/**
 * Run fn atomically: it commits only after fn fully resolves and rolls back
 * when it rejects. A nested call from the same call chain joins the open
 * transaction; a chain that holds the connection without a transaction
 * (withConnection) opens one here.
 */
export function withTransaction<T>(sqlite: Database.Database, fn: () => Promise<T>): Promise<T> {
  const store = scopeStore(sqlite);
  const current = store.getStore();
  if (current?.inTransaction) return fn();
  const body = async (): Promise<T> => {
    sqlite.exec("BEGIN");
    try {
      const result = await fn();
      sqlite.exec("COMMIT");
      return result;
    } catch (e) {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
      throw e;
    }
  };
  if (current) {
    current.inTransaction = true;
    return body().finally(() => {
      current.inTransaction = false;
    });
  }
  return acquire(sqlite, () => store.run({ inTransaction: true }, body));
}
