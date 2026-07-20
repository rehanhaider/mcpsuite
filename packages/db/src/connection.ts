import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema-sql.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

let singleton: Db | null = null;

/**
 * Resolve the SQLite path. Defaults to <cwd>/data/emcp.db; override with
 * DB_PATH. A `file:` DATABASE_URL (adapter selection, docs/issues/0023) wins
 * over both, so the async runtime and the SQLite-only scripts agree on one
 * file. With DATABASE_URL unset the resolution is unchanged.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url && url.toLowerCase().startsWith("file:")) return resolve(sqlitePathFromFileUrl(url));
  return resolve(env.DB_PATH ?? "./data/emcp.db");
}

/** Accepts file:./relative, file:/absolute and file:///absolute forms. */
function sqlitePathFromFileUrl(url: string): string {
  const rest = url.slice("file:".length);
  if (!rest) throw new Error(`DATABASE_URL "${url}" is missing a SQLite file path after "file:"`);
  return rest.startsWith("//") ? fileURLToPath(url) : rest;
}

export function openDatabase(path: string): Db {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  initSchema(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

/** Process-wide singleton (web SSR process / MCP process each get one). */
export function getDb(): Db {
  if (!singleton) singleton = openDatabase(resolveDbPath());
  return singleton;
}

export function closeDb(): void {
  if (singleton) {
    singleton.$client.close();
    singleton = null;
  }
}

/**
 * Create the full schema when the database is empty (no `workspaces` table),
 * stamping `PRAGMA user_version = SCHEMA_VERSION`. A non-empty database is
 * left completely untouched — no upgrade steps exist yet; they ship with the
 * first post-release schema change, keyed off the user_version stamp. The only
 * exception: a pre-stamp database (user_version 0) is stamped with version 1.
 * Legacy dev databases may still contain a `schema_migrations` table from the
 * retired migration runner — it is ignored entirely (never read nor dropped).
 */
export function initSchema(sqlite: Database.Database): void {
  const hasWorkspaces = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
    .get();
  if (!hasWorkspaces) {
    sqlite.transaction(() => sqlite.exec(SCHEMA_SQL))();
  }
  const stamped = Number(sqlite.pragma("user_version", { simple: true }));
  if (stamped === 0) sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
}
