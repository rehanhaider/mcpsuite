/**
 * Owner recovery (docs/issues/0022): print a fresh one-time code for the
 * workspace owner — a SETUP code while the owner is still pending, a RESET
 * code once active (which also ends every owner session). Server-side access
 * only; the code is shown exactly once and only its hash is stored.
 *
 * Usage: pnpm --filter @emcp/db reset-owner
 */
import { eq } from "drizzle-orm";
import { getDb, resolveDbPath } from "../connection.ts";
import * as t from "../schema.ts";
import { issueAuthCodeSync } from "../openauth.ts";

const db = getDb();

const ownerMembership = db.select().from(t.memberships).where(eq(t.memberships.role, "owner")).get();
if (!ownerMembership) {
  console.error(`[emcp] no owner found in ${resolveDbPath()} — run \`pnpm db:setup\` first`);
  process.exit(1);
}
const owner = db.select().from(t.users).where(eq(t.users.id, ownerMembership.userId)).get();
if (!owner) {
  console.error(`[emcp] owner user ${ownerMembership.userId} is missing from the users table`);
  process.exit(1);
}

const purpose = owner.status === "pending" ? "setup" : "reset";
const { code, expiresAt } = issueAuthCodeSync(db, { userId: owner.id, purpose });
const base = process.env.EMCP_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:2222";
const page = purpose === "setup" ? "/set-password" : "/reset-password";

console.log(`[emcp] owner: ${owner.email} (${owner.status})`);
if (purpose === "reset") console.log(`[emcp] all owner sessions have been ended.`);
console.log(`[emcp] choose a new password at ${base}${page}`);
console.log(`[emcp] one-time ${purpose} code (expires ${expiresAt}): ${code}`);
