import { expect } from "vitest";
import {
  newId, systemContext,
  type ActorStamp, type OpResult, type Ports, type RequestContext,
} from "@mcpsuite/core";

export const SQL_TEXT = /select|insert|update|delete|violates|constraint|relation|column|syntax|\bSQL\b|duplicate key/i;
export const actor = (userId: string): ActorStamp => ({ actorType: "human", actorUserId: userId, actorClientId: null, surface: "web" });
export const context = (workspaceId: string, userId: string): RequestContext => ({
  ...systemContext(workspaceId), actorType: "human", userId, surface: "web",
});

/** Deliberately different labels, values and counts make cross-workspace aggregates visible. */
export async function seed(ports: Ports, label: "Alpha" | "Beta") {
  const user = await ports.users.create({ name: `${label} owner`, email: `${newId()}@${label}.test`, role: "owner", passwordHash: null });
  const pipeline = async (type: "engagement" | "deal") => ports.pipelines.create({
    type, name: `${label} ${type}`, isDefault: true,
    stages: [{ name: `${label} new`, color: "info", probability: 10 }, { name: `${label} won`, color: "success", probability: 100, outcome: "won" }, { name: `${label} lost`, color: "error", outcome: "lost" }],
  });
  const engagementPipeline = await pipeline("engagement");
  const dealPipeline = await pipeline("deal");
  const company = await ports.companies.create({ name: `${label} company`, ownerUserId: user.id });
  const person = await ports.people.create({ name: `${label} person`, email: `${label}@person.test`, ownerUserId: user.id });
  await ports.people.link({ companyId: company.id, personId: person.id, isPrimary: true });
  const engagement = await ports.engagements.create({ title: `${label} engagement`, companyId: company.id, personId: person.id, pipelineId: engagementPipeline.id, stageId: engagementPipeline.stages[0]!.id, ownerUserId: user.id });
  const deal = await ports.deals.create({ title: `${label} deal`, companyId: company.id, primaryPersonId: person.id, engagementId: engagement.id, pipelineId: dealPipeline.id, stageId: dealPipeline.stages[0]!.id, currency: "USD", amountMinor: label === "Alpha" ? 100 : 900, ownerUserId: user.id });
  const stakeholder = await ports.deals.addStakeholder({ dealId: deal.id, personId: person.id });
  const offering = await ports.offerings.create({ name: `${label} offering`, type: "service", ownerUserId: user.id });
  await ports.offerings.link({ offeringId: offering.id, entityType: "deal", entityId: deal.id, isPrimary: true });
  const tag = await ports.tags.create({ name: `${label} tag`, color: "info" });
  await ports.tags.apply(tag.id, "company", company.id);
  const list = await ports.lists.create({ name: `${label} list`, color: "info" });
  for (const [entityType, entityId] of [["company", company.id], ["person", person.id], ["engagement", engagement.id], ["deal", deal.id]] as const) {
    await ports.lists.addMembers(list.id, entityType, [entityId]);
  }
  const field = await ports.customFields.createDef({ entityType: "company", key: `${label.toLowerCase()}-field`, label: `${label} field`, type: "text", required: false, options: null });
  await ports.customFields.setValue(field.id, "company", company.id, `${label} value`);
  const task = await ports.activities.create({ kind: "task", title: `${label} task`, companyId: company.id, personId: person.id, engagementId: engagement.id, dealId: deal.id, assigneeUserId: user.id, dueAt: "2020-01-01" }, actor(user.id));
  const view = await ports.savedViews.create({ name: `${label} view`, entityType: "company", filters: {}, visibility: "shared", ownerUserId: user.id });
  const client = await ports.mcpClients.create({ name: `${label} client`, tokenHash: newId(), tokenPrefix: "test", scopes: ["read", "write", "approvals"], trust: "review_risky_actions", createdByUserId: user.id });
  const pending = await ports.pendingActions.create({ operation: "company.delete", input: { id: company.id }, preview: null, riskCategory: "destructive", actor: actor(user.id), expiresAt: "2099-01-01T00:00:00.000Z" });
  await ports.audit.record({ operation: "company.create", entityType: "company", entityId: company.id, summary: `${label} audit` }, actor(user.id));
  if (label === "Beta") {
    await ports.companies.create({ name: "Beta extra company" });
    await ports.people.create({ name: "Beta extra person" });
    await ports.deals.create({ title: "Beta extra deal", currency: "USD", amountMinor: 9000, pipelineId: dealPipeline.id, stageId: dealPipeline.stages[0]!.id });
  }
  return { user, company, person, engagementPipeline, dealPipeline, engagement, deal, stakeholder, offering, tag, list, field, task, view, client, pending };
}
export type Seed = Awaited<ReturnType<typeof seed>>;
type Input = Record<string, unknown>;
export interface CaseContext {
  A: Seed;
  B: Seed;
  ports: Ports;
  run(name: string, input?: unknown, ctx?: RequestContext): Promise<OpResult>;
  snapshotB(): Promise<string>;
  setViewFilters(viewId: string, filters: Record<string, unknown>): Promise<void>;
  owner: RequestContext;
  adapter: "sqlite" | "postgres";
}
export interface Attack { id: string; input(id: string): Input }
export interface IsolationCase {
  reads?: (a: Seed) => Input[];
  attacks?: (a: Seed, b: Seed) => Attack[];
  check?: (ctx: CaseContext, name: string) => Promise<void>;
}

