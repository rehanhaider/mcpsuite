/**
 * Schema initialization (src/connection.ts + src/schema-sql.ts): an empty
 * database gets the full schema and the user_version stamp; a non-empty
 * database is never modified (legacy schema_migrations tables from the
 * retired migration runner included) beyond retro-stamping user_version.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "../src/schema-sql.ts";
import { openDatabase } from "../src/connection.ts";

const tmp = mkdtempSync(join(tmpdir(), "emcp-schema-init-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Full name+sql snapshot of every object, for exact before/after comparison. */
function schemaSnapshot(sqlite: Database.Database): Array<{ name: string; sql: string | null }> {
  return sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string | null }>;
}

describe("initSchema", () => {
  it("creates the full schema on an empty database and stamps user_version", () => {
    const database = openDatabase(join(tmp, `fresh-${Date.now()}.db`));
    const sqlite = database.$client;

    expect(Number(sqlite.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
    // No migration bookkeeping table on fresh databases.
    expect(
      sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
    ).toBeUndefined();

    // Every table exists with its expected shape (spot-check the end-state
    // columns the retired v1–v6 migrations converged on).
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(
      [
        "workspaces",
        "users",
        "memberships",
        "sessions",
        "mcp_clients",
        "openauth_kv",
        "auth_codes",
        "workspace_counters",
        "companies",
        "people",
        "company_people",
        "pipelines",
        "stages",
        "engagements",
        "deals",
        "deal_stakeholders",
        "offerings",
        "offering_links",
        "activities",
        "tags",
        "taggings",
        "lists",
        "list_members",
        "custom_field_definitions",
        "custom_field_values",
        "saved_views",
        "pending_actions",
        "audit_events",
      ].sort(),
    );
    sqlite.prepare("SELECT key, value, expiry FROM openauth_kv").all();
    sqlite.prepare("SELECT id, user_id, email, purpose, code_hash, attempts, expires_at, used_at FROM auth_codes").all();
    sqlite.prepare("SELECT status, auth_subject, password_must_change FROM users").all();
    sqlite.prepare("SELECT user_id, email, auth_subject, auth_refresh FROM sessions").all();
    sqlite.prepare("SELECT entity_type FROM lists").all();

    // Parity constraints: one membership per user, one owner per workspace.
    sqlite
      .prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1','a@x.test','A','t','t'), ('u2','b@x.test','B','t','t')")
      .run();
    sqlite.prepare("INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m1','w1','u1','owner','t')").run();
    expect(() =>
      sqlite.prepare("INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m2','w2','u1','member','t')").run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      sqlite.prepare("INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m3','w1','u2','owner','t')").run(),
    ).toThrow(/UNIQUE/);
    sqlite.prepare("INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m4','w1','u2','admin','t')").run();
    sqlite.close();
  });

  it("leaves a non-empty database untouched (legacy schema_migrations ignored), stamping only user_version", () => {
    const path = join(tmp, `existing-${Date.now()}.db`);
    // Simulate an old dev database: some real schema, a legacy
    // schema_migrations table with rows, and no user_version stamp yet.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE legacy_extra (id TEXT PRIMARY KEY, note TEXT);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'v1-initial-schema', 't');
      INSERT INTO workspaces VALUES ('w1', 'Existing');
    `);
    const before = schemaSnapshot(seed);
    seed.close();

    const database = openDatabase(path);
    const sqlite = database.$client;
    // Nothing added, dropped, or altered — including schema_migrations.
    expect(schemaSnapshot(sqlite)).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT name FROM workspaces WHERE id = 'w1'").get()).toEqual({ name: "Existing" });
    // The pre-stamp database is retro-stamped to version 1.
    expect(Number(sqlite.pragma("user_version", { simple: true }))).toBe(1);
    sqlite.close();
  });

  it("never rewrites an existing user_version stamp", () => {
    const path = join(tmp, `stamped-${Date.now()}.db`);
    const seed = new Database(path);
    seed.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    seed.pragma("user_version = 7");
    seed.close();

    const database = openDatabase(path);
    expect(Number(database.$client.pragma("user_version", { simple: true }))).toBe(7);
    database.$client.close();
  });
});
