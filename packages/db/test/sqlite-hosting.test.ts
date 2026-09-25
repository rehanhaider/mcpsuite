/**
 * Permanent workspace deletion on SQLite removes the workspace-scoped CRM
 * tables from an explicit list (WORKSPACE_SCOPED_TABLES) rather than
 * discovering them at run time. This fails when the schema gains a table with
 * a workspace_id column that the list does not name, or the list names one
 * the schema no longer has.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/connection.ts";
import { WORKSPACE_SCOPED_TABLES } from "../src/sqlite-hosting.ts";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.$client.close();
});

describe("SQLite permanent deletion table list", () => {
  it("names exactly the CRM tables that carry a workspace_id column", () => {
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'hc_%'")
      .all() as Array<{ name: string }>;
    const scoped = tables
      .map((t) => t.name)
      .filter((name) =>
        (db.$client.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some(
          (c) => c.name === "workspace_id",
        ),
      );
    expect([...WORKSPACE_SCOPED_TABLES].sort()).toEqual(scoped.sort());
  });
});
