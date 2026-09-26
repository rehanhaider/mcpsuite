/**
 * Shared setup and teardown for the PostgreSQL test suites. The suites run in
 * parallel against one server, and roles are cluster-global, so both helpers
 * absorb races between them.
 */
import type { PgHandle, PgPoolLike } from "../src/pg/repositories.ts";

/**
 * Set a runtime role's throwaway test password. Two sessions changing the
 * same role at the same moment make PostgreSQL refuse one of them with
 * "tuple concurrently updated"; every suite sets the same password, so the
 * refused one simply tries again.
 */
export async function setTestRolePassword(pool: PgPoolLike, role: string, password: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pool.query(`ALTER ROLE ${role} WITH PASSWORD '${password}'`);
      return;
    } catch (e) {
      if (attempt >= 20 || !/tuple concurrently updated/i.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
}

/**
 * Drop a test database once its pools have really disconnected.
 *
 * Closing a pool returns before the server has ended the pool's backends. A
 * `DROP DATABASE … WITH (FORCE)` issued straight after it terminates a
 * connection the client is still closing, and the driver surfaces that as an
 * uncaught "terminating connection due to administrator command" error that
 * fails the run. Waiting for pg_stat_activity to empty first avoids it; FORCE
 * stays as the fallback for anything genuinely left open.
 */
export async function dropTestDatabase(root: PgHandle, name: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await root.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name]);
    if (Number(res.rows[0]?.n ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await root.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
