import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, getRuntimeAsync, openDatabase, type Db, type Runtime } from "@mcpsuite/db";
import { version } from "../../../package.json";
import { Route } from "../src/routes/healthz.ts";

vi.mock("@mcpsuite/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mcpsuite/db")>(),
  getRuntimeAsync: vi.fn(),
}));

const get = (Route.options as any).server.handlers.GET as () => Promise<Response>;
let db: Db | undefined;
let dir: string | undefined;
let runtime: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-healthz-"));
  db = openDatabase(join(dir, "health.db"));
  runtime = createRuntime(db);
});

afterAll(() => {
  if (db?.$client.open) db.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(getRuntimeAsync).mockReset();
});

describe("GET /healthz", () => {
  it("returns 200 with only readiness, server, and version after a successful CRM read", async () => {
    vi.mocked(getRuntimeAsync).mockResolvedValue(runtime);

    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, server: "mcpsuite-web", version });

    runtime.db.$client.close();
    const unavailable = await get();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, server: "mcpsuite-web", version });
  });

  it("returns 503 without error details when runtime acquisition fails", async () => {
    vi.mocked(getRuntimeAsync).mockRejectedValue(new Error("private connection details"));

    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, server: "mcpsuite-web", version });
  });
});
