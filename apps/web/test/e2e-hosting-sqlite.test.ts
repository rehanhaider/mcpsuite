/**
 * Issue #5 step 8 on SQLite: the hosted workspace lifecycle
 * (./e2e-hosting-flow.ts) against one real SQLite file in a temp directory
 * (never data/), shared by the web runtime and the hosting control process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

// The runtime opens DB_PATH lazily on first use — point it at a temp file,
// and keep adapter selection on SQLite, before any handler runs.
const dir = mkdtempSync(join(tmpdir(), "mcpsuite-web-e2e-hosting-"));
const dbPath = join(dir, "e2e-hosting.db");
process.env.DB_PATH = dbPath;
delete process.env.DATABASE_URL;

import { closeDb, getDb } from "@mcpsuite/db";
import { runHostingLifecycleFlow } from "./e2e-hosting-flow.ts";

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const count = (sql: string, value: string): number => (getDb().$client.prepare(sql).get(value) as { c: number }).c;

describe("hosted workspace lifecycle, end to end — SQLite", () => {
  it("provision → setup code → sign in → lock refused → unlock → transfer → delete", async () => {
    await runHostingLifecycleFlow({
      adapter: "sqlite",
      hostingEnv: { DB_PATH: dbPath },
      workspaceRows: async (workspaceId) => count("SELECT COUNT(*) AS c FROM workspaces WHERE id = ?", workspaceId),
      serviceAuditRows: async (by) =>
        "workspaceId" in by
          ? count("SELECT COUNT(*) AS c FROM hc_service_audit WHERE workspace_id = ?", by.workspaceId)
          : count("SELECT COUNT(*) AS c FROM hc_service_audit WHERE target_hash = ?", by.targetHash),
    });
  }, 120_000);
});
