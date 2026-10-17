import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, getRuntimeAsync, openDatabase, type Db, type Runtime } from "@mcpsuite/db";
import { SystemInfo } from "../src/routes/app.admin.index.tsx";
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
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-admin-version-"));
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

describe("Admin system information", () => {
  it("shows the same non-empty version as GET /healthz", async () => {
    vi.mocked(getRuntimeAsync).mockResolvedValue(runtime);

    const response = await get();
    expect(response.status).toBe(200);
    const { version } = await response.json();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);

    const markup = renderToStaticMarkup(createElement(SystemInfo));
    expect(markup).toContain("System");
    expect(markup).toContain("Version");
    expect(markup).toContain(`<span class="font-mono">${version}</span>`);
  });
});
