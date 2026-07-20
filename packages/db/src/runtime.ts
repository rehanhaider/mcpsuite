/**
 * One-stop wiring for adapters (web server functions, MCP transports):
 * database + catalog + per-request ports.
 *
 * Adapter selection (docs/issues/0023): one database adapter per process,
 * chosen once at startup from DATABASE_URL and invisible to users —
 *
 *   unset          -> SQLite at DB_PATH (default ./data/emcp.db), including
 *                     the existing first-run bootstrap: byte-identical to the
 *                     historical sync `getRuntime()` behavior. (Moving
 *                     bootstrap out of startup is issue 0029 #5, out of
 *                     scope here.)
 *   file:<path>    -> SQLite at exactly that path (same bootstrap semantics;
 *                     `resolveDbPath` honors it for the sync entry too).
 *   postgresql://  -> the hosted PostgreSQL adapter (postgres:// works too).
 *                     NO bootstrap: hosted workspaces are provisioned
 *                     exclusively through the hosting-control API, never on
 *                     process boot. Startup verifies the connection so a bad
 *                     URL fails fast with a clear error instead of surfacing
 *                     on the first request (node-postgres pools connect
 *                     lazily).
 *   anything else  -> clear startup error.
 *
 * Entry points call `getRuntimeAsync()`; the sync `getRuntime()` stays for
 * the SQLite-only scripts (setup/import/smoke) and always answers SQLite.
 */
import {
  buildCatalog,
  runOperation,
  type Catalog,
  type OpResult,
  type Ports,
  type RequestContext,
} from "@emcp/core";
import { getDb, openDatabase, resolveDbPath, type Db } from "./connection.ts";
import { createPorts } from "./repositories.ts";
import { bootstrap, type BootstrapResult } from "./bootstrap.ts";
import { authServices, csvServices } from "./services.ts";
import { passwordChangeRequiredResult, userMustChangePassword } from "./auth.ts";

/**
 * The narrow adapter-independent surface: what every caller may rely on no
 * matter which adapter answered. Anything beyond it (raw db handle,
 * bootstrap result) requires narrowing on `adapter`.
 */
export interface RuntimeCore {
  adapter: "sqlite" | "postgres";
  catalog: Catalog;
  portsFor(workspaceId: string): Ports;
  run(ctx: RequestContext, operation: string, input: unknown): Promise<OpResult>;
}

/**
 * The SQLite runtime. Extras over RuntimeCore: the raw handle (the
 * credential/session/hosted-access helpers in auth.ts and hosting-access.ts
 * are SQLite-typed) and the first-run bootstrap result.
 */
export interface Runtime extends RuntimeCore {
  adapter: "sqlite";
  db: Db;
  bootstrapResult: BootstrapResult;
}

/**
 * The hosted (PostgreSQL) runtime as callers see it: RuntimeCore plus pool
 * shutdown. Deliberately narrow — no driver handle and no pg types leak
 * here; identity resolution against Postgres is the hosting layer's concern.
 */
export interface HostedRuntime extends RuntimeCore {
  adapter: "postgres";
  close(): Promise<void>;
}

export type AnyRuntime = Runtime | HostedRuntime;

let singleton: Runtime | null = null;
let processRuntime: Promise<AnyRuntime> | null = null;

export function createRuntime(db: Db = getDb()): Runtime {
  const catalog = buildCatalog({ auth: authServices, csv: csvServices });
  const bootstrapResult = bootstrap(db);
  if (bootstrapResult.ownerSetupCode) {
    // Shown once, on the very first boot against an empty database. This is a
    // one-time SETUP CODE — bootstrap never creates or prints a password
    // (docs/issues/0022; regenerate with `pnpm --filter @emcp/db reset-owner`).
    const base = process.env.EMCP_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:2222";
    console.log(
      `\n[emcp] First run: created a pending owner account — email: ${bootstrapResult.ownerEmail}\n` +
        `[emcp] Set the owner password at ${base}/set-password\n` +
        `[emcp] One-time setup code: ${bootstrapResult.ownerSetupCode}\n`,
    );
  }
  return {
    adapter: "sqlite",
    db,
    catalog,
    bootstrapResult,
    portsFor: (workspaceId: string) => createPorts(db, workspaceId),
    async run(ctx, operation, input) {
      // Forced password change (docs/issues/0022 addendum): while set, the op
      // layer refuses every catalog operation — for the user's own sessions
      // AND for agents acting on their behalf — with a stable typed error.
      // Password change, logout and whoami are not catalog operations, so
      // they stay reachable. Mirrors the workspace_locked gate pattern.
      if (ctx.userId && userMustChangePassword(db, ctx.userId)) {
        return passwordChangeRequiredResult();
      }
      return runOperation(catalog, this.portsFor(ctx.workspaceId), ctx, operation, input);
    },
  };
}

