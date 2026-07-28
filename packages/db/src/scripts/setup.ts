/**
 * Create the database schema when absent, then print state. Adapter-aware: a
 * postgresql:// DATABASE_URL initializes the hosted `crm` schema (no
 * bootstrap — hosted workspaces are provisioned only through
 * hosting-control); otherwise the SQLite path also runs first-run seeding.
 * Idempotent: an already-initialized database is left untouched (in-place
 * upgrade steps ship with the first post-release schema change).
 * Usage: pnpm db:setup
 */
const url = process.env.DATABASE_URL?.trim().toLowerCase();

if (url?.startsWith("postgresql://") || url?.startsWith("postgres://")) {
  const { connectPg } = await import("../pg/repositories.ts");
  const { initPgSchema } = await import("../pg/init.ts");
  const handle = await connectPg({ databaseUrl: process.env.DATABASE_URL!.trim() });
  try {
    const { created } = await initPgSchema(handle.pool);
    console.log(`[mcpsuite] database: postgres (crm schema)`);
    console.log(`[mcpsuite] schema: ${created ? "created (version 1)" : "already present"}`);
  } finally {
    await handle.close();
  }
} else {
  const { getDb, resolveDbPath } = await import("../connection.ts");
  const { bootstrap } = await import("../bootstrap.ts");

  const db = getDb();
  const result = bootstrap(db);

  console.log(`[mcpsuite] database: ${resolveDbPath()}`);
  console.log(`[mcpsuite] workspace: ${result.workspaceId}${result.createdWorkspace ? " (created)" : ""}`);
  console.log(`[mcpsuite] owner user: ${result.ownerUserId}`);
  if (result.createdOwner) {
    console.log(`[mcpsuite] owner login — email: ${result.ownerEmail} (pending setup)`);
    if (result.ownerSetupCode) {
      // A one-time SETUP CODE, never a password (docs/issues/0022). Regenerate
      // with `pnpm --filter @mcpsuite/db reset-owner` if lost.
      const base = process.env.MCPSUITE_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:2222";
      console.log(`[mcpsuite] set the owner password at ${base}/set-password`);
      console.log(`[mcpsuite] one-time setup code: ${result.ownerSetupCode}`);
    }
  }

  const version = Number(db.$client.pragma("user_version", { simple: true }));
  console.log(`[mcpsuite] schema version: ${version}`);
}
