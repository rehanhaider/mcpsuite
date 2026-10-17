/**
 * Issue #49: two-workspace isolation through real server functions, API ops,
 * MCP HTTP tools/resources and MCP stdio, all connected as crm_app.
 * Contract: docs/architecture/postgres-tenant-isolation.md §7 Transport tests.
 *
 *   cd apps/web && PG_TESTS=1 \
 *     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     mise exec -- pnpm vitest run transport-isolation-pg
 *
 * Builds the production web app into dist/transport-isolation-e2e and serves
 * it with srvx exactly like pnpm start, using separate client/server output.
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { newId, type OpResult } from "@mcpsuite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPg, createPgPorts, provisionPgWorkspace, type PgHandle } from "../../../packages/db/src/pg/repositories.ts";
import { initPgSchema } from "../../../packages/db/src/pg/init.ts";
import { createPgRuntime } from "../../../packages/db/src/pg/runtime.ts";
import { dropTestDatabase, setTestRolePassword } from "../../../packages/db/test/pg-test-support.ts";
import { seed, type Seed, context, ok, noVictimData } from "../../../packages/db/test/catalog-isolation-cases.ts";
import { startStdio, type RpcResponse, type StdioChild } from "../../mcp/test/stdio-client.ts";

const ENABLED = process.env.PG_TESTS === "1" && !!process.env.DATABASE_URL;
const DB = "mcpsuite_web_transport_isolation";
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = resolve(webDir, "../mcp");
const buildDir = join(webDir, "dist/transport-isolation-e2e");
process.env.TSS_SERVER_FN_BASE = "/_product/serverFn/";

// The client RPC uses Start's own request context even when called from Node.
const startStorage = (globalThis as Record<symbol, unknown>)[Symbol.for("tanstack-start:start-storage-context")] as AsyncLocalStorage<unknown>;
// Production IDs are sha256("<file>--<export>_createServerFn_handler") from the Start compiler; a renamed function fails the HTTP 200 check.
const serverFnId = (name: "op" | "whoami") => createHash("sha256")
  .update(`src/server/fns.ts--${name}_createServerFn_handler`).digest("hex");

type Input = Record<string, unknown>;
type Hostile = { ws: string };
type Call = { raw: unknown; result: OpResult };
type Endpoint = "serverFn" | "apiOps" | "mcpWeb" | "mcpHttp" | "stdio";
type Adapter = (operation: string, input: Input, hostile?: Hostile) => Promise<Call>;
type RpcEnvelope = Omit<RpcResponse, "id"> & { jsonrpc?: string };
type ServerChild = { child: ChildProcess; log: string; signal: NodeJS.Signals };
const all: Endpoint[] = ["serverFn", "apiOps", "mcpWeb", "mcpHttp", "stdio"];
const agents: Endpoint[] = ["mcpWeb", "mcpHttp", "stdio"];
const humans: Endpoint[] = ["serverFn", "apiOps"];
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function normalize(value: unknown, replacements: Record<string, string>): unknown {
  let text = JSON.stringify(value);
  for (const [id, placeholder] of Object.entries(replacements)) text = text.split(id).join(placeholder);
  return JSON.parse(text);
}

function normalized(call: Call, replacements: Record<string, string>): Call {
  if (call.result.status === "pending_approval") {
    replacements = { ...replacements, [call.result.pendingActionId]: "<pending-id>" };
  }
  return normalize(call, replacements) as Call;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: NodeJS.Signals): ServerChild {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const server = { child, log: "", signal };
  child.stdout.on("data", (chunk: Buffer) => { server.log += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { server.log += chunk.toString("utf8"); });
  child.on("error", (error) => { server.log += `\n${error.stack}`; });
  return server;
}

async function healthy(server: ServerChild, base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && server.child.exitCode === null && server.child.signalCode === null) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200) return;
    } catch { /* The listener may not be ready yet. */ }
    await pause(100);
  }
  throw new Error(`Server did not become healthy at ${base}\n${server.log}`);
}

