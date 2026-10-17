import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpError } from "@mcpsuite/core";
import { createRuntime, createSession, getRuntimeAsync, openDatabase, type Db, type Runtime } from "@mcpsuite/db";
import { Route } from "../src/routes/api.ops.$name.ts";

vi.mock("@mcpsuite/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mcpsuite/db")>(),
  getRuntimeAsync: vi.fn(),
}));

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const post = (Route.options as any).server.handlers.POST as Handler;
let db: Db;
let dir: string;
let runtime: Runtime;
let cookie: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-error-ref-"));
  db = openDatabase(join(dir, "errors.db"));
  runtime = createRuntime(db);
  db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(runtime.bootstrapResult.ownerUserId);
  const { token } = createSession(db, runtime.bootstrapResult.ownerUserId);
  cookie = `mcpsuite_session=${encodeURIComponent(token)}`;
  runtime.catalog.set("test.fail", {
    name: "test.fail",
    title: "Forced failure",
    description: "Exercise error responses",
    input: z.object({ secret: z.string() }),
    minRole: "member",
    scope: "write",
    risk: null,
    mcpExpose: false,
    handler: async () => { throw new Error("boom"); },
  });
});

beforeEach(() => {
  vi.mocked(getRuntimeAsync).mockResolvedValue(runtime);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getRuntimeAsync).mockReset();
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const secret = "s3cr3t-request-body";
const authorization = "Bearer s3cr3t-authorization";

function request(sessionCookie = cookie, body = JSON.stringify({ secret })): Request {
  return new Request("http://test.local/api/ops/test.fail", {
    method: "POST",
    headers: { cookie: sessionCookie, authorization, "content-type": "application/json" },
    body,
  });
}

describe("POST /api/ops error references", () => {
  it.each(["handler", "runtime", "workspaceAccess", "startup"] as const)(
    "matches the response to one log when %s throws, without request credentials or input",
    async (source) => {
      if (source === "runtime") vi.spyOn(runtime, "run").mockRejectedValueOnce(new Error("boom"));
      if (source === "workspaceAccess") vi.spyOn(runtime.identity, "workspaceAccess").mockRejectedValueOnce(new Error("boom"));
      if (source === "startup") vi.mocked(getRuntimeAsync).mockRejectedValueOnce(new Error("boom"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await post({ request: request(), params: { name: "test.fail" } });
      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result.status).toBe("error");
      expect(result.error.code).toBe("internal");
      expect(result.error.message).toBe("An internal error occurred");
      expect(result.error.reference).toMatch(/^[0-9a-f]{12}$/);
      const context = source === "handler" ? "op test.fail" : "api ops test.fail";
      expect(log).toHaveBeenCalledExactlyOnceWith(
        `[mcpsuite] error ref=${result.error.reference} context=${context} code=internal: Error: boom`,
      );
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(secret);
      expect(output).not.toContain(cookie);
      expect(output).not.toContain(authorization);
    },
  );

  it("keeps intentional validation errors without references or logs", async () => {
    vi.spyOn(runtime.catalog.get("test.fail")!, "handler").mockRejectedValueOnce(OpError.validation("Invalid value"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post({ request: request(), params: { name: "test.fail" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "error", error: { code: "validation", message: "Invalid value" },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps unauthenticated requests and malformed JSON without references or logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unauthenticated = await post({ request: request(""), params: { name: "test.fail" } });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      status: "error", error: { code: "unauthorized", message: "Sign in first" },
    });
    const malformed = await post({ request: request(cookie, "{"), params: { name: "test.fail" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      status: "error", error: { code: "validation", message: "Body must be JSON" },
    });
    expect(log).not.toHaveBeenCalled();
  });
});
