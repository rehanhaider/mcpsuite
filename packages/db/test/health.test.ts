import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/connection.ts";
import { checkDatabaseHealth, createRuntime, createRuntimeFromEnv } from "../src/runtime.ts";

let db: Db | undefined;
let dir: string | undefined;

afterEach(() => {
  if (db?.$client.open) db.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  db = undefined;
  dir = undefined;
});

describe("database health", () => {
  it("reads a SQLite CRM table without returning row data and detects a closed handle", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcpsuite-health-"));
    db = openDatabase(join(dir, "health.db"));
    const runtime = createRuntime(db);
    const getRuntime = async () => runtime;

    await expect(runtime.ping()).resolves.toBeUndefined();
    await expect(checkDatabaseHealth(getRuntime)).resolves.toBe(true);

    db.$client.close();
    await expect(runtime.ping()).rejects.toThrow();
    await expect(checkDatabaseHealth(getRuntime)).resolves.toBe(false);
  });

  it("returns false when runtime acquisition rejects", async () => {
    await expect(checkDatabaseHealth(async () => {
      throw new Error("runtime unavailable");
    })).resolves.toBe(false);
  });

  it("returns false when PostgreSQL is unreachable", async () => {
    await expect(checkDatabaseHealth(() => createRuntimeFromEnv({
      DATABASE_URL: "postgresql://crm_app:pw@127.0.0.1:1/mcpsuite",
      MCPSUITE_PG_STARTUP_TIMEOUT_MS: "1500",
    }))).resolves.toBe(false);
  }, 15_000);
});
