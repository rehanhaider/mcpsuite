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
if (result.ownerOneTimePassword) {
  console.log(`[emcp] owner login — email: ${process.env.EMCP_OWNER_EMAIL ?? "owner@emcp.local"}`);
  console.log(`[emcp] owner one-time password: ${result.ownerOneTimePassword}`);
  console.log(`[emcp] change it after first login (Admin → Users → Reset password).`);
}

const versions = db.$client.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
  version: number;
  name: string;
}>;
console.log(`[emcp] migrations applied: ${versions.map((v) => `${v.version}:${v.name}`).join(", ") || "none"}`);
