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
import { resolveMcpToken } from "../src/auth.ts";
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

function run(ctx: RequestContext, name: string, input: unknown = {}): OpResult {
  return runOperation(catalog, ports, ctx, name, input);
}

function ok<T = any>(result: OpResult): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return (result as { status: "ok"; data: T }).data;
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
  it("seeds workspace, owner and default pipelines", () => {
    const ws = ok(run(owner, "workspace.get"));
    expect(ws.name).toBeTruthy();
    const pipelines = ok(run(owner, "pipeline.list"));
    const types = pipelines.map((p: any) => p.type).sort();
    expect(types).toEqual(["deal", "engagement"]);
    const engagement = pipelines.find((p: any) => p.type === "engagement");
    expect(engagement.stages.length).toBeGreaterThanOrEqual(5);
    const row = db.$client.prepare("SELECT password_hash h FROM users").get() as { h: string };
    expect(verifyPassword("pw12345678", row.h)).toBe(true);
  });
});

describe("companies + people", () => {
  it("creates, lists, filters, updates with version bump", () => {
    const company = ok(run(owner, "company.create", { name: "Acme", industry: "SaaS", country: "UK" }));
    expect(company.displayId).toBe(1);
    expect(company.version).toBe(1);

    const person = ok(
      run(owner, "person.create", { name: "Ada Lovelace", email: "ada@acme.io", companyId: company.id, title: "CTO" }),
    );
    expect(person.displayId).toBe(1);

    const links = ok(run(owner, "company.get", { id: company.id }));
    expect(links.people).toHaveLength(1);
    expect(links.people[0].person.name).toBe("Ada Lovelace");
    expect(links.people[0].isPrimary).toBe(true);

    const updated = ok(run(owner, "company.update", { id: company.id, hq: "London" }));
    expect(updated.version).toBe(2);

    const page = ok(run(owner, "company.list", { search: "acm" }));
    expect(page.total).toBe(1);

    const empty = ok(run(owner, "company.list", { search: "zzz" }));
    expect(empty.total).toBe(0);
  });

  it("enforces optimistic concurrency", () => {
    const company = ok(run(owner, "company.create", { name: "Acme" }));
    ok(run(owner, "company.update", { id: company.id, name: "Acme 2" }));
    const conflict = run(owner, "company.update", { id: company.id, name: "Acme 3", expectedVersion: 1 });
    expect(conflict.status).toBe("error");
    expect((conflict as any).error.code).toBe("version_conflict");
  });

  it("archive hides from lists; hard delete detaches references", () => {
    const company = ok(run(owner, "company.create", { name: "Acme" }));
    const engagement = ok(run(owner, "engagement.create", { companyId: company.id }));

    const archived = ok(run(owner, "company.archive", { id: company.id }));
    expect(archived.archivedAt).toBeTruthy();
    expect(ok(run(owner, "company.list", {})).total).toBe(0);
    expect(ok(run(owner, "company.list", { includeArchived: true })).total).toBe(1);

    ok(run(owner, "company.delete", { id: company.id }));
    expect(ok(run(owner, "company.list", { includeArchived: true })).total).toBe(0);
    const orphaned = ok(run(owner, "engagement.get", { id: engagement.id }));
    expect(orphaned.companyId).toBeNull();
  });
});

