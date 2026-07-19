/**
 * Apply schema migrations and first-run seeding, then print state.
 * Usage: pnpm db:migrate
 */
import { getDb, resolveDbPath } from "../connection.ts";
import { bootstrap } from "../bootstrap.ts";

const db = getDb();
const result = bootstrap(db);

console.log(`[emcp] database: ${resolveDbPath()}`);
console.log(`[emcp] workspace: ${result.workspaceId}${result.createdWorkspace ? " (created)" : ""}`);
console.log(`[emcp] owner user: ${result.ownerUserId}`);
if (result.createdOwner) {
  console.log(`[emcp] owner login — email: ${result.ownerEmail} (pending setup)`);
  if (result.ownerSetupCode) {
    // A one-time SETUP CODE, never a password (docs/issues/0022). Regenerate
    // with `pnpm --filter @emcp/db reset-owner` if lost.
    const base = process.env.EMCP_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:2222";
    console.log(`[emcp] set the owner password at ${base}/set-password`);
    console.log(`[emcp] one-time setup code: ${result.ownerSetupCode}`);
  }
}

const versions = db.$client.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
  version: number;
  name: string;
}>;
console.log(`[emcp] migrations applied: ${versions.map((v) => `${v.version}:${v.name}`).join(", ") || "none"}`);
