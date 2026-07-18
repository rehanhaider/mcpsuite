import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./migrations.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

let singleton: Db | null = null;

/** Resolve the SQLite path. Defaults to <cwd>/data/emcp.db; override with DB_PATH. */
export function resolveDbPath(): string {
  return resolve(process.env.DB_PATH ?? "./data/emcp.db");
}

export function openDatabase(path: string): Db {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  runMigrations(sqlite);
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

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (sqlite.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const insert = sqlite.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    const apply = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      insert.run(m.version, m.name, new Date().toISOString());
    });
    apply();
  }
}
