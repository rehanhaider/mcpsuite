/** Search, stats/attention bundles, CSV import/export, backup. */
import { z } from "zod";
import { OpError } from "../errors.ts";
import { nowIso, todayIso } from "../ids.ts";
import {
  zExportCsv,
  zImportPreview,
  zImportRun,
  zId,
  type HomeStats,
  type ImportTargetField,
} from "../domain.ts";
import { actorStamp } from "../context.ts";
import { defineOperation, type OpCtx } from "./define.ts";
import { audit } from "./helpers.ts";

// ---------------------------------------------------------------------------
// CSV helpers (tiny, dependency-free; import parsing is delegated to the
// adapter-provided parser to keep core free of IO deps)
// ---------------------------------------------------------------------------

export interface CsvServices {
  parse(csv: string): Array<Record<string, string>>;
  stringify(rows: Array<Record<string, unknown>>): string;
}

/** Column auto-mapping: header name (lowercased) -> import target. */
const AUTO_MAP: Record<string, ImportTargetField> = {
  company: "company.name",
  "company name": "company.name",
  account: "company.name",
  industry: "company.industry",
  hq: "company.hq",
  location: "company.hq",
  country: "company.country",
  website: "company.website",
  domain: "company.website",
  "company linkedin": "company.linkedin",
  contact: "person.name",
  name: "person.name",
  "full name": "person.name",
  person: "person.name",
  title: "person.title",
  role: "person.title",
  email: "person.email",
  linkedin: "person.linkedin",
  channel: "engagement.channel",
  source: "engagement.source",
  batch: "engagement.source",
  "next action": "engagement.nextAction",
  notes: "note",
  "status notes": "note",
  note: "note",
};

function resolveMapping(headers: string[], explicit?: Record<string, ImportTargetField> | null) {
  const mapping: Record<string, ImportTargetField> = {};
  for (const h of headers) {
    const target = explicit?.[h] ?? AUTO_MAP[h.trim().toLowerCase()] ?? "skip";
    mapping[h] = target;
  }
  return mapping;
}

interface NormalizedRow {
  company: { name?: string; industry?: string; hq?: string; country?: string; website?: string; linkedin?: string };
  person: { name?: string; title?: string; email?: string; linkedin?: string };
  engagement: { channel?: string; source?: string; nextAction?: string };
  note?: string;
}

function normalizeRows(rows: Array<Record<string, string>>, mapping: Record<string, ImportTargetField>) {
  const out: NormalizedRow[] = [];
  for (const raw of rows) {
    const row: NormalizedRow = { company: {}, person: {}, engagement: {} };
    for (const [col, target] of Object.entries(mapping)) {
      const value = (raw[col] ?? "").trim();
      if (!value || target === "skip") continue;
      if (target === "note") row.note = row.note ? `${row.note}\n${value}` : value;
      else {
        const [entity, field] = target.split(".") as [keyof Omit<NormalizedRow, "note">, string];
        (row[entity] as Record<string, string>)[field] = value;
      }
    }
    if (row.company.name || row.person.name) out.push(row);
  }
  return out;
}

