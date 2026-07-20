/**
 * Applies the complete hand-written PostgreSQL schema (./schema.sql) to an
 * empty database: when `crm.workspaces` does not exist the whole file runs in
 * its own BEGIN/COMMIT (it is equally `psql -f`-runnable) and stamps
 * crm.schema_version = 1; when it exists this is a no-op. There is no
 * in-place upgrade machinery yet — it ships together with the first
 * post-release schema change, keyed off the crm.schema_version stamp.
 *
 * Run with a deployment credential (superuser or crm_migrator) — never a
 * runtime role.
 *
 * Driver-free: takes any pool satisfying PgPoolLike (see ./repositories.ts),
 * so this module can be imported while the `pg` package is not installed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PgPoolLike } from "./repositories.ts";

const SCHEMA_SQL_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Returns whether this call created the schema (false: already present). */
export async function initPgSchema(pool: PgPoolLike): Promise<{ created: boolean }> {
  const exists = await pool.query("SELECT to_regclass('crm.workspaces') AS reg");
  if (exists.rows[0]?.reg != null) return { created: false };
  await pool.query(readFileSync(SCHEMA_SQL_PATH, "utf8"));
  return { created: true };
}
