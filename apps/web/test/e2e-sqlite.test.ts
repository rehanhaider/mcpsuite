/**
 * Issue #4 step 8 on SQLite: the sign-in-to-MCP flow (./e2e-flow.ts) against
 * a real SQLite file in a temp directory (never data/). The workspace comes
 * from first-boot setup, so this is the PENDING-owner path: first-time setup.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

// The runtime opens DB_PATH lazily on first use — point it at a temp file,
// and keep adapter selection on SQLite, before any handler runs.
const dir = mkdtempSync(join(tmpdir(), "mcpsuite-web-e2e-"));
process.env.DB_PATH = join(dir, "e2e.db");
delete process.env.DATABASE_URL;

import { closeDb, getRuntime } from "@mcpsuite/db";
import { runSignInToMcpFlow } from "./e2e-flow.ts";

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("sign-in to MCP, end to end — SQLite", () => {
  it("setup code → sign in → /api/me → /api/ops → API key → MCP tool", async () => {
    const { bootstrapResult } = getRuntime();
    await runSignInToMcpFlow({
      email: bootstrapResult.ownerEmail,
      setupCode: bootstrapResult.ownerSetupCode!,
      workspaceId: bootstrapResult.workspaceId,
    });
  });
});