async function previewImport(op: OpCtx, csvServices: CsvServices, input: z.infer<typeof zImportPreview>) {
  const rows = csvServices.parse(input.csv);
  if (rows.length === 0) throw OpError.validation("CSV has no data rows");
  const headers = Object.keys(rows[0] ?? {});
  const mapping = resolveMapping(headers, input.mapping);
  const normalized = normalizeRows(rows, mapping);

  const existingCompanies = await op.ports.companies.list({
    includeArchived: true,
    sort: "name",
    dir: "asc",
    limit: 500,
    offset: 0,
  });
  const companyNames = new Set(existingCompanies.items.map((c) => c.name.trim().toLowerCase()));
  let duplicateCompanies = 0;
  const uniqueNew = new Set<string>();
  for (const row of normalized) {
    const name = row.company.name?.trim().toLowerCase();
    if (!name) continue;
    if (companyNames.has(name)) duplicateCompanies++;
    else uniqueNew.add(name);
  }
  return {
    headers,
    mapping,
    totalRows: rows.length,
    importableRows: normalized.length,
    skippedRows: rows.length - normalized.length,
    newCompanies: uniqueNew.size,
    existingCompanyMatches: duplicateCompanies,
    sample: normalized.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------

export function buildDataOps(csvServices: CsvServices) {
  return [
    defineOperation({
      name: "search.global",
      title: "Global search",
      description: "Search companies, people, engagements and deals by name/title/notes. Returns grouped, typed hits.",
      input: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }),
      minRole: "viewer",
      scope: "read",
      handler: ({ ports }, { query, limit }) => ports.search.global(query, limit),
    }),

    defineOperation({
      name: "stats.home",
      title: "Home / attention stats",
      description:
        "The operational home bundle: overdue/today/upcoming tasks, stale engagements and deals, pending approvals, recent agent actions, record counts, open deal value.",
      input: z.object({}),
      minRole: "viewer",
      scope: "read",
      handler: async ({ ports }): Promise<HomeStats> => {
        const today = todayIso();
        const overdue = await ports.activities.list({ kind: "task", open: true, overdue: true, limit: 15, offset: 0 });
        const todayTasks = await ports.activities.list({ kind: "task", open: true, dueWithinDays: 0, limit: 15, offset: 0 });
        const upcoming = await ports.activities.list({ kind: "task", open: true, dueWithinDays: 7, limit: 15, offset: 0 });
        const staleEng = await ports.engagements.list({
          stale: true,
          includeArchived: false,
          sort: "lastActivityAt",
          dir: "asc",
          limit: 8,
          offset: 0,
        });
        const staleDeals = await ports.deals.list({
          stale: true,
          status: "open",
          includeArchived: false,
          sort: "lastActivityAt",
          dir: "asc",
          limit: 8,
          offset: 0,
        });
        const agentEvents = await ports.audit.list({ actorType: "agent", limit: 10, offset: 0 });
        const counts = await ports.maintenance.counts();

        const openDeals = await ports.deals.list({
          status: "open",
          includeArchived: false,
          sort: "updatedAt",
          dir: "desc",
          limit: 500,
          offset: 0,
        });
        const valueByCurrency: Record<string, number> = {};
        for (const d of openDeals.items) {
          if (d.amountMinor == null) continue;
          valueByCurrency[d.currency] = (valueByCurrency[d.currency] ?? 0) + d.amountMinor;
        }

        // Filter "today" out of upcoming to avoid duplication.
        const upcomingItems = upcoming.items.filter((t) => (t.dueAt ?? "").slice(0, 10) > today);

        return {
          counts,
          overdueTasks: overdue.items,
          todayTasks: todayTasks.items.filter((t) => (t.dueAt ?? "").slice(0, 10) === today),
          upcomingTasks: upcomingItems,
          staleEngagements: { count: staleEng.total, sample: staleEng.items },
          staleDeals: { count: staleDeals.total, sample: staleDeals.items },
          pendingApprovals: await ports.pendingActions.countPending(),
          recentAgentEvents: agentEvents.items,
          openDealValueByCurrency: valueByCurrency,
        };
      },
    }),

    defineOperation({
      name: "stats.deals",
      title: "Deal pipeline stats",
      description: "Per-stage deal counts, raw and probability-weighted value by currency, for one pipeline (default when omitted).",
      input: z.object({ pipelineId: zId.nullish() }),
      minRole: "viewer",
      scope: "read",
      handler: async ({ ports }, { pipelineId }) => {
        const pipeline = pipelineId ? await ports.pipelines.get(pipelineId) : await ports.pipelines.getDefault("deal");
        if (!pipeline) throw OpError.validation("No deal pipeline found");
        const stats = await ports.deals.stageStats(pipeline.id);
        return {
          pipeline: { id: pipeline.id, name: pipeline.name },
          stages: pipeline.stages.map((s) => {
            const st = stats.find((x) => x.stageId === s.id);
            return {
              stageId: s.id,
              stageName: s.name,
              color: s.color,
              outcome: s.outcome,
              probability: s.probability,
              count: st?.count ?? 0,
              amountMinorByCurrency: st?.sums ?? {},
              weightedMinorByCurrency: st?.weighted ?? {},
            };
          }),
        };
      },
    }),

    defineOperation({
      name: "stats.engagements",
      title: "Engagement funnel stats",
      description: "Per-stage engagement counts for one pipeline (default when omitted).",
      input: z.object({ pipelineId: zId.nullish() }),
      minRole: "viewer",
      scope: "read",
      handler: async ({ ports }, { pipelineId }) => {
        const pipeline = pipelineId ? await ports.pipelines.get(pipelineId) : await ports.pipelines.getDefault("engagement");
        if (!pipeline) throw OpError.validation("No engagement pipeline found");
        const counts = await ports.engagements.countByStage(pipeline.id);
        return {
          pipeline: { id: pipeline.id, name: pipeline.name },
          stages: pipeline.stages.map((s) => ({
            stageId: s.id,
            stageName: s.name,
            color: s.color,
            count: counts.find((c) => c.stageId === s.id)?.count ?? 0,
          })),
        };
      },
    }),

    defineOperation({
      name: "import.preview",
      title: "Preview CSV import",
      description:
        "Inspect a CSV: detected column mapping, row counts, duplicate detection against existing companies, and a normalized sample. Run before import.run.",
      input: zImportPreview,
      minRole: "member",
      scope: "write",
      handler: (op, input) => previewImport(op, csvServices, input),
    }),

    defineOperation({
      name: "import.run",
      title: "Run CSV import",
      description:
        "Import a CSV into companies/people/engagements (leads). Dedupes companies by name and people by email/name+company. Risky (bulk data) — agents need approval unless trusted.",
      input: zImportRun,
      minRole: "member",
      scope: "write",
      risk: "data",
      preview: (op, input) => previewImport(op, csvServices, input),
      handler: async (op, input) => {
        const rows = csvServices.parse(input.csv);
        const headers = Object.keys(rows[0] ?? {});
        const mapping = resolveMapping(headers, input.mapping);
        const normalized = normalizeRows(rows, mapping);
        if (normalized.length === 0) throw OpError.validation("Nothing importable in this CSV");

        let pipelineId: string, stageId: string;
        {
          const pipeline = input.pipelineId
            ? await op.ports.pipelines.get(input.pipelineId)
            : await op.ports.pipelines.getDefault("engagement");
          if (!pipeline) throw OpError.validation("No engagement pipeline found");
          const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages[0];
          if (!stage) throw OpError.validation("Stage not found in pipeline");
          pipelineId = pipeline.id;
          stageId = stage.id;
        }

        const sourceLabel = input.sourceLabel?.trim() || `import-${todayIso()}`;
        const tag =
          (await op.ports.tags.getByName(sourceLabel)) ?? (await op.ports.tags.create({ name: sourceLabel, color: "info" }));

        const result = await op.ports.tx(async () => {
          let companiesCreated = 0,
            companiesMatched = 0,
            peopleCreated = 0,
            engagementsCreated = 0;

          for (const row of normalized) {
            let companyId: string | null = null;
            if (row.company.name) {
              const existing = await op.ports.companies.getByName(row.company.name);
              if (existing) {
                companyId = existing.id;
                companiesMatched++;
              } else {
                const created = await op.ports.companies.create({
                  name: row.company.name,
                  industry: row.company.industry ?? null,
                  hq: row.company.hq ?? null,
                  country: row.company.country ?? null,
                  website: row.company.website ?? null,
                  linkedin: row.company.linkedin ?? null,
                  ownerUserId: input.ownerUserId ?? op.ctx.userId,
                });
                companyId = created.id;
                companiesCreated++;
              }
            }

            let personId: string | null = null;
            if (row.person.name) {
              const person = await op.ports.people.create({
                name: row.person.name,
                title: row.person.title ?? null,
                email: row.person.email ?? null,
                linkedin: row.person.linkedin ?? null,
                ownerUserId: input.ownerUserId ?? op.ctx.userId,
              });
              personId = person.id;
              peopleCreated++;
              if (companyId) {
                await op.ports.people.link({ companyId, personId, roleTitle: row.person.title ?? null, isPrimary: true });
              }
            }

            const company = companyId ? await op.ports.companies.get(companyId) : null;
            const personName = row.person.name;
            const engagement = await op.ports.engagements.create({
              title: personName && company ? `${personName} @ ${company.name}` : (personName ?? company?.name ?? "Imported lead"),
              companyId,
              personId,
              pipelineId,
              stageId,
              channel: row.engagement.channel ?? null,
              source: row.engagement.source ?? sourceLabel,
              nextAction: row.engagement.nextAction ?? null,
              ownerUserId: input.ownerUserId ?? op.ctx.userId,
            });
            engagementsCreated++;
            await op.ports.tags.apply(tag.id, "engagement", engagement.id);
            if (row.note) {
              const a = await op.ports.activities.create(
                { kind: "note", body: row.note, engagementId: engagement.id, companyId, personId },
                actorStamp(op.ctx),
              );
              await op.ports.activities.touchLinked(a, nowIso());
            }
          }
          return { companiesCreated, companiesMatched, peopleCreated, engagementsCreated, tag: sourceLabel };
        });

        await audit(op, {
          operation: "import.run",
          entityType: "workspace",
          entityId: null,
          summary: `Imported CSV: ${result.engagementsCreated} leads, ${result.companiesCreated} new companies, ${result.peopleCreated} people (tag "${sourceLabel}")`,
          meta: result,
        });
        return result;
      },
    }),

    defineOperation({
      name: "export.csv",
      title: "Export CSV",
      description:
        "Export an entity table as CSV text. Risky (full data egress) — agents need approval unless trusted.",
      input: zExportCsv,
      minRole: "member",
      scope: "read",
      risk: "data",
      preview: async ({ ports }, { entityType }) => ({ entityType, counts: await ports.maintenance.counts() }),
      handler: async (op, { entityType, includeArchived }) => {
        const base = { includeArchived, sort: "displayId", dir: "asc", limit: 500, offset: 0 } as const;
        const collect = async <T extends object>(
          fetch: (offset: number) => Promise<{ items: T[]; total: number }>,
        ): Promise<Array<Record<string, unknown>>> => {
          const all: Array<Record<string, unknown>> = [];
          let offset = 0;
          for (;;) {
            const page = await fetch(offset);
            all.push(...page.items.map((item) => ({ ...item }) as Record<string, unknown>));
            offset += 500;
            if (all.length >= page.total || page.items.length === 0) return all;
          }
        };
        let rows: Array<Record<string, unknown>> = [];
        switch (entityType) {
          case "company":
            rows = await collect((offset) => op.ports.companies.list({ ...base, offset }));
            break;
          case "person":
            rows = await collect((offset) => op.ports.people.list({ ...base, offset }));
            break;
          case "engagement":
            rows = await collect((offset) => op.ports.engagements.list({ ...base, offset }));
            break;
          case "deal":
            rows = await collect((offset) => op.ports.deals.list({ ...base, offset }));
            break;
          case "activity":
            rows = await collect((offset) => op.ports.activities.list({ limit: 500, offset }));
            break;
        }
        const csv = csvServices.stringify(rows);
        await audit(op, {
          operation: "export.csv",
          entityType,
          entityId: null,
          summary: `Exported ${rows.length} ${entityType} rows as CSV`,
        });
        return { entityType, rowCount: rows.length, csv };
      },
    }),

    defineOperation({
      name: "data.backup",
      title: "Backup database",
      description:
        "Create a consistent snapshot of the SQLite database in data/backups/. Risky — agents need approval unless trusted.",
      input: z.object({}),
      minRole: "admin",
      scope: "admin",
      risk: "data",
      handler: async (op) => {
        const path = await op.ports.maintenance.backup();
        await audit(op, { operation: "data.backup", entityType: "workspace", entityId: null, summary: `Database backup written to ${path}` });
        return { path };
      },
    }),
  ];
}