async function stop(server: ServerChild): Promise<void> {
  const { child, signal } = server;
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Server did not exit within 10s\n${server.log}`));
    }, 10_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill(signal);
  });
}

function toolResult(rpc: RpcEnvelope): OpResult {
  expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
  const text = rpc.result?.content?.[0]?.text;
  expect(typeof text, JSON.stringify(rpc)).toBe("string");
  const payload = JSON.parse(text!) as Record<string, unknown>;
  if (rpc.result?.isError) return { status: "error", error: payload.error } as OpResult;
  if (payload?.pendingApproval === true) {
    const { pendingActionId, operation, riskCategory, preview, message } = payload;
    return { status: "pending_approval", pendingActionId, operation, riskCategory, preview, message } as OpResult;
  }
  return { status: "ok", data: payload };
}

describe.runIf(ENABLED)("#49 transport isolation — PostgreSQL as crm_app", () => {
  let root: PgHandle;
  let admin: PgHandle;
  let app: PgHandle;
  let runtime: Awaited<ReturnType<typeof createPgRuntime>>;
  let stdio: StdioChild;
  let wsA: string;
  let wsB: string;
  let A: Seed;
  let B: Seed;
  let cookie: string;
  let key: string;
  let webBase: string;
  let mcpBase: string;
  const servers: ServerChild[] = [];
  let snapshotQuery: string;
  let snapshotTables: string[];
  let beforeB: string;
  let nextRpcId = 1;

  async function snapshotB(): Promise<string> {
    const snapshot: Record<string, unknown[]> = Object.fromEntries(snapshotTables.map((name) => [name, []]));
    const rows = (await admin.pool.query(snapshotQuery, [wsB, B.user.id])).rows;
    for (const row of rows) snapshot[String(row.name)]!.push(row.data);
    return JSON.stringify(Object.fromEntries(Object.entries(snapshot).map(([table, rows]) =>
      [table, rows.map((row) => JSON.stringify(row)).sort()],
    )));
  }

  beforeAll(async () => {
    expect(startStorage).toBeDefined();
    root = await connectPg({ databaseUrl: process.env.DATABASE_URL!, max: 1 });
    await root.pool.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await root.pool.query(`CREATE DATABASE ${DB}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${DB}`;
    admin = await connectPg({ databaseUrl: url.toString(), max: 2 });
    await initPgSchema(admin.pool);
    await setTestRolePassword(admin.pool, "crm_app", "crm_app_test_pw");
    url.username = "crm_app";
    url.password = "crm_app_test_pw";
    const appUrl = url.toString();
    app = await connectPg({ databaseUrl: appUrl, max: 2 });
    const role = await app.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    wsA = await provisionPgWorkspace(app.db, { name: "Alpha workspace" });
    wsB = await provisionPgWorkspace(app.db, { name: "Beta workspace" });
    A = await seed(createPgPorts(app.db, wsA), "Alpha");
    B = await seed(createPgPorts(app.db, wsB), "Beta");
    runtime = await createPgRuntime({ databaseUrl: appUrl, max: 2 });
    ok(await runtime.run(context(wsB, B.user.id), "company.get", { id: B.company.id }));
    const { token } = await runtime.identity.createSession(A.user.id);
    cookie = `mcpsuite_session=${encodeURIComponent(token)}`;
    key = (ok(await runtime.run(context(wsA, A.user.id), "mcpClient.create", {
      name: "Transport isolation agent", scopes: ["read", "write", "approvals"], trust: "review_risky_actions",
    })) as { token: string }).token;

    const columns = (await admin.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'crm' AND column_name IN ('workspace_id', 'user_id') ORDER BY table_name, column_name")).rows;
    const tables = new Map<string, string>();
    for (const { table_name, column_name } of columns) {
      const table = String(table_name);
      if (!tables.has(table) || column_name === "workspace_id") tables.set(table, String(column_name));
    }
    tables.set("workspaces", "id");
    snapshotTables = [...tables.keys()].sort();
    snapshotQuery = [...tables].map(([table, column]) =>
      `SELECT '${table}' AS name, to_jsonb(r) AS data FROM crm."${table}" r WHERE "${column}" = $${column === "user_id" ? 2 : 1}::uuid`,
    ).join(" UNION ALL ");

    const build = spawnSync(join(webDir, "node_modules/.bin/vite"), ["build", "--outDir", "dist/transport-isolation-e2e", "--logLevel", "warn"], {
      cwd: webDir, encoding: "utf8", timeout: 240_000,
    });
    if (build.status !== 0) throw new Error(`Production build failed: ${build.error ?? build.status}\n${build.stdout}\n${build.stderr}`);
    webBase = `http://127.0.0.1:${await freePort()}`;
    mcpBase = `http://127.0.0.1:${await freePort()}`;
    const env = { ...process.env, DATABASE_URL: appUrl };
    // srvx --prod serves in this one process and drains for up to 5s on SIGTERM, then the idle pg pool holds it open; the test needs no graceful drain.
    const web = launch(join(webDir, "node_modules/.bin/srvx"), [
      "serve", "--prod", "--dir", ".", "--entry", "dist/transport-isolation-e2e/server/server.js",
      "--static", "dist/transport-isolation-e2e/client", "--port", new URL(webBase).port,
    ], webDir, { ...env, NODE_ENV: "production" }, "SIGKILL");
    servers.push(web);
    // tsx relays SIGTERM to its node child; SIGKILL would orphan that child.
    const mcp = launch(join(mcpDir, "node_modules/.bin/tsx"), ["src/http.ts"], mcpDir, {
      ...env, MCP_PORT: new URL(mcpBase).port, MCP_HOST: "127.0.0.1",
    }, "SIGTERM");
    servers.push(mcp);
    await healthy(web, webBase);
    await healthy(mcp, mcpBase);
    stdio = await startStdio({ ...env, MCPSUITE_API_KEY: key });
    beforeB = await snapshotB();
  }, 300_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const collect = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    // Every step runs even if an earlier one failed, so nothing is left behind.
    await collect(() => stdio?.close());
    for (const server of servers) await collect(() => stop(server));
    await collect(() => runtime?.close());
    await collect(() => app?.close());
    await collect(() => admin?.close());
    if (root) await collect(() => dropTestDatabase(root, DB));
    await collect(() => root?.close());
    await collect(() => rmSync(buildDir, { recursive: true, force: true }));
    if (errors.length) throw errors[0];
  }, 30_000);

  function vectors(hostile?: Hostile): { query: string; headers: Record<string, string> } {
    return hostile ? {
      query: `?workspaceId=${hostile.ws}&workspace_id=${hostile.ws}`,
      headers: {
        "x-workspace-id": hostile.ws, "x-mcpsuite-workspace-id": hostile.ws,
        cookie: `${cookie}; workspaceId=${hostile.ws}; mcpsuite_workspace=${hostile.ws}`,
      },
    } : { query: "", headers: { cookie } };
  }

  async function serverFn(name: "op" | "whoami", data: Input | undefined, hostile?: Hostile): Promise<{ httpStatus: number; result: unknown }> {
    const { query, headers } = vectors(hostile);
    let httpStatus = 0;
    const rpc = createClientRpc(serverFnId(name));
    const out = await startStorage.run({ startOptions: {} }, () => rpc({
      method: name === "op" ? "POST" : "GET", data, headers, context: {},
      fetch: (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        // A browser sends this; TanStack Start's default CSRF middleware refuses server-function calls without it.
        headers.set("sec-fetch-site", "same-origin");
        const suffix = url.includes("?") ? query.replace(/^\?/, "&") : query;
        return fetch(new URL(url + suffix, webBase), { ...init, headers }).then((response) => {
          httpStatus = response.status;
          return response;
        });
      },
    }));
    expect(httpStatus).toBe(200);
    return { httpStatus, result: name === "op" ? JSON.parse(out.result as string) : out.result };
  }

  function toolParams(operation: string, input: Input, hostile?: Hostile): Input {
    return {
      name: operation.replaceAll(".", "_"),
      arguments: { ...input, ...(hostile ? { workspaceId: hostile.ws } : {}) },
      ...(hostile ? { _meta: { workspaceId: hostile.ws } } : {}),
    };
  }

  async function mcpRequest(endpoint: Endpoint, method: string, params: Input, hostile?: Hostile): Promise<{ raw: unknown; rpc: RpcEnvelope }> {
    if (endpoint === "stdio") {
      const { id: _id, ...rpc } = await stdio.request(method, params);
      return { raw: rpc, rpc };
    }
    const { query, headers } = vectors(hostile);
    const response = await fetch(`${endpoint === "mcpWeb" ? webBase : mcpBase}/mcp${query}`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
    });
    const { id: _id, ...rpc } = await response.json() as RpcResponse;
    return { raw: { httpStatus: response.status, rpc }, rpc };
  }

  const adapters: Record<Endpoint, Adapter> = {
    serverFn: async (name, input, hostile) => {
      const raw = await serverFn("op", {
        name, input: { ...input, ...(hostile ? { workspaceId: hostile.ws } : {}) },
        ...(hostile ? { workspaceId: hostile.ws } : {}),
      }, hostile);
      return { raw, result: raw.result as OpResult };
    },
    apiOps: async (name, input, hostile) => {
      const { query, headers } = vectors(hostile);
      const response = await fetch(`${webBase}/api/ops/${name}${query}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ...input, ...(hostile ? { workspaceId: hostile.ws } : {}) }),
      });
      const body = await response.json() as OpResult;
      return { raw: { httpStatus: response.status, body }, result: body };
    },
    mcpWeb: (name, input, hostile) => callMcp("mcpWeb", name, input, hostile),
    mcpHttp: (name, input, hostile) => callMcp("mcpHttp", name, input, hostile),
    stdio: (name, input, hostile) => callMcp("stdio", name, input, hostile),
  };

  async function callMcp(endpoint: Endpoint, name: string, input: Input, hostile?: Hostile): Promise<Call> {
    const { raw, rpc } = await mcpRequest(endpoint, "tools/call", toolParams(name, input, hostile), hostile);
    return { raw, result: toolResult(rpc) };
  }

  function probeTest(name: string, run: () => Promise<void>): void {
    it(name, async () => {
      try { await run(); } catch (error) {
        throw new Error(`${name}: ${String(error)}\n${servers.map((s, i) => `server ${i}:\n${s.log}`).join("\n")}`, { cause: error });
      }
    }, 120_000);
  }

  async function paired(operation: string, bId: string, input: (id: string) => Input, endpoints: Endpoint[], expected: "not_found" | "empty" | "pending"): Promise<void> {
    const results: OpResult[] = [];
    for (const endpoint of endpoints) {
      const randomId = newId();
      const randomWs = newId();
      const foreign = await adapters[endpoint](operation, input(bId), { ws: wsB });
      expect(await snapshotB(), `${endpoint}: B changed after foreign ID`).toBe(beforeB);
      const absent = await adapters[endpoint](operation, input(randomId), { ws: randomWs });
      expect(await snapshotB(), `${endpoint}: B changed after random ID`).toBe(beforeB);
      const b = normalized(foreign, { [bId]: "<target-id>", [wsB]: "<workspace-id>" });
      const random = normalized(absent, { [randomId]: "<target-id>", [randomWs]: "<workspace-id>" });
      expect(b.raw, `${endpoint}: foreign/random envelopes`).toEqual(random.raw);
      noVictimData(b.raw, B);
      for (const call of [foreign, absent]) {
        const message = `${endpoint}: ${JSON.stringify(call.raw)}`;
        if (expected === "not_found") expect(call.result, message).toMatchObject({ status: "error", error: { code: "not_found" } });
        if (expected === "empty") expect(call.result, message).toMatchObject({ status: "ok", data: { items: [], total: 0 } });
        if (expected === "pending") {
          expect(call.result, message).toMatchObject({ status: "pending_approval" });
          // B's company has one linked person, so 0 proves the preview did not see B.
          expect(call.result.status === "pending_approval" && call.result.preview).toEqual({ company: null, linkedPeople: 0 });
        }
      }
      results.push(b.result);
    }
    for (const result of results) expect(result).toEqual(results[0]);
  }

  probeTest("1. company.get hides foreign records", () => paired("company.get", B.company.id, (id) => ({ id }), all, "not_found"));
  probeTest("2. deal.list cannot filter into B", () => paired("deal.list", B.company.id, (companyId) => ({ companyId }), all, "empty"));
  probeTest("3. company.update cannot change B", () => paired("company.update", B.company.id, (id) => ({ id, name: "Alpha edited" }), all, "not_found"));
  probeTest("4. company.linkPerson cannot link B", () => paired("company.linkPerson", B.person.id, (personId) => ({ companyId: A.company.id, personId }), all, "not_found"));
  probeTest("5. deal.addStakeholder cannot link B", () => paired("deal.addStakeholder", B.person.id, (personId) => ({ dealId: A.deal.id, personId }), all, "not_found"));
  probeTest("6. pendingAction.get hides B approvals", () => paired("pendingAction.get", B.pending.id, (id) => ({ id }), all, "not_found"));
  probeTest("7. pendingAction.approve cannot approve B", () => paired("pendingAction.approve", B.pending.id, (id) => ({ id }), all, "not_found"));
  probeTest("8. human company.delete cannot delete B", () => paired("company.delete", B.company.id, (id) => ({ id }), humans, "not_found"));
  probeTest("9. agent company.delete gates without previewing B", () => paired("company.delete", B.company.id, (id) => ({ id }), agents, "pending"));

  async function pairedRpc(method: string, bId: string, params: (id: string) => Input, endpoints: Endpoint[]): Promise<void> {
    const errors: unknown[] = [];
    for (const endpoint of endpoints) {
      const randomId = newId();
      const randomWs = newId();
      const foreign = await mcpRequest(endpoint, method, { ...params(bId), _meta: { workspaceId: wsB } }, { ws: wsB });
      expect(await snapshotB()).toBe(beforeB);
      const absent = await mcpRequest(endpoint, method, { ...params(randomId), _meta: { workspaceId: randomWs } }, { ws: randomWs });
      expect(await snapshotB()).toBe(beforeB);
      const b = normalize(foreign.raw, { [bId]: "<target-id>", [wsB]: "<workspace-id>" });
      expect(b, endpoint).toEqual(normalize(absent.raw, { [randomId]: "<target-id>", [randomWs]: "<workspace-id>" }));
      noVictimData(b, B);
      for (const { rpc } of [foreign, absent]) {
        expect(rpc.result, JSON.stringify(rpc)).toBeUndefined();
        expect(rpc.error, JSON.stringify(rpc)).toBeDefined();
        if (method === "tasks/get") expect(rpc.error?.message).toBe("Unknown task");
        else expect(rpc.error?.message).toContain("not_found");
      }
      errors.push(normalize(foreign.rpc.error, { [bId]: "<target-id>", [wsB]: "<workspace-id>" }));
    }
    for (const error of errors) expect(error).toEqual(errors[0]);
  }

  probeTest("10. MCP resource URLs cannot read B", () => pairedRpc("resources/read", B.company.id, (id) => ({ uri: `mcpsuite://context/company/${id}` }), agents));
  probeTest("11. MCP tasks cannot read B approvals", () => pairedRpc("tasks/get", B.pending.id, (taskId) => ({ taskId }), ["mcpWeb", "mcpHttp"]));

  probeTest("12. hostile workspace IDs cannot override an A read", async () => {
    for (const endpoint of all) {
      const baseline = await adapters[endpoint]("company.get", { id: A.company.id });
      expect(await snapshotB()).toBe(beforeB);
      const hostile = await adapters[endpoint]("company.get", { id: A.company.id }, { ws: wsB });
      expect(hostile.result, endpoint).toEqual(baseline.result);
      expect(hostile.result, endpoint).toMatchObject({ status: "ok", data: { name: "Alpha company" } });
      noVictimData(hostile.result, B);
      expect(await snapshotB()).toBe(beforeB);
    }
  });

  probeTest("13. hostile workspace IDs cannot override an A list", async () => {
    for (const endpoint of all) {
      const baseline = await adapters[endpoint]("company.list", {});
      expect(baseline.result.status).toBe("ok");
      noVictimData(baseline.result, B);
      expect(await snapshotB()).toBe(beforeB);
      for (const ws of [wsB, newId()]) {
        const hostile = await adapters[endpoint]("company.list", {}, { ws });
        expect(hostile.result, endpoint).toEqual(baseline.result);
        noVictimData(hostile.result, B);
        expect(await snapshotB()).toBe(beforeB);
      }
    }
  });

  probeTest("14. hostile workspace IDs cannot redirect creates", async () => {
    for (const endpoint of all) {
      const result = (await adapters[endpoint]("company.create", { name: `Alpha via ${endpoint}` }, { ws: wsB })).result;
      const created = ok(result) as { id: string };
      noVictimData(result, B);
      const landed = await admin.pool.query("SELECT workspace_id::text FROM crm.companies WHERE id = $1", [created.id]);
      expect(landed.rows, endpoint).toEqual([{ workspace_id: wsA }]);
      expect(await snapshotB()).toBe(beforeB);
    }
  });

  probeTest("15. whoami keeps the authenticated workspace", async () => {
    const response = await serverFn("whoami", undefined, { ws: wsB });
    expect(response.result).toMatchObject({ workspace: { id: wsA, name: "Alpha workspace" }, user: { id: A.user.id } });
    noVictimData(response.result, B);
    expect(await snapshotB()).toBe(beforeB);
  });
});
