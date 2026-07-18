/**
 * DATABASE_URL adapter selection (docs/issues/0023): unset -> the SQLite
 * default (DB_PATH, bootstrap unchanged); file: -> SQLite at exactly that
 * path; postgresql:// (and the postgres:// alias) -> the Postgres adapter,
 * whose startup fails fast with a clear error when the server is
 * unreachable; anything else -> clear error. Everything runs against temp
 * files — never data/.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@emcp/core";
import { closeDb } from "../src/connection.ts";
import { createRuntimeFromEnv, getRuntime, getRuntimeAsync, type Runtime } from "../src/runtime.ts";

/** An ephemeral TCP listener that immediately drops every connection. */
function fakeDeadServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((socket) => socket.destroy());
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// The process-wide singletons open lazily on first use — point them at a
// temp file before any test can touch them (the caching test below relies
// on this, exactly like the entry points rely on DB_PATH).
const dir = mkdtempSync(join(tmpdir(), "emcp-runtime-select-"));
process.env.DB_PATH = join(dir, "singleton.db");
delete process.env.DATABASE_URL;

const openedDbs: Runtime[] = [];

afterAll(() => {
  for (const runtime of openedDbs) runtime.db.$client.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function ownerCtx(runtime: Runtime): RequestContext {
  return {
    workspaceId: runtime.bootstrapResult.workspaceId,
    actorType: "human",
    userId: runtime.bootstrapResult.ownerUserId,
    clientId: null,
    role: "owner",
    scopes: ["read", "write", "admin", "approvals"],
    trust: "fully_authorized_agent",
    surface: "web",
  };
}

function asSqlite(runtime: Awaited<ReturnType<typeof createRuntimeFromEnv>>): Runtime {
  expect(runtime.adapter).toBe("sqlite");
  if (runtime.adapter !== "sqlite") throw new Error("expected the SQLite adapter");
  openedDbs.push(runtime);
  return runtime;
}

describe("DATABASE_URL adapter selection", () => {
  it("unset -> SQLite default with the existing bootstrap behavior", async () => {
    const path = join(dir, "unset-default.db");
    const runtime = asSqlite(await createRuntimeFromEnv({ DB_PATH: path }));
    expect(existsSync(path)).toBe(true);
    // Bootstrap semantics unchanged: workspace + owner created on first open.
    expect(runtime.bootstrapResult.createdWorkspace).toBe(true);
    expect(runtime.bootstrapResult.workspaceId).toBeTruthy();
    expect(runtime.bootstrapResult.ownerUserId).toBeTruthy();
    // Catalog + ports are wired end to end.
    const result = await runtime.run(ownerCtx(runtime), "company.list", {});
    expect(result.status).toBe("ok");
  });

  it("file: -> SQLite at exactly that path, winning over DB_PATH", async () => {
    const chosen = join(dir, "explicit-file.db");
    const ignored = join(dir, "ignored-db-path.db");
    const runtime = asSqlite(await createRuntimeFromEnv({ DATABASE_URL: `file:${chosen}`, DB_PATH: ignored }));
    expect(existsSync(chosen)).toBe(true);
    expect(existsSync(ignored)).toBe(false);
    expect(runtime.bootstrapResult.workspaceId).toBeTruthy();
  });

  it("file:/// (URL form) is honored too", async () => {
    const chosen = join(dir, "url-form.db");
    // `chosen` is absolute, so this is the file:///abs/path form.
    asSqlite(await createRuntimeFromEnv({ DATABASE_URL: `file://${chosen}`, DB_PATH: join(dir, "unused.db") }));
    expect(existsSync(chosen)).toBe(true);
  });

  it("postgresql:// without a live server -> clear startup error, password redacted", async () => {
    // An ephemeral listener that is not PostgreSQL (drops every connection):
    // deterministic on every network stack, unlike closed-port semantics.
    const { port, close } = await fakeDeadServer();
    try {
      const url = `postgresql://crm_app:supersecret@127.0.0.1:${port}/emcp`;
      const error = await createRuntimeFromEnv({ DATABASE_URL: url }).then(
        () => {
          throw new Error("expected the Postgres startup to fail");
        },
        (cause: unknown) => cause as Error,
      );
      expect(error.message).toContain("Cannot reach PostgreSQL for DATABASE_URL");
      expect(error.message).not.toContain("supersecret");
      expect(error.message).toContain("crm_app:***@");
    } finally {
      await close();
    }
  }, 15_000);

  it("postgres:// alias selects the same adapter (same failure path)", async () => {
    const { port, close } = await fakeDeadServer();
    try {
      await expect(
        createRuntimeFromEnv({ DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/emcp` }),
      ).rejects.toThrow(/Cannot reach PostgreSQL for DATABASE_URL/);
    } finally {
      await close();
    }
  }, 15_000);

  it("an unreachable server fails within the startup budget instead of hanging", async () => {
    // Port 1 either refuses instantly (plain Linux) or blackholes the
    // connect (WSL2 localhost proxying) — both must surface as the same
    // clear, bounded startup error.
    const started = Date.now();
    await expect(
      createRuntimeFromEnv({
        DATABASE_URL: "postgresql://crm_app:pw@127.0.0.1:1/emcp",
        EMCP_PG_STARTUP_TIMEOUT_MS: "1500",
      }),
    ).rejects.toThrow(/Cannot reach PostgreSQL for DATABASE_URL/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("rejects an unsupported DATABASE_URL scheme with a clear error", async () => {
    await expect(createRuntimeFromEnv({ DATABASE_URL: "mysql://root@localhost/emcp" })).rejects.toThrow(
      /Unsupported DATABASE_URL/,
    );
  });

  it("getRuntimeAsync caches one process runtime and shares the sync SQLite singleton", async () => {
    const first = await getRuntimeAsync();
    const second = await getRuntimeAsync();
    expect(second).toBe(first);
    expect(first.adapter).toBe("sqlite");
    // The async entry and the sync scripts entry agree on one runtime.
    expect(getRuntime()).toBe(first);
    expect(existsSync(join(dir, "singleton.db"))).toBe(true);
  });
});
