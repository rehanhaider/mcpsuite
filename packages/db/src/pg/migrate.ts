/**
 * Applies the hand-written PostgreSQL migrations in ./migrations/*.sql in
 * filename order, tracked in crm.schema_migrations. Run with a deployment
 * credential (superuser or crm_migrator) — never a runtime role.
 *
 * Driver-free: takes any pool satisfying PgPoolLike (see ./repositories.ts),
 * so this module can be imported while the `pg` package is not installed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPoolLike } from "./repositories.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export interface PgMigrationFile {
  version: number;
  name: string;
  path: string;
}

export function listPgMigrations(): PgMigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const version = Number.parseInt(f.split("_")[0] ?? "", 10);
      if (!Number.isInteger(version)) throw new Error(`Migration filename must start with a version number: ${f}`);
      return { version, name: f.replace(/\.sql$/, ""), path: join(MIGRATIONS_DIR, f) };
    });
}

/** Returns the versions applied by this call (already-applied files are skipped). */
export async function applyPgMigrations(pool: PgPoolLike): Promise<number[]> {
  const exists = await pool.query("SELECT to_regclass('crm.schema_migrations') AS reg");
  const applied = new Set<number>();
  if (exists.rows[0]?.reg != null) {
    const rows = await pool.query("SELECT version FROM crm.schema_migrations");
    for (const r of rows.rows) applied.add(Number(r.version));
  }
  const ran: number[] = [];
  for (const m of listPgMigrations()) {
    if (applied.has(m.version)) continue;
    // Each file wraps itself in BEGIN/COMMIT and records its own
    // schema_migrations row, so it works identically via psql -f.
    await pool.query(readFileSync(m.path, "utf8"));
    ran.push(m.version);
  }
  return ran;
}
