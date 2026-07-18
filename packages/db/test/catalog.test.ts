/**
 * End-to-end catalog tests against a real in-memory SQLite database:
 * operations, authorization, approval gating, optimistic concurrency,
 * denormalizations, and the audit trail.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  buildCatalog,
  runOperation,
  systemContext,
  type Catalog,
  type OpResult,
  type Ports,
  type RequestContext,
} from "@emcp/core";
import { runMigrations, type Db } from "../src/connection.ts";
import * as schema from "../src/schema.ts";
import { createPorts } from "../src/repositories.ts";
import { createSession, resolveMcpToken, resolveSession } from "../src/auth.ts";
import { resolveWorkspaceAccess } from "../src/hosting-access.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { authServices, csvServices, verifyPassword } from "../src/services.ts";

let db: Db;
let catalog: Catalog;
let ports: Ports;
let owner: RequestContext;
let workspaceId: string;
let ownerUserId: string;

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

function run(ctx: RequestContext, name: string, input: unknown = {}): Promise<OpResult> {
  return runOperation(catalog, ports, ctx, name, input);
}

async function ok<T = any>(result: OpResult | Promise<OpResult>): Promise<T> {
  const r = await result;
  expect(r.status, JSON.stringify(r)).toBe("ok");
  return (r as { status: "ok"; data: T }).data;
}

function agentCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    workspaceId,
    actorType: "agent",
    userId: null,
    clientId: "client-1",
    role: "member",
    scopes: ["read", "write"],
    trust: "review_risky_actions",
    surface: "mcp_http",
    ...overrides,
  };
}

beforeEach(() => {
  db = makeDb();
  const boot = bootstrap(db, { ownerEmail: "test@local", ownerName: "Test", ownerPassword: "pw12345678" });
  workspaceId = boot.workspaceId;
  ownerUserId = boot.ownerUserId;
  catalog = buildCatalog({ auth: authServices, csv: csvServices });
  ports = createPorts(db, workspaceId);
  owner = { ...systemContext(workspaceId), actorType: "human", userId: ownerUserId, surface: "web" };
});

describe("bootstrap", () => {
  it("seeds workspace, owner and default pipelines", async () => {
    const ws = await ok(run(owner, "workspace.get"));
    expect(ws.name).toBeTruthy();
    const pipelines = await ok(run(owner, "pipeline.list"));
    const types = pipelines.map((p: any) => p.type).sort();
    expect(types).toEqual(["deal", "engagement"]);
    const engagement = pipelines.find((p: any) => p.type === "engagement");
    expect(engagement.stages.length).toBeGreaterThanOrEqual(5);
    const row = db.$client.prepare("SELECT password_hash h FROM users").get() as { h: string };
    expect(verifyPassword("pw12345678", row.h)).toBe(true);
  });

  it("never returns a supplied password (option or env) — only generated ones", () => {
    // Supplied via option (the beforeEach db): owner created, password silent.
    const viaOption = bootstrap(makeDb(), { ownerEmail: "Boss@Example.COM", ownerPassword: "option-secret-1" });
    expect(viaOption.createdOwner).toBe(true);
    expect(viaOption.ownerEmail).toBe("boss@example.com");
    expect(viaOption.ownerOneTimePassword).toBeNull();

    // Supplied via EMCP_OWNER_PASSWORD: same contract.
    const prev = process.env.EMCP_OWNER_PASSWORD;
    process.env.EMCP_OWNER_PASSWORD = "env-secret-1";
    try {
      const envDb = makeDb();
      const viaEnv = bootstrap(envDb);
      expect(viaEnv.createdOwner).toBe(true);
      expect(viaEnv.ownerOneTimePassword).toBeNull();
      const row = envDb.$client.prepare("SELECT password_hash h FROM users").get() as { h: string };
      expect(verifyPassword("env-secret-1", row.h)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EMCP_OWNER_PASSWORD;
      else process.env.EMCP_OWNER_PASSWORD = prev;
    }
  });

  it("returns the one-time password only when generated, and only on the creating run", () => {
    const prev = process.env.EMCP_OWNER_PASSWORD;
    delete process.env.EMCP_OWNER_PASSWORD; // ensure the generated path
    try {
      const fresh = makeDb();
      const generated = bootstrap(fresh);
      expect(generated.createdOwner).toBe(true);
      expect(generated.ownerOneTimePassword).toBeTruthy();
      const row = fresh.$client.prepare("SELECT password_hash h FROM users").get() as { h: string };
      expect(verifyPassword(generated.ownerOneTimePassword!, row.h)).toBe(true);

      // Idempotent re-run: owner already exists — nothing created, nothing shown.
      const rerun = bootstrap(fresh);
      expect(rerun.createdOwner).toBe(false);
      expect(rerun.ownerEmail).toBeNull();
      expect(rerun.ownerOneTimePassword).toBeNull();
    } finally {
      if (prev !== undefined) process.env.EMCP_OWNER_PASSWORD = prev;
    }
  });
});

describe("companies + people", () => {
  it("creates, lists, filters, updates with version bump", async () => {
    const company = await ok(run(owner, "company.create", { name: "Acme", industry: "SaaS", country: "UK" }));
    expect(company.displayId).toBe(1);
    expect(company.version).toBe(1);

    const person = await ok(
      run(owner, "person.create", { name: "Ada Lovelace", email: "ada@acme.io", companyId: company.id, title: "CTO" }),
    );
    expect(person.displayId).toBe(1);

    const links = await ok(run(owner, "company.get", { id: company.id }));
    expect(links.people).toHaveLength(1);
    expect(links.people[0].person.name).toBe("Ada Lovelace");
    expect(links.people[0].isPrimary).toBe(true);

    const updated = await ok(run(owner, "company.update", { id: company.id, hq: "London" }));
    expect(updated.version).toBe(2);

    const page = await ok(run(owner, "company.list", { search: "acm" }));
    expect(page.total).toBe(1);

    const empty = await ok(run(owner, "company.list", { search: "zzz" }));
    expect(empty.total).toBe(0);
  });

  it("enforces optimistic concurrency", async () => {
    const company = await ok(run(owner, "company.create", { name: "Acme" }));
    await ok(run(owner, "company.update", { id: company.id, name: "Acme 2" }));
    const conflict = await run(owner, "company.update", { id: company.id, name: "Acme 3", expectedVersion: 1 });
    expect(conflict.status).toBe("error");
    expect((conflict as any).error.code).toBe("version_conflict");
  });

  it("archive hides from lists; hard delete detaches references", async () => {
    const company = await ok(run(owner, "company.create", { name: "Acme" }));
    const engagement = await ok(run(owner, "engagement.create", { companyId: company.id }));

    const archived = await ok(run(owner, "company.archive", { id: company.id }));
    expect(archived.archivedAt).toBeTruthy();
    expect((await ok(run(owner, "company.list", {}))).total).toBe(0);
    expect((await ok(run(owner, "company.list", { includeArchived: true }))).total).toBe(1);

    await ok(run(owner, "company.delete", { id: company.id }));
    expect((await ok(run(owner, "company.list", { includeArchived: true }))).total).toBe(0);
    const orphaned = await ok(run(owner, "engagement.get", { id: engagement.id }));
    expect(orphaned.companyId).toBeNull();
  });
});

describe("engagements", () => {
  it("creates with defaults and moves stages with logged status changes", async () => {
    const company = await ok(run(owner, "company.create", { name: "Acme" }));
    const person = await ok(run(owner, "person.create", { name: "Ada", companyId: company.id }));
    const engagement = await ok(run(owner, "engagement.create", { companyId: company.id, personId: person.id, channel: "Email" }));
    expect(engagement.title).toContain("Ada");
    expect(engagement.displayId).toBe(1);

    const pipelines = await ok(run(owner, "pipeline.list", { type: "engagement" }));
    const stage = pipelines[0].stages[2];
    const moved = await ok(run(owner, "engagement.updateStage", { id: engagement.id, stageId: stage.id, note: "replied!" }));
    expect(moved.stageId).toBe(stage.id);

    const activities = await ok(run(owner, "activity.list", { engagementId: engagement.id }));
    const statusChange = activities.items.find((a: any) => a.kind === "status_change");
    expect(statusChange).toBeTruthy();
    expect(statusChange.meta.toStageId).toBe(stage.id);
    // Note text captured on the status change activity
    expect(statusChange.body).toBe("replied!");
  });

  it("logging an activity bumps lastActivityAt", async () => {
    const engagement = await ok(run(owner, "engagement.create", { title: "Test lead" }));
    expect(engagement.lastActivityAt).toBeNull();
    await ok(run(owner, "activity.log", { kind: "note", body: "called them", engagementId: engagement.id }));
    const after = await ok(run(owner, "engagement.getContext", { id: engagement.id }));
    expect(after.engagement.lastActivityAt).toBeTruthy();
    expect(after.recentActivities).toHaveLength(1);
  });
});

describe("deals", () => {
  it("full lifecycle: create → stage moves → won with closedAt", async () => {
    const company = await ok(run(owner, "company.create", { name: "Acme" }));
    const deal = await ok(
      run(owner, "deal.create", { title: "Acme pentest", companyId: company.id, amountMinor: 500000, currency: "USD" }),
    );
    expect(deal.status).toBe("open");
    expect(deal.probability).toBeGreaterThanOrEqual(0);

    const won = await ok(run(owner, "deal.markWon", { id: deal.id, note: "signed!" }));
    expect(won.status).toBe("won");
    expect(won.closedAt).toBeTruthy();
    expect(won.probability).toBe(100);

    const stats = await ok(run(owner, "stats.deals", {}));
    const wonStage = stats.stages.find((s: any) => s.outcome === "won");
    expect(wonStage.count).toBe(1);
    expect(wonStage.amountMinorByCurrency.USD).toBe(500000);
  });

  it("stakeholders", async () => {
    const deal = await ok(run(owner, "deal.create", { title: "D1" }));
    const person = await ok(run(owner, "person.create", { name: "Buyer Bob" }));
    await ok(run(owner, "deal.addStakeholder", { dealId: deal.id, personId: person.id, role: "champion", isPrimary: true }));
    const detail = await ok(run(owner, "deal.get", { id: deal.id }));
    expect(detail.stakeholders).toHaveLength(1);
    expect(detail.stakeholders[0].person.name).toBe("Buyer Bob");
  });
});

describe("tasks", () => {
  it("create, complete, and home stats overdue bucket", async () => {
    const task = await ok(run(owner, "task.create", { title: "Follow up", dueAt: "2020-01-01" }));
    expect(task.displayId).toBe(1);

    const home = await ok(run(owner, "stats.home"));
    expect(home.overdueTasks.some((t: any) => t.id === task.id)).toBe(true);

    const done = await ok(run(owner, "task.complete", { id: task.id }));
    expect(done.completedAt).toBeTruthy();

    const homeAfter = await ok(run(owner, "stats.home"));
    expect(homeAfter.overdueTasks.some((t: any) => t.id === task.id)).toBe(false);
  });
});

describe("tags + custom fields + saved views", () => {
  it("tag lifecycle and filtering", async () => {
    const tag = await ok(run(owner, "tag.create", { name: "hot", color: "error" }));
    const company = await ok(run(owner, "company.create", { name: "Acme" }));
    await ok(run(owner, "tag.apply", { tagId: tag.id, entityType: "company", entityId: company.id }));
    const filtered = await ok(run(owner, "company.list", { tagIds: [tag.id] }));
    expect(filtered.total).toBe(1);
    const none = await ok(run(owner, "company.list", { tagIds: [tag.id === "x" ? "y" : "00000000-0000-7000-8000-000000000000"] }));
    expect(none.total).toBe(0);
  });

  it("custom field def + validated values", async () => {
    const def = await ok(
      run(owner, "customField.create", {
        entityType: "engagement",
        label: "Confidence",
        type: "select",
        options: ["High", "Medium", "Low"],
      }),
    );
    expect(def.key).toBe("confidence");
    const engagement = await ok(run(owner, "engagement.create", { title: "L1" }));
    await ok(run(owner, "customField.setValues", { entityType: "engagement", entityId: engagement.id, values: { confidence: "High" } }));
    const detail = await ok(run(owner, "engagement.get", { id: engagement.id }));
    expect(detail.customFields.confidence).toBe("High");

    const bad = await run(owner, "customField.setValues", {
      entityType: "engagement",
      entityId: engagement.id,
      values: { confidence: "Extreme" },
    });
    expect(bad.status).toBe("error");
    expect((bad as any).error.code).toBe("validation");
  });

  it("saved views", async () => {
    const view = await ok(run(owner, "savedView.create", { name: "UK leads", entityType: "engagement", filters: { search: "uk" } }));
    const list = await ok(run(owner, "savedView.list", {}));
    expect(list.some((v: any) => v.id === view.id)).toBe(true);
  });
});

describe("contact lists", () => {
  it("full lifecycle: create, add members, filter, counts, remove, delete", async () => {
    const list = await ok(run(owner, "list.create", { name: "Job search", color: "info", description: "Recruiters & hiring managers" }));
    const dupe = await ok(run(owner, "list.create", { name: "job search" }));
    expect(dupe.id).toBe(list.id); // name-idempotent

    const acme = await ok(run(owner, "company.create", { name: "Acme" }));
    const p1 = await ok(run(owner, "person.create", { name: "Recruiter One" }));
    const p2 = await ok(run(owner, "person.create", { name: "Recruiter Two" }));
    const outsider = await ok(run(owner, "person.create", { name: "Prospect" }));

    const added = await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "person", entityIds: [p1.id, p2.id] }));
    expect(added.added).toBe(2);
    const again = await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "person", entityIds: [p1.id] }));
    expect(again.added).toBe(0);
    expect(again.alreadyPresent).toBe(1);
    await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "company", entityIds: [acme.id] }));

    // Counts on the index op (dashboard surface).
    const lists = await ok(run(owner, "list.list", {}));
    const found = lists.find((l: any) => l.id === list.id);
    expect(found.people).toBe(2);
    expect(found.companies).toBe(1);

    // person.list filter — the MCP-visible "who's in my job-search list" query.
    const filtered = await ok(run(owner, "person.list", { listId: list.id }));
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((p: any) => p.id)).not.toContain(outsider.id);

    // Combined members op.
    const members = await ok(run(owner, "list.members", { id: list.id }));
    expect(members.people.total).toBe(2);
    expect(members.companies.total).toBe(1);

    const removed = await ok(run(owner, "list.removeMembers", { listId: list.id, entityType: "person", entityIds: [p2.id] }));
    expect(removed.removed).toBe(1);
    expect((await ok(run(owner, "person.list", { listId: list.id }))).total).toBe(1);

    const lead = await ok(run(owner, "engagement.create", { title: "Campaign lead" }));
    await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));
    const listsAfterLead = await ok(run(owner, "list.list", {}));
    expect(listsAfterLead.find((l: any) => l.id === list.id).engagements).toBe(1);
    expect((await ok(run(owner, "engagement.list", { listId: list.id }))).total).toBe(1);
    const membersWithLead = await ok(run(owner, "list.members", { id: list.id }));
    expect(membersWithLead.engagements.total).toBe(1);
    await ok(run(owner, "list.removeMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));

    const deal = await ok(run(owner, "deal.create", { title: "Campaign deal" }));
    await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "deal", entityIds: [deal.id] }));
    expect((await ok(run(owner, "list.list", {}))).find((l: any) => l.id === list.id).deals).toBe(1);

    await ok(run(owner, "list.delete", { id: list.id }));
    expect((await ok(run(owner, "list.list", {}))).length).toBe(0);
    // Members detached, contacts untouched.
    expect((await ok(run(owner, "person.get", { id: p1.id }))).id).toBe(p1.id);
  });

  it("rejects unknown member ids and is agent-writable without approval", async () => {
    const list = await ok(run(owner, "list.create", { name: "Product X" }));
    const bad = await run(owner, "list.addMembers", {
      listId: list.id,
      entityType: "person",
      entityIds: ["00000000-0000-7000-8000-000000000000"],
    });
    expect(bad.status).toBe("error");

    // Low-trust agent can still manage membership (reversible metadata).
    const person = await ok(run(owner, "person.create", { name: "Agent Target" }));
    const viaAgent = await run(agentCtx(), "list.addMembers", { listId: list.id, entityType: "person", entityIds: [person.id] });
    expect(viaAgent.status).toBe("ok");
    // …but deleting the list is config-gated for agents: routed to approvals.
    const del = await run(agentCtx(), "list.delete", { id: list.id });
    expect(del.status).toBe("pending_approval");
  });

  it("typed list rejects mismatched members and retyping with conflicts", async () => {
    const typed = await ok(run(owner, "list.create", { name: "Leads only", entityType: "engagement" }));
    const person = await ok(run(owner, "person.create", { name: "Wrong type" }));
    const bad = await run(owner, "list.addMembers", { listId: typed.id, entityType: "person", entityIds: [person.id] });
    expect(bad.status).toBe("error");
    expect((bad as any).error.message).toContain("holds");

    const mixed = await ok(run(owner, "list.create", { name: "Mixed audience" }));
    const lead = await ok(run(owner, "engagement.create", { title: "One" }));
    await ok(run(owner, "list.addMembers", { listId: mixed.id, entityType: "person", entityIds: [person.id] }));
    await ok(run(owner, "list.addMembers", { listId: mixed.id, entityType: "engagement", entityIds: [lead.id] }));

    const retypeFail = await run(owner, "list.update", { id: mixed.id, entityType: "deal" });
    expect(retypeFail.status).toBe("error");
    await ok(run(owner, "list.removeMembers", { listId: mixed.id, entityType: "person", entityIds: [person.id] }));
    await ok(run(owner, "list.removeMembers", { listId: mixed.id, entityType: "engagement", entityIds: [lead.id] }));
    await ok(run(owner, "list.update", { id: mixed.id, entityType: "deal" }));
  });

  it("rejects create when same name exists with incompatible entity type", async () => {
    await ok(run(owner, "list.create", { name: "Pipeline focus", entityType: "person" }));
    const clash = await run(owner, "list.create", { name: "pipeline focus", entityType: "deal" });
    expect(clash.status).toBe("error");
    expect((clash as any).error.message).toContain("already exists");
    // Untyped request can reuse a typed list of the same holding type via name match — N/A here.
    // Mixed name match against typed person list is OK (mixed can hold people).
    const mixed = await ok(run(owner, "list.create", { name: "Pipeline focus" }));
    expect(mixed.entityType).toBe("person");
  });

  it("hard-deleting a listed lead clears list membership counts", async () => {
    const list = await ok(run(owner, "list.create", { name: "Delete cleanup", entityType: "engagement" }));
    const lead = await ok(run(owner, "engagement.create", { title: "Gone" }));
    await ok(run(owner, "list.addMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));
    expect((await ok(run(owner, "list.list", {}))).find((l: any) => l.id === list.id).engagements).toBe(1);
    await ok(run(owner, "engagement.delete", { id: lead.id }));
    expect((await ok(run(owner, "list.list", {}))).find((l: any) => l.id === list.id).engagements).toBe(0);
  });
});

describe("offerings", () => {
  it("create links offering; convert carries links; unknown offering is atomic", async () => {
    const offering = await ok(run(owner, "offering.create", { name: "Product X", type: "product" }));
    const before = (await ok(run(owner, "engagement.list", {}))).total;
    const lead = await ok(run(owner, "engagement.create", { title: "Pitch", offeringId: offering.id }));
    expect((await ok(run(owner, "engagement.list", {}))).total).toBe(before + 1);
    const ctx = await ok(run(owner, "engagement.getContext", { id: lead.id }));
    expect(ctx.offerings).toHaveLength(1);
    expect(ctx.offerings[0].isPrimary).toBe(true);
    expect((await ok(run(owner, "engagement.list", { offeringId: offering.id }))).total).toBe(1);

    const deal = await ok(run(owner, "deal.create", { title: "Product X deal", engagementId: lead.id }));
    const dealCtx = await ok(run(owner, "deal.getContext", { id: deal.id }));
    expect(dealCtx.offerings).toHaveLength(1);
    expect(dealCtx.offerings[0].offeringId).toBe(offering.id);

    const beforeBad = (await ok(run(owner, "engagement.list", {}))).total;
    const bad = await run(owner, "engagement.create", { title: "Nope", offeringId: "00000000-0000-7000-8000-000000000000" });
    expect(bad.status).toBe("error");
    expect((bad as any).error.code).toBe("not_found");
    expect((await ok(run(owner, "engagement.list", {}))).total).toBe(beforeBad);
  });
});

describe("authorization + approval gating", () => {
  it("agent without scope is forbidden", async () => {
    const readOnly = agentCtx({ scopes: ["read"] });
    const result = await run(readOnly, "company.create", { name: "Nope" });
    expect(result.status).toBe("error");
    expect((result as any).error.code).toBe("forbidden");
  });

  it("agent read works", async () => {
    await ok(run(owner, "company.create", { name: "Acme" }));
    const page = await ok(run(agentCtx(), "company.list", {}));
    expect(page.total).toBe(1);
  });

  it("risky op from low-trust agent creates pending action; approval executes it", async () => {
    const company = await ok(run(owner, "company.create", { name: "Doomed Inc" }));
    const agent = agentCtx();

    const result = await run(agent, "company.delete", { id: company.id });
    expect(result.status).toBe("pending_approval");
    const pendingId = (result as any).pendingActionId;

    // Still exists
    expect((await ok(run(owner, "company.list", {}))).total).toBe(1);

    // Approve as owner → executes delete
    const approval = await ok(run(owner, "pendingAction.approve", { id: pendingId }));
    expect(approval.pendingAction.status).toBe("approved");
    expect((await ok(run(owner, "company.list", {}))).total).toBe(0);

    // Audit trail captured both the request and the approval
    const audit = await ok(run(owner, "audit.list", {}));
    const ops = audit.items.map((e: any) => e.operation);
    expect(ops).toContain("pendingAction.create");
    expect(ops).toContain("pendingAction.approve");
  });

  it("trusted agent executes bulk ops directly, low-trust agent needs approval", async () => {
    const c1 = await ok(run(owner, "company.create", { name: "A" }));
    const c2 = await ok(run(owner, "company.create", { name: "B" }));
    const trusted = agentCtx({ trust: "trusted_agent" });
    const result = await ok(run(trusted, "bulk.archive", { entityType: "company", ids: [c1.id, c2.id] }));
    expect(result.updated).toBe(2);

    const lowTrust = agentCtx();
    const gated = await run(lowTrust, "bulk.archive", { entityType: "company", ids: [c1.id] });
    expect(gated.status).toBe("pending_approval");
  });

  it("reject leaves target untouched", async () => {
    const company = await ok(run(owner, "company.create", { name: "Safe Inc" }));
    const gated = await run(agentCtx(), "company.delete", { id: company.id });
    const pendingId = (gated as any).pendingActionId;
    await ok(run(owner, "pendingAction.reject", { id: pendingId, note: "no way" }));
    expect((await ok(run(owner, "company.list", {}))).total).toBe(1);
    const pa = await ok(run(owner, "pendingAction.get", { id: pendingId }));
    expect(pa.status).toBe("rejected");
  });

  it("viewer cannot write", async () => {
    const viewer: RequestContext = { ...owner, role: "viewer" };
    const result = await run(viewer, "company.create", { name: "Nope" });
    expect(result.status).toBe("error");
    expect((result as any).error.code).toBe("forbidden");
  });

  it("pending action and its audit event commit atomically (audit failure rolls both back)", async () => {
    const company = await ok(run(owner, "company.create", { name: "Atomic Inc" }));
    const countPending = (): number =>
      (db.$client.prepare("SELECT COUNT(*) n FROM pending_actions").get() as { n: number }).n;
    const countAudit = (): number =>
      (db.$client.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation = 'pendingAction.create'").get() as { n: number }).n;
    expect(countPending()).toBe(0);

    // Same ports instance (same tx helper), audit.record stubbed to fail AFTER
    // pendingActions.create succeeded inside the transaction.
    const failingPorts: Ports = {
      ...ports,
      audit: {
        ...ports.audit,
        record: async () => {
          throw new Error("audit store down");
        },
      },
    };
    const result = await runOperation(catalog, failingPorts, agentCtx(), "company.delete", { id: company.id });
    expect(result.status).toBe("error");
    // The pending action row created before the audit failure rolled back too.
    expect(countPending()).toBe(0);
    expect(countAudit()).toBe(0);

    // Sanity: with healthy ports the same request commits both rows together.
    const gated = await run(agentCtx(), "company.delete", { id: company.id });
    expect(gated.status).toBe("pending_approval");
    expect(countPending()).toBe(1);
    expect(countAudit()).toBe(1);
  });
});

describe("pipelines", () => {
  it("stage delete blocked while in use", async () => {
    const pipelines = await ok(run(owner, "pipeline.list", { type: "engagement" }));
    const stage = pipelines[0].stages[0];
    await ok(run(owner, "engagement.create", { title: "L1" }));
    const del = await run(owner, "stage.delete", { id: stage.id });
    expect(del.status).toBe("error");
    expect((del as any).error.code).toBe("in_use");
  });

  it("create custom pipeline and reorder stages", async () => {
    const pipeline = await ok(
      run(owner, "pipeline.create", {
        type: "engagement",
        name: "Partners",
        stages: [
          { name: "Sourced", color: "info" },
          { name: "In Talks", color: "primary" },
        ],
      }),
    );
    expect(pipeline.stages).toHaveLength(2);
    const reversed = [...pipeline.stages].reverse().map((s: any) => s.id);
    await ok(run(owner, "stage.reorder", { pipelineId: pipeline.id, stageIds: reversed }));
    const after = (await ok(run(owner, "pipeline.list", { type: "engagement" }))).find((p: any) => p.id === pipeline.id);
    expect(after.stages.map((s: any) => s.id)).toEqual(reversed);
  });
});

describe("search + import/export", () => {
  it("global search hits companies and people", async () => {
    await ok(run(owner, "company.create", { name: "Acme Rockets" }));
    await ok(run(owner, "person.create", { name: "Wile E Coyote" }));
    const hits = await ok(run(owner, "search.global", { query: "acme" }));
    expect(hits.some((h: any) => h.entityType === "company")).toBe(true);
    const personHits = await ok(run(owner, "search.global", { query: "coyote" }));
    expect(personHits.some((h: any) => h.entityType === "person")).toBe(true);
  });

  it("CSV import (preview + run) then export", async () => {
    const csv = "Company,Contact,Title,Email,Channel\nAcme,Ada Lovelace,CTO,ada@acme.io,Email\nBeta Corp,Bob,CEO,bob@beta.co,LinkedIn\n";
    const preview = await ok(run(owner, "import.preview", { csv }));
    expect(preview.importableRows).toBe(2);
    expect(preview.newCompanies).toBe(2);

    const result = await ok(run(owner, "import.run", { csv, sourceLabel: "test-batch" }));
    expect(result.companiesCreated).toBe(2);
    expect(result.engagementsCreated).toBe(2);

    // Re-import dedupes companies
    const again = await ok(run(owner, "import.run", { csv, sourceLabel: "test-batch" }));
    expect(again.companiesCreated).toBe(0);
    expect(again.companiesMatched).toBe(2);

    const exported = await ok(run(owner, "export.csv", { entityType: "company" }));
    expect(exported.rowCount).toBe(2);
    expect(exported.csv).toContain("Acme");
  });
});

describe("admin", () => {
  it("user create/update, password reset, mcp client lifecycle", async () => {
    const created = await ok(run(owner, "user.create", { name: "Sam", email: "sam@example.com", role: "member" }));
    expect(created.oneTimePassword).toBeTruthy();
    expect(created.user.role).toBe("member");

    const updated = await ok(run(owner, "user.update", { id: created.user.id, role: "admin" }));
    expect(updated.role).toBe("admin");

    const client = await ok(run(owner, "mcpClient.create", { name: "Claude", scopes: ["read", "write"], trust: "trusted_agent" }));
    expect(client.token).toMatch(/^emcp_/);

    const revoked = await ok(run(owner, "mcpClient.revoke", { id: client.client.id }));
    expect(revoked.revokedAt).toBeTruthy();
  });

  it("member cannot run admin-only ops", async () => {
    const member: RequestContext = { ...owner, role: "member" };
    const result = await run(member, "user.list", {});
    expect(result.status).toBe("ok"); // viewer-level
    const clients = await run(member, "mcpClient.list", {});
    expect(clients.status).toBe("ok");
    const forbidden = await run(member, "audit.list", {});
    expect(forbidden.status).toBe("error");
  });
});

describe("agent authority mirrors the owning user", () => {
  function humanCtx(userId: string, role: RequestContext["role"]): RequestContext {
    return { ...owner, userId, role };
  }

  async function createUser(role: "member" | "admin"): Promise<RequestContext> {
    const created = await ok(run(owner, "user.create", { name: `u-${role}`, email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role }));
    return humanCtx(created.user.id, role);
  }

  it("caps grantable scopes by the creator's role", async () => {
    const member = await createUser("member");
    const denied = await run(member, "mcpClient.create", { name: "Escalator", scopes: ["read", "write", "admin"] });
    expect(denied.status).toBe("error");
    expect((denied as any).error.code).toBe("forbidden");

    const allowed = await run(member, "mcpClient.create", { name: "Helper", scopes: ["read", "write", "approvals"] });
    expect(allowed.status).toBe("ok");

    const full = await run(owner, "mcpClient.create", { name: "Ops bot", scopes: ["read", "write", "admin", "approvals"] });
    expect(full.status).toBe("ok");
  });

  it("members only see and manage their own clients; updates respect the owner's cap", async () => {
    const member = await createUser("member");
    const ownerClient = await ok(run(owner, "mcpClient.create", { name: "Owner bot", scopes: ["read", "write", "admin"] }));
    const memberClient = await ok(run(member, "mcpClient.create", { name: "Member bot", scopes: ["read", "write"] }));

    const memberList = await ok<any[]>(run(member, "mcpClient.list", {}));
    expect(memberList.map((c) => c.id)).toEqual([memberClient.client.id]);
    expect((await ok<any[]>(run(owner, "mcpClient.list", {}))).length).toBe(2);

    expect((await run(member, "mcpClient.revoke", { id: ownerClient.client.id })).status).toBe("error");
    expect((await run(member, "mcpClient.update", { id: ownerClient.client.id, name: "hijacked" })).status).toBe("error");
    expect((await run(member, "mcpClient.update", { id: memberClient.client.id, scopes: ["read", "write", "admin"] })).status).toBe("error");

    // Admins manage anyone's client but cannot push scopes past the owner's role.
    expect((await run(owner, "mcpClient.update", { id: memberClient.client.id, name: "renamed" })).status).toBe("ok");
    expect((await run(owner, "mcpClient.update", { id: memberClient.client.id, scopes: ["read", "admin"] })).status).toBe("error");
  });

  it("resolves tokens with the creator's current role and clamps scopes on demotion; disabled creator kills the key", async () => {
    const admin = await createUser("admin");
    const created = await ok(run(admin, "mcpClient.create", { name: "Admin bot", scopes: ["read", "write", "admin", "approvals"] }));

    let resolved = resolveMcpToken(db, created.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.role).toBe("admin");
    expect(resolved!.userId).toBe(admin.userId);
    expect(resolved!.scopes).toContain("admin");

    await ok(run(owner, "user.update", { id: admin.userId!, role: "member" }));
    resolved = resolveMcpToken(db, created.token);
    expect(resolved!.role).toBe("member");
    expect(resolved!.scopes.sort()).toEqual(["approvals", "read", "write"]);

    await ok(run(owner, "user.update", { id: admin.userId!, disabled: true }));
    expect(resolveMcpToken(db, created.token)).toBeNull();
  });

  it("an agent cannot approve its own pending actions", async () => {
    const company = await ok(run(owner, "company.create", { name: "Doomed Co" }));
    const requester = agentCtx({ clientId: "client-self", scopes: ["read", "write"] });
    const pending = await run(requester, "company.delete", { id: company.id });
    expect(pending.status).toBe("pending_approval");
    const paId = (pending as any).pendingActionId;

    const sameClientElevated = agentCtx({ clientId: "client-self", role: "admin", scopes: ["read", "write", "admin", "approvals"] });
    const selfApprove = await run(sameClientElevated, "pendingAction.approve", { id: paId });
    expect(selfApprove.status).toBe("error");
    expect((selfApprove as any).error.code).toBe("forbidden");

    expect((await run(owner, "pendingAction.approve", { id: paId })).status).toBe("ok");
  });
});

describe("disable revokes everything; re-enable restores nothing", () => {
  async function memberWithSessionAndAgent(): Promise<{ userId: string; sessionToken: string; mcpToken: string; clientId: string }> {
    const created = await ok(run(owner, "user.create", { name: "Dee", email: "dee@example.com", role: "member" }));
    const userId = created.user.id as string;
    const memberCtx: RequestContext = { ...owner, userId, role: "member" };
    const session = createSession(db, userId);
    const client = await ok(run(memberCtx, "mcpClient.create", { name: "Dee bot", scopes: ["read", "write"] }));
    return { userId, sessionToken: session.token, mcpToken: client.token, clientId: client.client.id };
  }

  it("disabling deletes all sessions and revokes all MCP clients; re-enable brings nothing back", async () => {
    const { userId, sessionToken, mcpToken, clientId } = await memberWithSessionAndAgent();
    expect(resolveSession(db, sessionToken)).not.toBeNull();
    expect(resolveMcpToken(db, mcpToken)).not.toBeNull();

    await ok(run(owner, "user.update", { id: userId, disabled: true }));

    // Session ROWS are gone (hard delete, not filtering) and resolution fails.
    const sessionRows = db.$client.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").get(userId) as { n: number };
    expect(sessionRows.n).toBe(0);
    expect(resolveSession(db, sessionToken)).toBeNull();

    // MCP clients are revoked (flagged, not deleted) and the key is unusable.
    expect(resolveMcpToken(db, mcpToken)).toBeNull();
    const clients = await ok<any[]>(run(owner, "mcpClient.list", {}));
    const revoked = clients.find((c) => c.id === clientId);
    expect(revoked).toBeTruthy();
    expect(revoked.revokedAt).toBeTruthy();

    // Re-enable restores neither sessions nor clients.
    await ok(run(owner, "user.update", { id: userId, disabled: false }));
    expect((db.$client.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").get(userId) as { n: number }).n).toBe(0);
    expect(resolveSession(db, sessionToken)).toBeNull();
    expect(resolveMcpToken(db, mcpToken)).toBeNull();
    expect((await ok<any[]>(run(owner, "mcpClient.list", {}))).find((c) => c.id === clientId).revokedAt).toBeTruthy();
  });

  it("a role change applies on the next request without ending the session", async () => {
    const created = await ok(run(owner, "user.create", { name: "Rae", email: "rae@example.com", role: "member" }));
    const session = createSession(db, created.user.id);
    expect(resolveSession(db, session.token)!.role).toBe("member");

    await ok(run(owner, "user.update", { id: created.user.id, role: "admin" }));

    const after = resolveSession(db, session.token);
    expect(after).not.toBeNull(); // still logged in — role changes never log the user out
    expect(after!.role).toBe("admin");
  });
});

describe("multi-workspace isolation", () => {
  it("second workspace sees nothing from the first", async () => {
    await ok(run(owner, "company.create", { name: "WS1 Co" }));

    // Manually create a second workspace + ports
    const now = new Date().toISOString();
    db.$client
      .prepare("INSERT INTO workspaces (id, name, default_currency, timezone, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("ws2", "Other", "USD", "UTC", "{}", now, now);
    const ports2 = createPorts(db, "ws2");
    const ctx2: RequestContext = { ...owner, workspaceId: "ws2" };
    const result = await runOperation(catalog, ports2, ctx2, "company.list", {});
    expect((result as any).data.total).toBe(0);
  });
});

describe("hosted workspace access read contract", () => {
  // Mirrors the DDL owned by @emcp/hosting-control (hc-store.ts); the CRM
  // side only ever reads this table.
  function createAccessTable(): void {
    db.$client.exec(`CREATE TABLE IF NOT EXISTS hc_workspace_access (
      workspace_id      TEXT PRIMARY KEY,
      access_mode       TEXT NOT NULL DEFAULT 'active',
      access_expires_at TEXT,
      version           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )`);
  }

  function setAccess(mode: "active" | "locked", expiresAt: string | null): void {
    createAccessTable();
    const now = new Date().toISOString();
    db.$client
      .prepare(
        `INSERT INTO hc_workspace_access (workspace_id, access_mode, access_expires_at, version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET access_mode = excluded.access_mode, access_expires_at = excluded.access_expires_at`,
      )
      .run(workspaceId, mode, expiresAt, now, now);
  }

  it("resolves active when the table does not exist (self-host database)", () => {
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "active", expiresAt: null });
  });

  it("resolves active when the table exists but the workspace has no row", () => {
    createAccessTable();
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "active", expiresAt: null });
  });

  it("resolves locked when the mode is locked", () => {
    setAccess("locked", null);
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "locked", expiresAt: null });
  });

  it("keeps an active workspace with a future expiry active", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setAccess("active", future);
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "active", expiresAt: future });
  });

  it("locks an active workspace once its expiry passes (expiry-at-read-time)", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    setAccess("active", past);
    expect(resolveWorkspaceAccess(db, workspaceId)).toEqual({ mode: "locked", expiresAt: past });
    // The same row read "before" the expiry resolves active — no worker needed.
    const beforeExpiry = new Date(Date.now() - 5000).toISOString();
    expect(resolveWorkspaceAccess(db, workspaceId, beforeExpiry).mode).toBe("active");
  });
});
