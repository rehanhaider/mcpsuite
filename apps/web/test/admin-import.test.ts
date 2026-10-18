/**
 * Issue #22: the import card shows the people counts import.preview returns,
 * and the result banner shows what import.run matched and skipped, in the
 * preview's words, so a re-run can be checked against its preview.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext, type RequestContext } from "@mcpsuite/core";
import { createRuntime, openDatabase, type Db, type Runtime } from "@mcpsuite/db";
import {
  ImportPreviewCounts,
  ImportResultSummary,
  type ImportPreview,
  type ImportResult,
} from "../src/routes/app.admin.data.tsx";

// Two rows share Acme; the last row repeats the one before it exactly.
const csv = [
  "Company,Name,Email",
  "Acme,Ada Lovelace,ada@acme.test",
  "Acme,Grace Hopper,grace@acme.test",
  "Globex,Alan Turing,alan@globex.test",
  "Globex,Alan Turing,alan@globex.test",
].join("\n");

let db: Db | undefined;
let dir: string | undefined;
let runtime: Runtime;
let owner: RequestContext;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpsuite-admin-import-"));
  db = openDatabase(join(dir, "import.db"));
  runtime = createRuntime(db);
  const { workspaceId, ownerUserId } = runtime.bootstrapResult;
  owner = { ...systemContext(workspaceId), actorType: "human", userId: ownerUserId, surface: "web" };
});

afterAll(() => {
  if (db?.$client.open) db.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function op<T>(name: string, input: unknown): Promise<T> {
  const result = await runtime.run(owner, name, input);
  if (result.status !== "ok") throw new Error(`${name}: ${JSON.stringify(result)}`);
  return result.data as T;
}

describe("Admin data import card", () => {
  it("shows people counts in the preview and matched/skipped counts after the run", async () => {
    const preview = await op<ImportPreview>("import.preview", { csv });
    const previewMarkup = renderToStaticMarkup(createElement(ImportPreviewCounts, { preview }));
    expect(previewMarkup).toContain("Companies: 2 new · 2 matched");
    expect(previewMarkup).toContain("People: 3 new · 1 matched");

    const first = await op<ImportResult>("import.run", { csv, sourceLabel: "issue-22" });
    const firstMarkup = renderToStaticMarkup(createElement(ImportResultSummary, { result: first }));
    expect(firstMarkup).toContain("Leads: 3 created · 1 skipped (already imported)");
    expect(firstMarkup).toContain("Companies: 2 new · 2 matched");
    expect(firstMarkup).toContain("People: 3 new · 1 matched");

    // The issue's step 3: the same CSV with the same label creates nothing.
    const again = await op<ImportResult>("import.run", { csv, sourceLabel: "issue-22" });
    const againMarkup = renderToStaticMarkup(createElement(ImportResultSummary, { result: again }));
    expect(againMarkup).toContain("Leads: 0 created · 4 skipped (already imported)");
    expect(againMarkup).toContain("Companies: 0 new · 4 matched");
    expect(againMarkup).toContain("People: 0 new · 4 matched");
  });
});