export function ok(result: OpResult): any {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return result.data;
}

/** Replace only the supplied attack ID, including IDs embedded in messages and object keys. */
export function normalizeId(value: unknown, id: string): unknown {
  return JSON.parse(JSON.stringify(value).split(id).join("<target-id>"));
}
export function safePayload(result: OpResult): OpResult {
  expect(result.status).not.toBe("pending_approval");
  if (result.status === "error") {
    expect(result.error.message).not.toMatch(SQL_TEXT);
    // runOperation has already serialized the thrown error with toErrorPayload.
    expect(result.error.code).toBeTruthy();
  }
  return result;
}
export async function indistinguishable(ctx: CaseContext, name: string, attack: Attack) {
  const random = newId();
  const before = await ctx.snapshotB();
  const foreign = safePayload(await ctx.run(name, attack.input(attack.id)));
  expect(await ctx.snapshotB(), `${name}: B changed after foreign ID`).toBe(before);
  if (foreign.status === "ok") {
    noVictimData(normalizeId(foreign.data, attack.id), ctx.B);
    if (foreign.data && typeof foreign.data === "object" && "items" in foreign.data) {
      expect(foreign.data).toMatchObject({ items: [], total: 0 });
    }
  }
  const absent = safePayload(await ctx.run(name, attack.input(random)));
  expect(await ctx.snapshotB(), `${name}: B changed after random ID`).toBe(before);
  expect(normalizeId(foreign, attack.id), `${name}: foreign and absent outcomes differ`).toEqual(normalizeId(absent, random));
}
export function noVictimData(result: unknown, b: Seed) {
  const text = JSON.stringify(result);
  // Filter inputs echoed by savedView.run are checked separately from its result rows.
  expect(text).not.toContain("Beta");
  const ids = JSON.stringify(b).match(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? [];
  for (const id of ids) expect(text).not.toContain(id);
}
const read = (...inputs: Input[]): IsolationCase => ({ reads: () => inputs.length ? inputs : [{}] });
type Target = "user" | "company" | "person" | "engagement" | "deal" | "stakeholder" | "offering" | "tag" | "list" | "field" | "task" | "view" | "client" | "pending" | "engagementPipeline" | "dealPipeline";
const primary = (target: Target, extra: Input = {}): IsolationCase => ({
  attacks: (_a, b) => [{ id: b[target].id, input: (id) => ({ ...extra, id }) }],
});
const relations = (base: (a: Seed) => Input, fields: Record<string, Target | "stage">): IsolationCase => ({
  attacks: (a, b) => Object.entries(fields).map(([key, target]) => ({
    id: target === "stage" ? b.engagementPipeline.stages[0]!.id : b[target].id,
    input: (id) => ({ ...base(a), [key]: id }),
  })),
});
const combine = (...cases: IsolationCase[]): IsolationCase => ({
  attacks: (a, b) => cases.flatMap((c) => c.attacks?.(a, b) ?? []),
});
const update = (target: Target, fields: Record<string, Target>, extra: Input = {}): IsolationCase => combine(
  primary(target, extra), relations((a) => ({ id: a[target].id, ...extra }), fields),
);
const create = (input: Input, relationships: Record<string, Target | "stage"> = {}): IsolationCase => ({
  ...relations(() => input, relationships),
  check: async (ctx, name) => {
    const before = await ctx.snapshotB();
    const data = ok(await ctx.run(name, input));
    noVictimData(data, ctx.B);
    expect(await ctx.snapshotB()).toBe(before);
  },
});
const idsAttack = (target: Target, base: (a: Seed) => Input, key = "ids"): IsolationCase => ({
  attacks: (a, b) => [{ id: b[target].id, input: (id) => ({ ...base(a), [key]: [id] }) }],
});
const listFilters = (fields: Record<string, Target | "stage">): IsolationCase => ({
  ...read(),
  attacks: (a, b) => [
    ...relations(() => ({}), fields).attacks!(a, b),
    { id: b.tag.id, input: (id) => ({ tagIds: [id] }) },
    { id: b.list.id, input: (id) => ({ listId: id }) },
  ],
});
const stageMutation = (target: "engagement" | "deal", extra: Input = {}): IsolationCase => combine(
  { attacks: (a, b) => [{ id: b[target].id, input: (id) => ({ id, stageId: a[`${target}Pipeline`].stages[1]!.id, ...extra }) }] },
  { attacks: (a, b) => [{ id: b[`${target}Pipeline`].stages[0]!.id, input: (id) => ({ id: a[target].id, stageId: id, ...extra }) }] },
);
const member = (): IsolationCase => combine(
  relations((a) => ({ listId: a.list.id, entityType: "person", entityIds: [a.person.id] }), { listId: "list" }),
  ...(["company", "person", "engagement", "deal"] as const).map((entityType) => idsAttack(entityType, (a) => ({ listId: a.list.id, entityType }), "entityIds")),
);
const offeringLink = (): IsolationCase => combine(...(["engagement", "deal"] as const).map((entityType) => relations((a) => ({ offeringId: a.offering.id, entityType, entityId: a[entityType].id }), { offeringId: "offering", entityId: entityType })));
const tagLink = (): IsolationCase => combine(...(["company", "person", "engagement", "deal"] as const).map((entityType) => relations((a) => ({ tagId: a.tag.id, entityType, entityId: a[entityType].id }), { tagId: "tag", entityId: entityType })));
const activityRelationships = { companyId: "company", personId: "person", engagementId: "engagement", dealId: "deal", assigneeUserId: "user" } as const;
const engagementRelationships = { companyId: "company", personId: "person", pipelineId: "engagementPipeline", stageId: "stage", ownerUserId: "user", offeringId: "offering" } as const;
const dealRelationships = { companyId: "company", primaryPersonId: "person", pipelineId: "dealPipeline", ownerUserId: "user", engagementId: "engagement", offeringId: "offering" } as const;

/** Explicit keys are intentional: deriving cases from the catalog would hide missing coverage. */
export const isolationCases = {
  "company.list": listFilters({ ownerUserId: "user" }),
  "company.get": { ...primary("company"), reads: (a) => [{ id: a.company.id }] },
  "company.create": create({ name: "Alpha new company" }, { ownerUserId: "user" }),
  "company.update": update("company", { ownerUserId: "user" }, { name: "Alpha edited" }),
  "company.archive": primary("company"),
  "company.restore": primary("company"),
  "company.delete": primary("company"),
  "company.linkPerson": relations((a) => ({ companyId: a.company.id, personId: a.person.id }), { companyId: "company", personId: "person" }),
  // Removing an absent company/person link succeeds without changing either workspace.
  "company.unlinkPerson": relations((a) => ({ companyId: a.company.id, personId: a.person.id }), { companyId: "company", personId: "person" }),
  "company.getContext": { ...primary("company"), reads: (a) => [{ id: a.company.id }] },
  "person.list": listFilters({ companyId: "company", ownerUserId: "user" }),
  "person.get": { ...primary("person"), reads: (a) => [{ id: a.person.id }] },
  "person.create": create({ name: "Alpha new person" }, { companyId: "company", ownerUserId: "user" }),
  "person.update": update("person", { ownerUserId: "user" }, { name: "Alpha edited" }),
  "person.archive": primary("person"),
  "person.restore": primary("person"),
  "person.delete": primary("person"),
  "person.getContext": { ...primary("person"), reads: (a) => [{ id: a.person.id }] },
  "engagement.list": listFilters({ companyId: "company", personId: "person", pipelineId: "engagementPipeline", stageId: "stage", ownerUserId: "user", offeringId: "offering" }),
  "engagement.get": { ...primary("engagement"), reads: (a) => [{ id: a.engagement.id }] },
  "engagement.create": create({ title: "Alpha new lead" }, engagementRelationships),
  "engagement.update": update("engagement", { companyId: "company", personId: "person", dealId: "deal", ownerUserId: "user" }, { title: "Alpha edited" }),
  "engagement.updateStage": stageMutation("engagement"),
  "engagement.archive": primary("engagement"),
  "engagement.restore": primary("engagement"),
  "engagement.delete": primary("engagement"),
  "engagement.getContext": { ...primary("engagement"), reads: (a) => [{ id: a.engagement.id }] },
  "deal.list": listFilters({ companyId: "company", personId: "person", pipelineId: "dealPipeline", stageId: "stage", ownerUserId: "user", offeringId: "offering" }),
  "deal.get": { ...primary("deal"), reads: (a) => [{ id: a.deal.id }] },
  "deal.create": create({ title: "Alpha new deal" }, { ...dealRelationships, stageId: "stage" }),
  "deal.update": update("deal", { companyId: "company", primaryPersonId: "person", engagementId: "engagement", ownerUserId: "user" }, { title: "Alpha edited" }),
  "deal.updateStage": stageMutation("deal"),
  "deal.markWon": primary("deal"),
  "deal.markLost": primary("deal"),
  "deal.reopen": primary("deal"),
  "deal.archive": primary("deal"),
  "deal.restore": primary("deal"),
  "deal.delete": primary("deal"),
  "deal.addStakeholder": relations((a) => ({ dealId: a.deal.id, personId: a.person.id }), { dealId: "deal", personId: "person" }),
  "deal.updateStakeholder": primary("stakeholder", { role: "Alpha edited" }),
  "deal.removeStakeholder": primary("stakeholder"),
  "deal.getContext": { ...primary("deal"), reads: (a) => [{ id: a.deal.id }] },
  "offering.list": read(),
  "offering.get": { ...primary("offering"), reads: (a) => [{ id: a.offering.id }] },
  "offering.create": create({ name: "Alpha new offering" }, { ownerUserId: "user" }),
  "offering.update": update("offering", { ownerUserId: "user" }, { name: "Alpha edited" }),
  "offering.archive": primary("offering"),
  "offering.restore": primary("offering"),
  "offering.delete": primary("offering"),
  "offering.link": offeringLink(),
  // Removing an absent offering link is an idempotent success.
  "offering.unlink": offeringLink(),
  "activity.list": { ...read(), ...relations(() => ({}), activityRelationships) },
  "activity.log": create({ kind: "task", title: "Alpha new activity" }, activityRelationships),
  "activity.update": update("task", { assigneeUserId: "user" }, { title: "Alpha edited" }),
  "activity.delete": primary("task"),
  "task.create": create({ title: "Alpha new task" }, activityRelationships),
  "task.complete": primary("task"),
  "task.reopen": primary("task"),
  "pipeline.list": read({}, { type: "deal" }, { type: "engagement" }),
  "pipeline.create": create({ name: "Alpha new pipeline", type: "deal", stages: [{ name: "First", color: "info" }] }),
  "pipeline.rename": primary("engagementPipeline", { name: "Alpha edited" }),
  "pipeline.setDefault": primary("engagementPipeline"),
  "pipeline.delete": primary("engagementPipeline"),
  "stage.add": relations(() => ({ name: "Alpha new stage", color: "info" }), { pipelineId: "engagementPipeline" }),
  "stage.update": { attacks: (_a, b) => [{ id: b.engagementPipeline.stages[0]!.id, input: (id) => ({ id, name: "Alpha edited" }) }] },
  // Foreign stages are ignored when applying a scoped stage order.
  "stage.reorder": { attacks: (a, b) => [
    { id: b.engagementPipeline.id, input: (id) => ({ pipelineId: id, stageIds: a.engagementPipeline.stages.map((s) => s.id) }) },
    { id: b.engagementPipeline.stages[0]!.id, input: (id) => ({ pipelineId: a.engagementPipeline.id, stageIds: [id, ...a.engagementPipeline.stages.slice(1).map((s) => s.id)] }) },
  ] },
  "stage.delete": { attacks: (_a, b) => [{ id: b.engagementPipeline.stages[0]!.id, input: (id) => ({ id }) }] },
  "tag.list": read(),
  "tag.create": create({ name: "Alpha new tag", color: "info" }),
  "tag.update": primary("tag", { name: "Alpha edited" }),
  "tag.delete": primary("tag"),
  // SQLite accepts absent tagging targets; both IDs must have the same outcome.
  "tag.apply": tagLink(),
  // Removing an absent tagging is an idempotent success.
  "tag.remove": tagLink(),
  "list.list": read(),
  "list.get": { ...primary("list"), reads: (a) => [{ id: a.list.id }] },
  "list.create": create({ name: "Alpha new list" }),
  "list.update": primary("list", { name: "Alpha edited" }),
  "list.delete": primary("list"),
  "list.addMembers": member(),
  // Removing absent list members returns zero; an absent list still fails.
  "list.removeMembers": member(),
  "list.members": { ...primary("list"), reads: (a) => [{ id: a.list.id }] },
  "customField.list": read(),
  "customField.create": create({ entityType: "company", label: "Alpha new field", type: "text" }),
  "customField.update": primary("field", { label: "Alpha edited" }),
  "customField.archive": primary("field"),
  "customField.restore": primary("field"),
  "customField.setValues": {
    attacks: (a, b) => [
      ...(["company", "person", "engagement", "deal", "offering"] as const).map((entityType) => ({ id: b[entityType].id, input: (id: string) => ({ entityType, entityId: id, values: { [a.field.key]: "Alpha changed" } }) })),
      { id: b.field.id, input: (id) => ({ entityType: "company", entityId: a.company.id, values: { [id]: "Alpha changed" } }) },
    ],
    check: async (ctx, name) => {
      const before = await ctx.snapshotB();
      const result = safePayload(await ctx.run(name, { entityType: "company", entityId: ctx.A.company.id, values: { [ctx.B.field.key]: "Hostile" } }));
      expect(result.status).toBe("error");
      expect(await ctx.snapshotB()).toBe(before);
    },
  },
  "savedView.list": read(),
  "savedView.create": create({ name: "Alpha new view", entityType: "company", filters: {} }),
  "savedView.update": primary("view", { name: "Alpha edited" }),
  "savedView.delete": primary("view"),
  "savedView.run": {
    ...primary("view"), reads: (a) => [{ id: a.view.id }],
    check: async (ctx, name) => {
      const hostileFilters: Array<{ entityType: "company" | "person" | "engagement" | "deal" | "activity"; id: string; filters(id: string): Input }> = [
        { entityType: "company", id: ctx.B.tag.id, filters: (id) => ({ tagIds: [id] }) },
        { entityType: "company", id: ctx.B.list.id, filters: (id) => ({ listId: id }) },
        { entityType: "person", id: ctx.B.company.id, filters: (id) => ({ companyId: id }) },
        { entityType: "engagement", id: ctx.B.engagementPipeline.id, filters: (id) => ({ pipelineId: id }) },
        { entityType: "engagement", id: ctx.B.engagementPipeline.stages[0]!.id, filters: (id) => ({ stageId: id }) },
        { entityType: "deal", id: ctx.B.offering.id, filters: (id) => ({ offeringId: id }) },
        { entityType: "activity", id: ctx.B.deal.id, filters: (id) => ({ dealId: id }) },
        // Unknown field filters are stripped by the existing filter schema; they cannot widen the search.
        { entityType: "company", id: ctx.B.field.id, filters: (id) => ({ fieldId: id, customFields: { [id]: "value" }, search: "Beta" }) },
        { entityType: "company", id: ctx.B.user.id, filters: (id) => ({ ownerUserId: id }) },
      ];
      for (const hostile of hostileFilters) {
        const view = await ctx.ports.savedViews.create({ name: "Alpha hostile view", entityType: hostile.entityType, filters: {}, visibility: "shared", ownerUserId: ctx.A.user.id });
        const random = newId();
        const before = await ctx.snapshotB();
        await ctx.setViewFilters(view.id, hostile.filters(hostile.id));
        const foreign = safePayload(await ctx.run(name, { id: view.id }));
        const rows = ok(foreign).result;
        expect(rows).toMatchObject({ items: [], total: 0 });
        noVictimData(rows, ctx.B);
        expect(await ctx.snapshotB()).toBe(before);
        await ctx.setViewFilters(view.id, hostile.filters(random));
        const absent = safePayload(await ctx.run(name, { id: view.id }));
        expect(normalizeId(foreign, hostile.id)).toEqual(normalizeId(absent, random));
        expect(await ctx.snapshotB()).toBe(before);
      }
    },
  },
  "pendingAction.list": read(),
  "pendingAction.get": { ...primary("pending"), reads: (a) => [{ id: a.pending.id }] },
  "pendingAction.getOwnTask": primary("pending"),
  "pendingAction.reject": primary("pending"),
  "pendingAction.cancel": primary("pending"),
  "pendingAction.cancelOwnTask": primary("pending"),
  "pendingAction.approve": {
    ...primary("pending"),
    check: async (ctx, name) => {
      for (const operation of ["company.delete", "company.linkPerson"] as const) {
        const runStored = async (id: string) => {
          const input = operation === "company.delete" ? { id } : { companyId: ctx.A.company.id, personId: id };
          const agent: RequestContext = { ...ctx.owner, actorType: "agent", clientId: ctx.A.client.id, trust: "review_risky_actions", surface: "mcp_http" };
          // Seed stored input explicitly: historic pending data need not have passed today's validation.
          const pending = await ctx.ports.pendingActions.create({ operation, input, preview: null, riskCategory: "destructive", actor: { ...actor(ctx.A.user.id), actorType: "agent", actorClientId: agent.clientId }, expiresAt: "2099-01-01T00:00:00.000Z" });
          return safePayload(await ctx.run(name, { id: pending.id }));
        };
        const foreignId = operation === "company.delete" ? ctx.B.company.id : ctx.B.person.id;
        const random = newId();
        const before = await ctx.snapshotB();
        const foreign = await runStored(foreignId);
        expect(foreign.status).toBe("error");
        expect(await ctx.snapshotB()).toBe(before);
        const absent = await runStored(random);
        expect(normalizeId(foreign, foreignId)).toEqual(normalizeId(absent, random));
        expect(await ctx.snapshotB()).toBe(before);
      }
      // Exercise the actual risk gate before approving both foreign and absent stored IDs.
      const approveGated = async (id: string) => {
        const pending = await ctx.run("company.delete", { id }, { ...ctx.owner, actorType: "agent", clientId: ctx.A.client.id, trust: "review_risky_actions", surface: "mcp_http" });
        expect(pending.status).toBe("pending_approval");
        if (pending.status !== "pending_approval") throw new Error("Expected approval gate");
        return safePayload(await ctx.run(name, { id: pending.pendingActionId }));
      };
      const before = await ctx.snapshotB();
      const random = newId();
      const foreign = await approveGated(ctx.B.company.id);
      expect(foreign.status).toBe("error");
      expect(await ctx.snapshotB()).toBe(before);
      const absent = await approveGated(random);
      expect(normalizeId(foreign, ctx.B.company.id)).toEqual(normalizeId(absent, random));
      expect(await ctx.snapshotB()).toBe(before);
    },
  },
  // Bulk stage moves skip absent record IDs and report them as skipped.
  "bulk.updateStage": combine(idsAttack("engagement", (a) => ({ entityType: "engagement", stageId: a.engagementPipeline.stages[1]!.id })), idsAttack("deal", (a) => ({ entityType: "deal", stageId: a.dealPipeline.stages[1]!.id })), relations((a) => ({ entityType: "engagement", ids: [a.engagement.id] }), { stageId: "stage" })),
  // Bulk owner assignment skips absent records; foreign owners still fail.
  "bulk.assignOwner": combine(...(["company", "person", "engagement", "deal"] as const).flatMap((entityType) => [idsAttack(entityType, (a) => ({ entityType, ownerUserId: a.user.id })), relations((a) => ({ entityType, ids: [a[entityType].id] }), { ownerUserId: "user" })])),
  // SQLite reports absent tagging targets as updated; compare the same count for both IDs.
  "bulk.addTag": combine(...(["company", "person", "engagement", "deal"] as const).flatMap((entityType) => [idsAttack(entityType, (a) => ({ entityType, tagId: a.tag.id })), relations((a) => ({ entityType, ids: [a[entityType].id] }), { tagId: "tag" })])),
  // Bulk archive skips absent records and reports them as skipped.
  "bulk.archive": combine(...(["company", "person", "engagement", "deal"] as const).map((entityType) => idsAttack(entityType, () => ({ entityType })))),
  "workspace.get": read(),
  "workspace.update": { check: async (ctx, name) => { const before = await ctx.snapshotB(); expect(ok(await ctx.run(name, { name: "Alpha edited workspace" })).name).toBe("Alpha edited workspace"); expect(await ctx.snapshotB()).toBe(before); } },
  "user.list": read(),
  "user.create": create({ name: "Alpha new member", email: "alpha-new@member.test", role: "member" }),
  "user.regenerateSetupCode": primary("user"),
  "user.update": primary("user", { name: "Alpha edited" }),
  "user.resetPassword": primary("user"),
  "user.delete": primary("user"),
  "user.transferOwnership": relations(() => ({}), { toUserId: "user" }),
  "mcpClient.list": read(),
  "mcpClient.create": create({ name: "Alpha new client" }),
  "mcpClient.update": primary("client", { name: "Alpha edited" }),
  "mcpClient.revoke": primary("client"),
  "audit.list": { ...read(), ...relations(() => ({}), { entityId: "company" }) },
  "search.global": read({ query: "a" }, { query: "Beta" }),
  "stats.home": read(),
  "stats.deals": { ...read(), ...relations(() => ({}), { pipelineId: "dealPipeline" }) },
  "stats.engagements": { ...read(), ...relations(() => ({}), { pipelineId: "engagementPipeline" }) },
  "import.preview": read({ csv: "company,name\nBeta company,Beta person" }),
  "import.run": {
    ...relations(() => ({ csv: "company,name\nAlpha imported,Alpha imported person" }), { pipelineId: "engagementPipeline", stageId: "stage", ownerUserId: "user" }),
    check: async (ctx, name) => {
      const before = await ctx.snapshotB();
      const result = ok(await ctx.run(name, { csv: "company,name\nBeta company,Beta person", sourceLabel: "Alpha import" }));
      expect(result.companiesCreated).toBe(1);
      expect(result.peopleCreated).toBe(1);
      expect(await ctx.snapshotB()).toBe(before);
    },
  },
  "export.csv": {
    reads: () => ["company", "person", "engagement", "deal", "activity"].map((entityType) => ({ entityType })),
    check: async (ctx, name) => {
      for (const entityType of ["company", "person", "engagement", "deal", "activity"]) {
        const result = ok(await ctx.run(name, { entityType }));
        expect(result.rowCount).toBe(1);
        noVictimData(result, ctx.B);
        expect(result.csv).toContain("Alpha");
      }
    },
  },
  "data.backup": { check: async (ctx, name) => {
    const before = await ctx.snapshotB();
    const result = safePayload(await ctx.run(name));
    // A physical backup must never give an actor a file containing another workspace.
    expect(result).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await ctx.snapshotB()).toBe(before);
  } },
} satisfies Record<string, IsolationCase>;

export type OperationName = keyof typeof isolationCases;