/**
 * Process-wide SQLite runtime (scripts and the SQLite adapter path hold one).
 * Ignores a postgresql:// DATABASE_URL by design — the SQLite-only scripts
 * must stay on the SQLite file; adapter selection happens in
 * `getRuntimeAsync`.
 */
export function getRuntime(): Runtime {
  if (!singleton) singleton = createRuntime();
  return singleton;
}

/**
 * Process-wide runtime with DATABASE_URL adapter selection — the single
 * entry every server surface (web server functions, /api routes, MCP
 * transports) awaits. The selection promise is a cached singleton; a failed
 * startup clears it so the failure is not permanently poisoned (each retry
 * re-attempts cleanly).
 */
export function getRuntimeAsync(): Promise<AnyRuntime> {
  if (!processRuntime) {
    processRuntime = acquireProcessRuntime().catch((error) => {
      processRuntime = null;
      throw error;
    });
  }
  return processRuntime;
}

async function acquireProcessRuntime(): Promise<AnyRuntime> {
  const url = process.env.DATABASE_URL?.trim();
  if (url && isPostgresUrl(url)) return createHostedRuntime(url, pgStartupTimeoutMs(process.env));
  if (url && !isSqliteFileUrl(url)) throw unsupportedDatabaseUrl(url);
  // SQLite family (unset or file:) shares the sync singleton — resolveDbPath
  // already honors file:, so sync scripts and async entry points agree on
  // one connection, one bootstrap.
  return getRuntime();
}

/**
 * Non-singleton adapter selection from an explicit environment (tests,
 * embedders). Same rules as `getRuntimeAsync`, but every call constructs a
 * fresh runtime.
 */
export async function createRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<AnyRuntime> {
  const url = env.DATABASE_URL?.trim();
  if (url && isPostgresUrl(url)) return createHostedRuntime(url, pgStartupTimeoutMs(env));
  if (url && !isSqliteFileUrl(url)) throw unsupportedDatabaseUrl(url);
  return createRuntime(openDatabase(resolveDbPath(env)));
}

// ---------------------------------------------------------------------------
// PostgreSQL adapter wiring
// ---------------------------------------------------------------------------

const PG_STARTUP_PING_TIMEOUT_MS = 10_000;

/** Startup ping budget; override with EMCP_PG_STARTUP_TIMEOUT_MS. */
function pgStartupTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.EMCP_PG_STARTUP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PG_STARTUP_PING_TIMEOUT_MS;
}

async function createHostedRuntime(databaseUrl: string, pingTimeoutMs: number): Promise<HostedRuntime> {
  // Lazy import: the SQLite default never loads the pg adapter's modules.
  const { createPgRuntime } = await import("./pg/runtime.ts");
  const pg = await createPgRuntime({ databaseUrl });
  try {
    // Fail fast at startup: node-postgres pools connect lazily, so without
    // this ping an unreachable server would only surface on the first
    // request. Deliberately NO bootstrap — hosted provisioning owns creation.
    await withTimeout(pg.handle.pool.query("select 1"), pingTimeoutMs, "PostgreSQL startup check");
  } catch (cause) {
    // Bounded cleanup: pool.end() can itself block behind a connect attempt
    // that neither completes nor refuses (e.g. blackholed routes); never let
    // that delay the clear startup error.
    await Promise.race([pg.close().catch(() => {}), delay(1_000)]);
    throw new Error(
      `Cannot reach PostgreSQL for DATABASE_URL (${redactDatabaseUrl(databaseUrl)}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
  return {
    adapter: "postgres",
    catalog: pg.catalog,
    portsFor: pg.portsFor,
    run: pg.run,
    close: () => pg.close(),
  };
}

function isPostgresUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("postgresql://") || lower.startsWith("postgres://");
}

function isSqliteFileUrl(url: string): boolean {
  return url.toLowerCase().startsWith("file:");
}

function unsupportedDatabaseUrl(url: string): Error {
  return new Error(
    `Unsupported DATABASE_URL "${redactDatabaseUrl(url)}": expected postgresql:// (or postgres://) for the ` +
      "PostgreSQL adapter, file:<path> for SQLite, or unset for the default SQLite database.",
  );
}

/** Mask the password portion of a connection URL for error messages. */
function redactDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^/@:]+):[^@/]*@/, "://$1:***@");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}
