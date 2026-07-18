/**
 * One-shot smoke test: exercises every page-facing operation as the owner,
 * including a full write round-trip on throwaway records. Run with
 * `pnpm --filter @emcp/db smoke` against the live DB — it cleans up after itself.
 */
import { eq } from "drizzle-orm";
import { createRuntime } from "../runtime.ts";
import { webContext } from "../auth.ts";
import { users, memberships } from "../schema.ts";

const runtime = createRuntime();
const membership = runtime.db.select().from(memberships).where(eq(memberships.role, "owner")).get();
if (!membership) throw new Error("no owner membership — run pnpm db:migrate first");
const owner = runtime.db.select().from(users).where(eq(users.id, membership.userId)).get();
if (!owner) throw new Error("owner user missing");
const ctx = webContext({
  user: { id: owner.id, email: owner.email, name: owner.name, role: membership.role as never, hasPassword: true, disabledAt: null, createdAt: owner.createdAt },
  workspaceId: membership.workspaceId,
  role: membership.role as never,
});

let pass = 0;
let fail = 0;
const failures: string[] = [];

function run(name: string, input: unknown = {}): unknown {
  const res = runtime.run(ctx, name, input);
  if (res.status === "ok") {
    pass++;
    return res.data;
  }
  fail++;
  failures.push(`${name}: ${JSON.stringify(res).slice(0, 300)}`);
  return null;
}

// Reads used by pages
const stats = run("stats.home") as Record<string, unknown>;
run("stats.engagements");
run("stats.deals");
const pipelines = run("pipeline.list") as Array<{ id: string; type: string; stages: Array<{ id: string }> }>;
run("user.list");
run("tag.list");
run("customField.list", { entityType: "company", includeArchived: false });
run("workspace.get");
run("pendingAction.list", { status: "pending" });
run("mcpClient.list");
run("audit.list", { limit: 10, offset: 0 });
run("search.global", { query: "a", limit: 10 });
run("savedView.list");
run("list.list");

const leads = run("engagement.list", { view: undefined, sort: "updatedAt", dir: "desc", limit: 25, offset: 0 }) as {
  items: Array<{ id: string; companyName: string | null }>;
  total: number;
};
const companies = run("company.list", { sort: "updatedAt", dir: "desc", limit: 25, offset: 0 }) as {
  items: Array<{ id: string; name: string }>;
  total: number;
};
const people = run("person.list", { sort: "updatedAt", dir: "desc", limit: 25, offset: 0 }) as {
  items: Array<{ id: string; primaryCompanyName: string | null }>;
  total: number;
};
const deals = run("deal.list", { sort: "updatedAt", dir: "desc", limit: 25, offset: 0 }) as { items: unknown[]; total: number };
run("activity.list", { limit: 25, offset: 0 });
run("activity.list", { kind: "task", open: true, limit: 25, offset: 0 });

// Detail bundles for first records
if (leads?.items[0]) run("engagement.getContext", { id: leads.items[0].id });
if (companies?.items[0]) run("company.getContext", { id: companies.items[0].id });
if (people?.items[0]) run("person.getContext", { id: people.items[0].id });

// Write path round-trip: create → edit → task → complete → archive → delete
const c = run("company.create", { name: `Smoke Test Co ${Date.now()}` }) as { id: string; version: number } | null;
if (c) {
  run("company.update", { id: c.id, industry: "Testing" });
  const p = run("person.create", { name: "Smoke Tester", companyId: c.id }) as { id: string } | null;
  const eng = pipelines?.find((x) => x.type === "engagement");
  const lead = eng
    ? (run("engagement.create", { title: "Smoke lead", companyId: c.id, personId: p?.id, pipelineId: eng.id }) as {
        id: string;
      } | null)
    : null;
  if (lead && eng) {
    run("engagement.updateStage", { id: lead.id, stageId: eng.stages[1]!.id });
    const task = run("activity.log", { kind: "task", title: "Smoke task", engagementId: lead.id }) as { id: string } | null;
    if (task) {
      run("task.complete", { id: task.id });
      run("task.reopen", { id: task.id });
      run("task.complete", { id: task.id });
    }
    run("activity.log", { kind: "note", body: "Smoke note", engagementId: lead.id });
    const typedList = run("list.create", { name: `Smoke Leads ${Date.now()}`, entityType: "engagement" }) as { id: string } | null;
    if (typedList) {
      run("list.addMembers", { listId: typedList.id, entityType: "engagement", entityIds: [lead.id] });
      run("engagement.list", { listId: typedList.id, limit: 5, offset: 0 });
      run("list.removeMembers", { listId: typedList.id, entityType: "engagement", entityIds: [lead.id] });
      run("list.delete", { id: typedList.id });
    }
    const offering = run("offering.create", { name: `Smoke Offering ${Date.now()}`, type: "product" }) as { id: string } | null;
    if (offering) {
      run("offering.link", { offeringId: offering.id, entityType: "engagement", entityId: lead.id, isPrimary: true });
      run("engagement.list", { offeringId: offering.id, limit: 5, offset: 0 });
      run("offering.unlink", { offeringId: offering.id, entityType: "engagement", entityId: lead.id });
      run("offering.delete", { id: offering.id });
    }
    const dp = pipelines?.find((x) => x.type === "deal");
    const deal = dp
      ? (run("deal.create", { title: "Smoke deal", companyId: c.id, engagementId: lead.id, amountMinor: 500000 }) as {
          id: string;
        } | null)
      : null;
    if (deal) {
      run("deal.getContext", { id: deal.id });
      run("deal.markWon", { id: deal.id });
      run("deal.reopen", { id: deal.id });
      run("deal.delete", { id: deal.id });
    }
    run("engagement.archive", { id: lead.id });
    run("engagement.restore", { id: lead.id });
    run("engagement.delete", { id: lead.id });
  }
  // Contact list round-trip on the throwaway person.
  const list = run("list.create", { name: `Smoke List ${Date.now()}` }) as { id: string } | null;
  if (list && p) {
    run("list.addMembers", { listId: list.id, entityType: "person", entityIds: [p.id] });
    run("person.list", { listId: list.id, limit: 5, offset: 0 });
    run("list.members", { id: list.id });
    run("list.removeMembers", { listId: list.id, entityType: "person", entityIds: [p.id] });
    run("list.delete", { id: list.id });
  }
  if (p) run("person.delete", { id: p.id });
  run("company.delete", { id: c.id });
}

console.log(`counts: leads=${leads?.total} companies=${companies?.total} people=${people?.total} deals=${deals?.total}`);
console.log(`lead[0].companyName=${leads?.items[0]?.companyName} person[0].primaryCompany=${people?.items[0]?.primaryCompanyName}`);
console.log(`pendingApprovals=${(stats as { pendingApprovals?: number })?.pendingApprovals}`);
console.log(`\nPASS=${pass} FAIL=${fail}`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(" -", f);
  process.exit(1);
}