describe("engagements", () => {
  it("creates with defaults and moves stages with logged status changes", () => {
    const company = ok(run(owner, "company.create", { name: "Acme" }));
    const person = ok(run(owner, "person.create", { name: "Ada", companyId: company.id }));
    const engagement = ok(run(owner, "engagement.create", { companyId: company.id, personId: person.id, channel: "Email" }));
    expect(engagement.title).toContain("Ada");
    expect(engagement.displayId).toBe(1);

    const pipelines = ok(run(owner, "pipeline.list", { type: "engagement" }));
    const stage = pipelines[0].stages[2];
    const moved = ok(run(owner, "engagement.updateStage", { id: engagement.id, stageId: stage.id, note: "replied!" }));
    expect(moved.stageId).toBe(stage.id);

    const activities = ok(run(owner, "activity.list", { engagementId: engagement.id }));
    const statusChange = activities.items.find((a: any) => a.kind === "status_change");
    expect(statusChange).toBeTruthy();
    expect(statusChange.meta.toStageId).toBe(stage.id);
    // Note text captured on the status change activity
    expect(statusChange.body).toBe("replied!");
  });

  it("logging an activity bumps lastActivityAt", () => {
    const engagement = ok(run(owner, "engagement.create", { title: "Test lead" }));
    expect(engagement.lastActivityAt).toBeNull();
    ok(run(owner, "activity.log", { kind: "note", body: "called them", engagementId: engagement.id }));
    const after = ok(run(owner, "engagement.getContext", { id: engagement.id }));
    expect(after.engagement.lastActivityAt).toBeTruthy();
    expect(after.recentActivities).toHaveLength(1);
  });
});

describe("deals", () => {
  it("full lifecycle: create → stage moves → won with closedAt", () => {
    const company = ok(run(owner, "company.create", { name: "Acme" }));
    const deal = ok(
      run(owner, "deal.create", { title: "Acme pentest", companyId: company.id, amountMinor: 500000, currency: "USD" }),
    );
    expect(deal.status).toBe("open");
    expect(deal.probability).toBeGreaterThanOrEqual(0);

    const won = ok(run(owner, "deal.markWon", { id: deal.id, note: "signed!" }));
    expect(won.status).toBe("won");
    expect(won.closedAt).toBeTruthy();
    expect(won.probability).toBe(100);

    const stats = ok(run(owner, "stats.deals", {}));
    const wonStage = stats.stages.find((s: any) => s.outcome === "won");
    expect(wonStage.count).toBe(1);
    expect(wonStage.amountMinorByCurrency.USD).toBe(500000);
  });

  it("stakeholders", () => {
    const deal = ok(run(owner, "deal.create", { title: "D1" }));
    const person = ok(run(owner, "person.create", { name: "Buyer Bob" }));
    ok(run(owner, "deal.addStakeholder", { dealId: deal.id, personId: person.id, role: "champion", isPrimary: true }));
    const detail = ok(run(owner, "deal.get", { id: deal.id }));
    expect(detail.stakeholders).toHaveLength(1);
    expect(detail.stakeholders[0].person.name).toBe("Buyer Bob");
  });
});

describe("tasks", () => {
  it("create, complete, and home stats overdue bucket", () => {
    const task = ok(run(owner, "task.create", { title: "Follow up", dueAt: "2020-01-01" }));
    expect(task.displayId).toBe(1);

    const home = ok(run(owner, "stats.home"));
    expect(home.overdueTasks.some((t: any) => t.id === task.id)).toBe(true);

    const done = ok(run(owner, "task.complete", { id: task.id }));
    expect(done.completedAt).toBeTruthy();

    const homeAfter = ok(run(owner, "stats.home"));
    expect(homeAfter.overdueTasks.some((t: any) => t.id === task.id)).toBe(false);
  });
});

describe("tags + custom fields + saved views", () => {
  it("tag lifecycle and filtering", () => {
    const tag = ok(run(owner, "tag.create", { name: "hot", color: "error" }));
    const company = ok(run(owner, "company.create", { name: "Acme" }));
    ok(run(owner, "tag.apply", { tagId: tag.id, entityType: "company", entityId: company.id }));
    const filtered = ok(run(owner, "company.list", { tagIds: [tag.id] }));
    expect(filtered.total).toBe(1);
    const none = ok(run(owner, "company.list", { tagIds: [tag.id === "x" ? "y" : "00000000-0000-7000-8000-000000000000"] }));
    expect(none.total).toBe(0);
  });

  it("custom field def + validated values", () => {
    const def = ok(
      run(owner, "customField.create", {
        entityType: "engagement",
        label: "Confidence",
        type: "select",
        options: ["High", "Medium", "Low"],
      }),
    );
    expect(def.key).toBe("confidence");
    const engagement = ok(run(owner, "engagement.create", { title: "L1" }));
    ok(run(owner, "customField.setValues", { entityType: "engagement", entityId: engagement.id, values: { confidence: "High" } }));
    const detail = ok(run(owner, "engagement.get", { id: engagement.id }));
    expect(detail.customFields.confidence).toBe("High");

    const bad = run(owner, "customField.setValues", {
      entityType: "engagement",
      entityId: engagement.id,
      values: { confidence: "Extreme" },
    });
    expect(bad.status).toBe("error");
    expect((bad as any).error.code).toBe("validation");
  });

  it("saved views", () => {
    const view = ok(run(owner, "savedView.create", { name: "UK leads", entityType: "engagement", filters: { search: "uk" } }));
    const list = ok(run(owner, "savedView.list", {}));
    expect(list.some((v: any) => v.id === view.id)).toBe(true);
  });
});

describe("contact lists", () => {
  it("full lifecycle: create, add members, filter, counts, remove, delete", () => {
    const list = ok(run(owner, "list.create", { name: "Job search", color: "info", description: "Recruiters & hiring managers" }));
    const dupe = ok(run(owner, "list.create", { name: "job search" }));
    expect(dupe.id).toBe(list.id); // name-idempotent

    const acme = ok(run(owner, "company.create", { name: "Acme" }));
    const p1 = ok(run(owner, "person.create", { name: "Recruiter One" }));
    const p2 = ok(run(owner, "person.create", { name: "Recruiter Two" }));
    const outsider = ok(run(owner, "person.create", { name: "Prospect" }));

    const added = ok(run(owner, "list.addMembers", { listId: list.id, entityType: "person", entityIds: [p1.id, p2.id] }));
    expect(added.added).toBe(2);
    const again = ok(run(owner, "list.addMembers", { listId: list.id, entityType: "person", entityIds: [p1.id] }));
    expect(again.added).toBe(0);
    expect(again.alreadyPresent).toBe(1);
    ok(run(owner, "list.addMembers", { listId: list.id, entityType: "company", entityIds: [acme.id] }));

    // Counts on the index op (dashboard surface).
    const lists = ok(run(owner, "list.list", {}));
    const found = lists.find((l: any) => l.id === list.id);
    expect(found.people).toBe(2);
    expect(found.companies).toBe(1);

    // person.list filter — the MCP-visible "who's in my job-search list" query.
    const filtered = ok(run(owner, "person.list", { listId: list.id }));
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((p: any) => p.id)).not.toContain(outsider.id);

    // Combined members op.
    const members = ok(run(owner, "list.members", { id: list.id }));
    expect(members.people.total).toBe(2);
    expect(members.companies.total).toBe(1);

    const removed = ok(run(owner, "list.removeMembers", { listId: list.id, entityType: "person", entityIds: [p2.id] }));
    expect(removed.removed).toBe(1);
    expect(ok(run(owner, "person.list", { listId: list.id })).total).toBe(1);

    const lead = ok(run(owner, "engagement.create", { title: "Campaign lead" }));
    ok(run(owner, "list.addMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));
    const listsAfterLead = ok(run(owner, "list.list", {}));
    expect(listsAfterLead.find((l: any) => l.id === list.id).engagements).toBe(1);
    expect(ok(run(owner, "engagement.list", { listId: list.id })).total).toBe(1);
    const membersWithLead = ok(run(owner, "list.members", { id: list.id }));
    expect(membersWithLead.engagements.total).toBe(1);
    ok(run(owner, "list.removeMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));

    const deal = ok(run(owner, "deal.create", { title: "Campaign deal" }));
    ok(run(owner, "list.addMembers", { listId: list.id, entityType: "deal", entityIds: [deal.id] }));
    expect(ok(run(owner, "list.list", {})).find((l: any) => l.id === list.id).deals).toBe(1);

    ok(run(owner, "list.delete", { id: list.id }));
    expect(ok(run(owner, "list.list", {})).length).toBe(0);
    // Members detached, contacts untouched.
    expect(ok(run(owner, "person.get", { id: p1.id })).id).toBe(p1.id);
  });

  it("rejects unknown member ids and is agent-writable without approval", () => {
    const list = ok(run(owner, "list.create", { name: "Product X" }));
    const bad = run(owner, "list.addMembers", {
      listId: list.id,
      entityType: "person",
      entityIds: ["00000000-0000-7000-8000-000000000000"],
    });
    expect(bad.status).toBe("error");

    // Low-trust agent can still manage membership (reversible metadata).
    const person = ok(run(owner, "person.create", { name: "Agent Target" }));
    const viaAgent = run(agentCtx(), "list.addMembers", { listId: list.id, entityType: "person", entityIds: [person.id] });
    expect(viaAgent.status).toBe("ok");
    // …but deleting the list is config-gated for agents: routed to approvals.
    const del = run(agentCtx(), "list.delete", { id: list.id });
    expect(del.status).toBe("pending_approval");
  });

  it("typed list rejects mismatched members and retyping with conflicts", () => {
    const typed = ok(run(owner, "list.create", { name: "Leads only", entityType: "engagement" }));
    const person = ok(run(owner, "person.create", { name: "Wrong type" }));
    const bad = run(owner, "list.addMembers", { listId: typed.id, entityType: "person", entityIds: [person.id] });
    expect(bad.status).toBe("error");
    expect((bad as any).error.message).toContain("holds");

    const mixed = ok(run(owner, "list.create", { name: "Mixed audience" }));
    const lead = ok(run(owner, "engagement.create", { title: "One" }));
    ok(run(owner, "list.addMembers", { listId: mixed.id, entityType: "person", entityIds: [person.id] }));
    ok(run(owner, "list.addMembers", { listId: mixed.id, entityType: "engagement", entityIds: [lead.id] }));

    const retypeFail = run(owner, "list.update", { id: mixed.id, entityType: "deal" });
    expect(retypeFail.status).toBe("error");
    ok(run(owner, "list.removeMembers", { listId: mixed.id, entityType: "person", entityIds: [person.id] }));
    ok(run(owner, "list.removeMembers", { listId: mixed.id, entityType: "engagement", entityIds: [lead.id] }));
    ok(run(owner, "list.update", { id: mixed.id, entityType: "deal" }));
  });

  it("rejects create when same name exists with incompatible entity type", () => {
    ok(run(owner, "list.create", { name: "Pipeline focus", entityType: "person" }));
    const clash = run(owner, "list.create", { name: "pipeline focus", entityType: "deal" });
    expect(clash.status).toBe("error");
    expect((clash as any).error.message).toContain("already exists");
    // Untyped request can reuse a typed list of the same holding type via name match — N/A here.
    // Mixed name match against typed person list is OK (mixed can hold people).
    const mixed = ok(run(owner, "list.create", { name: "Pipeline focus" }));
    expect(mixed.entityType).toBe("person");
  });

  it("hard-deleting a listed lead clears list membership counts", () => {
    const list = ok(run(owner, "list.create", { name: "Delete cleanup", entityType: "engagement" }));
    const lead = ok(run(owner, "engagement.create", { title: "Gone" }));
    ok(run(owner, "list.addMembers", { listId: list.id, entityType: "engagement", entityIds: [lead.id] }));
    expect(ok(run(owner, "list.list", {})).find((l: any) => l.id === list.id).engagements).toBe(1);
    ok(run(owner, "engagement.delete", { id: lead.id }));
    expect(ok(run(owner, "list.list", {})).find((l: any) => l.id === list.id).engagements).toBe(0);
  });
});

describe("offerings", () => {
  it("create links offering; convert carries links; unknown offering is atomic", () => {
    const offering = ok(run(owner, "offering.create", { name: "Product X", type: "product" }));
    const before = ok(run(owner, "engagement.list", {})).total;
    const lead = ok(run(owner, "engagement.create", { title: "Pitch", offeringId: offering.id }));
    expect(ok(run(owner, "engagement.list", {})).total).toBe(before + 1);
    const ctx = ok(run(owner, "engagement.getContext", { id: lead.id }));
    expect(ctx.offerings).toHaveLength(1);
    expect(ctx.offerings[0].isPrimary).toBe(true);
    expect(ok(run(owner, "engagement.list", { offeringId: offering.id })).total).toBe(1);

    const deal = ok(run(owner, "deal.create", { title: "Product X deal", engagementId: lead.id }));
    const dealCtx = ok(run(owner, "deal.getContext", { id: deal.id }));
    expect(dealCtx.offerings).toHaveLength(1);
    expect(dealCtx.offerings[0].offeringId).toBe(offering.id);

    const beforeBad = ok(run(owner, "engagement.list", {})).total;
    const bad = run(owner, "engagement.create", { title: "Nope", offeringId: "00000000-0000-7000-8000-000000000000" });
    expect(bad.status).toBe("error");
    expect((bad as any).error.code).toBe("not_found");
    expect(ok(run(owner, "engagement.list", {})).total).toBe(beforeBad);
  });
});

describe("authorization + approval gating", () => {
  it("agent without scope is forbidden", () => {
    const readOnly = agentCtx({ scopes: ["read"] });
    const result = run(readOnly, "company.create", { name: "Nope" });
    expect(result.status).toBe("error");
    expect((result as any).error.code).toBe("forbidden");
  });

  it("agent read works", () => {
    ok(run(owner, "company.create", { name: "Acme" }));
    const page = ok(run(agentCtx(), "company.list", {}));
    expect(page.total).toBe(1);
  });

  it("risky op from low-trust agent creates pending action; approval executes it", () => {
    const company = ok(run(owner, "company.create", { name: "Doomed Inc" }));
    const agent = agentCtx();

    const result = run(agent, "company.delete", { id: company.id });
    expect(result.status).toBe("pending_approval");
    const pendingId = (result as any).pendingActionId;

    // Still exists
    expect(ok(run(owner, "company.list", {})).total).toBe(1);

    // Approve as owner → executes delete
    const approval = ok(run(owner, "pendingAction.approve", { id: pendingId }));
    expect(approval.pendingAction.status).toBe("approved");
    expect(ok(run(owner, "company.list", {})).total).toBe(0);

    // Audit trail captured both the request and the approval
    const audit = ok(run(owner, "audit.list", {}));
    const ops = audit.items.map((e: any) => e.operation);
    expect(ops).toContain("pendingAction.create");
    expect(ops).toContain("pendingAction.approve");
  });

  it("trusted agent executes bulk ops directly, low-trust agent needs approval", () => {
    const c1 = ok(run(owner, "company.create", { name: "A" }));
    const c2 = ok(run(owner, "company.create", { name: "B" }));
    const trusted = agentCtx({ trust: "trusted_agent" });
    const result = ok(run(trusted, "bulk.archive", { entityType: "company", ids: [c1.id, c2.id] }));
    expect(result.updated).toBe(2);

    const lowTrust = agentCtx();
    const gated = run(lowTrust, "bulk.archive", { entityType: "company", ids: [c1.id] });
    expect(gated.status).toBe("pending_approval");
  });

  it("reject leaves target untouched", () => {
    const company = ok(run(owner, "company.create", { name: "Safe Inc" }));
    const gated = run(agentCtx(), "company.delete", { id: company.id });
    const pendingId = (gated as any).pendingActionId;
    ok(run(owner, "pendingAction.reject", { id: pendingId, note: "no way" }));
    expect(ok(run(owner, "company.list", {})).total).toBe(1);
    const pa = ok(run(owner, "pendingAction.get", { id: pendingId }));
    expect(pa.status).toBe("rejected");
  });

  it("viewer cannot write", () => {
    const viewer: RequestContext = { ...owner, role: "viewer" };
    const result = run(viewer, "company.create", { name: "Nope" });
    expect(result.status).toBe("error");
    expect((result as any).error.code).toBe("forbidden");
  });
});

describe("pipelines", () => {
  it("stage delete blocked while in use", () => {
    const pipelines = ok(run(owner, "pipeline.list", { type: "engagement" }));
    const stage = pipelines[0].stages[0];
    ok(run(owner, "engagement.create", { title: "L1" }));
    const del = run(owner, "stage.delete", { id: stage.id });
    expect(del.status).toBe("error");
    expect((del as any).error.code).toBe("in_use");
  });

  it("create custom pipeline and reorder stages", () => {
    const pipeline = ok(
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
    ok(run(owner, "stage.reorder", { pipelineId: pipeline.id, stageIds: reversed }));
    const after = ok(run(owner, "pipeline.list", { type: "engagement" })).find((p: any) => p.id === pipeline.id);
    expect(after.stages.map((s: any) => s.id)).toEqual(reversed);
  });
});

describe("search + import/export", () => {
  it("global search hits companies and people", () => {
    ok(run(owner, "company.create", { name: "Acme Rockets" }));
    ok(run(owner, "person.create", { name: "Wile E Coyote" }));
    const hits = ok(run(owner, "search.global", { query: "acme" }));
    expect(hits.some((h: any) => h.entityType === "company")).toBe(true);
    const personHits = ok(run(owner, "search.global", { query: "coyote" }));
    expect(personHits.some((h: any) => h.entityType === "person")).toBe(true);
  });

  it("CSV import (preview + run) then export", () => {
    const csv = "Company,Contact,Title,Email,Channel\nAcme,Ada Lovelace,CTO,ada@acme.io,Email\nBeta Corp,Bob,CEO,bob@beta.co,LinkedIn\n";
    const preview = ok(run(owner, "import.preview", { csv }));
    expect(preview.importableRows).toBe(2);
    expect(preview.newCompanies).toBe(2);

    const result = ok(run(owner, "import.run", { csv, sourceLabel: "test-batch" }));
    expect(result.companiesCreated).toBe(2);
    expect(result.engagementsCreated).toBe(2);

    // Re-import dedupes companies
    const again = ok(run(owner, "import.run", { csv, sourceLabel: "test-batch" }));
    expect(again.companiesCreated).toBe(0);
    expect(again.companiesMatched).toBe(2);

    const exported = ok(run(owner, "export.csv", { entityType: "company" }));
    expect(exported.rowCount).toBe(2);
    expect(exported.csv).toContain("Acme");
  });
});

describe("admin", () => {
  it("user create/update, password reset, mcp client lifecycle", () => {
    const created = ok(run(owner, "user.create", { name: "Sam", email: "sam@example.com", role: "member" }));
    expect(created.oneTimePassword).toBeTruthy();
    expect(created.user.role).toBe("member");

    const updated = ok(run(owner, "user.update", { id: created.user.id, role: "admin" }));
    expect(updated.role).toBe("admin");

    const client = ok(run(owner, "mcpClient.create", { name: "Claude", scopes: ["read", "write"], trust: "trusted_agent" }));
    expect(client.token).toMatch(/^emcp_/);

    const revoked = ok(run(owner, "mcpClient.revoke", { id: client.client.id }));
    expect(revoked.revokedAt).toBeTruthy();
  });

  it("member cannot run admin-only ops", () => {
    const member: RequestContext = { ...owner, role: "member" };
    const result = run(member, "user.list", {});
    expect(result.status).toBe("ok"); // viewer-level
    const clients = run(member, "mcpClient.list", {});
    expect(clients.status).toBe("ok");
    const forbidden = run(member, "audit.list", {});
    expect(forbidden.status).toBe("error");
  });
});

describe("agent authority mirrors the owning user", () => {
  function humanCtx(userId: string, role: RequestContext["role"]): RequestContext {
    return { ...owner, userId, role };
  }

  function createUser(role: "member" | "admin"): RequestContext {
    const created = ok(run(owner, "user.create", { name: `u-${role}`, email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role }));
    return humanCtx(created.user.id, role);
  }

  it("caps grantable scopes by the creator's role", () => {
    const member = createUser("member");
    const denied = run(member, "mcpClient.create", { name: "Escalator", scopes: ["read", "write", "admin"] });
    expect(denied.status).toBe("error");
    expect((denied as any).error.code).toBe("forbidden");

    const allowed = run(member, "mcpClient.create", { name: "Helper", scopes: ["read", "write", "approvals"] });
    expect(allowed.status).toBe("ok");

    const full = run(owner, "mcpClient.create", { name: "Ops bot", scopes: ["read", "write", "admin", "approvals"] });
    expect(full.status).toBe("ok");
  });

  it("members only see and manage their own clients; updates respect the owner's cap", () => {
    const member = createUser("member");
    const ownerClient = ok(run(owner, "mcpClient.create", { name: "Owner bot", scopes: ["read", "write", "admin"] }));
    const memberClient = ok(run(member, "mcpClient.create", { name: "Member bot", scopes: ["read", "write"] }));

    const memberList = ok<any[]>(run(member, "mcpClient.list", {}));
    expect(memberList.map((c) => c.id)).toEqual([memberClient.client.id]);
    expect(ok<any[]>(run(owner, "mcpClient.list", {})).length).toBe(2);

    expect(run(member, "mcpClient.revoke", { id: ownerClient.client.id }).status).toBe("error");
    expect(run(member, "mcpClient.update", { id: ownerClient.client.id, name: "hijacked" }).status).toBe("error");
    expect(run(member, "mcpClient.update", { id: memberClient.client.id, scopes: ["read", "write", "admin"] }).status).toBe("error");

    // Admins manage anyone's client but cannot push scopes past the owner's role.
    expect(run(owner, "mcpClient.update", { id: memberClient.client.id, name: "renamed" }).status).toBe("ok");
    expect(run(owner, "mcpClient.update", { id: memberClient.client.id, scopes: ["read", "admin"] }).status).toBe("error");
  });

  it("resolves tokens with the creator's current role and clamps scopes on demotion; disabled creator kills the key", () => {
    const admin = createUser("admin");
    const created = ok(run(admin, "mcpClient.create", { name: "Admin bot", scopes: ["read", "write", "admin", "approvals"] }));

    let resolved = resolveMcpToken(db, created.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.role).toBe("admin");
    expect(resolved!.userId).toBe(admin.userId);
    expect(resolved!.scopes).toContain("admin");

    ok(run(owner, "user.update", { id: admin.userId!, role: "member" }));
    resolved = resolveMcpToken(db, created.token);
    expect(resolved!.role).toBe("member");
    expect(resolved!.scopes.sort()).toEqual(["approvals", "read", "write"]);

    ok(run(owner, "user.update", { id: admin.userId!, disabled: true }));
    expect(resolveMcpToken(db, created.token)).toBeNull();
  });

  it("an agent cannot approve its own pending actions", () => {
    const company = ok(run(owner, "company.create", { name: "Doomed Co" }));
    const requester = agentCtx({ clientId: "client-self", scopes: ["read", "write"] });
    const pending = run(requester, "company.delete", { id: company.id });
    expect(pending.status).toBe("pending_approval");
    const paId = (pending as any).pendingActionId;

    const sameClientElevated = agentCtx({ clientId: "client-self", role: "admin", scopes: ["read", "write", "admin", "approvals"] });
    const selfApprove = run(sameClientElevated, "pendingAction.approve", { id: paId });
    expect(selfApprove.status).toBe("error");
    expect((selfApprove as any).error.code).toBe("forbidden");

    expect(run(owner, "pendingAction.approve", { id: paId }).status).toBe("ok");
  });
});

describe("multi-workspace isolation", () => {
  it("second workspace sees nothing from the first", () => {
    ok(run(owner, "company.create", { name: "WS1 Co" }));

    // Manually create a second workspace + ports
    const now = new Date().toISOString();
    db.$client
      .prepare("INSERT INTO workspaces (id, name, default_currency, timezone, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("ws2", "Other", "USD", "UTC", "{}", now, now);
    const ports2 = createPorts(db, "ws2");
    const ctx2: RequestContext = { ...owner, workspaceId: "ws2" };
    const result = runOperation(catalog, ports2, ctx2, "company.list", {});
    expect((result as any).data.total).toBe(0);
  });
});
