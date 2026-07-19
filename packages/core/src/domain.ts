/**
 * Domain model for eMCP CRM V1.
 *
 * Single source of truth for entity types, Zod input schemas, and shared
 * constants. Browser-safe: no node imports. The web client, the operation
 * catalog, the MCP tool schemas, and the DB layer all derive from this file.
 */
import { z } from "zod";
import type { Role, TrustProfile, McpScope } from "./policy.ts";

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

export const zId = z.string().min(1).describe("UUIDv7 id");
export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe("Calendar date (YYYY-MM-DD)");
export const zIsoDateTime = z.string().min(1).describe("ISO 8601 timestamp");
/** Date-only or datetime — tasks accept either, per spec. */
export const zDueAt = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "expected YYYY-MM-DD or ISO datetime");
export const zCurrency = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .describe("ISO 4217 currency code");
export const zMoneyMinor = z.number().int().min(0).describe("Amount in integer minor units (e.g. cents/paise)");
export const zVersion = z.number().int().min(1);
export const zExpectedVersion = zVersion.optional().describe("Optimistic concurrency check; omit to skip");

export const zLimit = z.number().int().min(1).max(500).default(100);
export const zOffset = z.number().int().min(0).default(0);

export interface Page<T> {
  items: T[];
  total: number;
}

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = ["company", "person", "engagement", "deal", "offering", "activity"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Entities that support tags. */
export const TAGGABLE_TYPES = ["company", "person", "engagement", "deal"] as const;
export type TaggableType = (typeof TAGGABLE_TYPES)[number];

/** Entities that support custom fields. */
export const CUSTOM_FIELD_TYPES_ENTITIES = ["company", "person", "engagement", "deal", "offering"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_TYPES_ENTITIES)[number];

/** Entities that can belong to contact lists (audiences/campaigns). */
export const LISTABLE_TYPES = ["company", "person", "engagement", "deal"] as const;
export type ListableType = (typeof LISTABLE_TYPES)[number];

/** Entities that carry a human display reference. */
export const DISPLAY_REF_DEFAULTS: Record<string, string> = {
  engagement: "LEAD",
  company: "COMPANY",
  person: "PERSON",
  deal: "DEAL",
  task: "TASK",
};

export function displayRef(prefixes: Record<string, string>, kind: string, displayId: number): string {
  const prefix = prefixes[kind] ?? DISPLAY_REF_DEFAULTS[kind] ?? kind.toUpperCase();
  return `${prefix}-${displayId}`;
}

/** DaisyUI semantic color tokens usable for stages/tags. */
export const SEMANTIC_COLORS = [
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
  "neutral",
  "ghost",
] as const;
export type SemanticColor = (typeof SEMANTIC_COLORS)[number];
export const zSemanticColor = z.enum(SEMANTIC_COLORS);

// ---------------------------------------------------------------------------
// Workspace & users
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  prefixes: Record<string, string>;
  /** Days without activity before an engagement counts as stale. */
  staleEngagementDays: number;
  /** Days without activity before an open deal counts as stale. */
  staleDealDays: number;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  prefixes: { ...DISPLAY_REF_DEFAULTS },
  staleEngagementDays: 14,
  staleDealDays: 30,
};

export interface Workspace {
  id: string;
  name: string;
  defaultCurrency: string;
  timezone: string;
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export const zWorkspaceUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  defaultCurrency: zCurrency.optional(),
  timezone: z.string().min(1).max(64).optional(),
  staleEngagementDays: z.number().int().min(1).max(365).optional(),
  staleDealDays: z.number().int().min(1).max(365).optional(),
  prefixes: z.record(z.string().min(1).max(12)).optional(),
});

/**
 * User lifecycle (docs/issues/0022): `pending` = invited/bootstrapped, has a
 * setup code but no credential yet; `active` = completed first login (auth
 * subject bound); `disabled` = administratively disabled (sessions and MCP
 * keys revoked; nothing restored on re-enable).
 */
export type UserStatus = "pending" | "active" | "disabled";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  hasPassword: boolean;
  disabledAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Companies & people
// ---------------------------------------------------------------------------

export interface Company {
  id: string;
  displayId: number;
  name: string;
  domain: string | null;
  website: string | null;
  linkedin: string | null;
  industry: string | null;
  hq: string | null;
  country: string | null;
  description: string | null;
  ownerUserId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const zCompanyCreate = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).nullish(),
  website: z.string().max(500).nullish(),
  linkedin: z.string().max(500).nullish(),
  industry: z.string().max(200).nullish(),
  hq: z.string().max(200).nullish(),
  country: z.string().max(100).nullish(),
  description: z.string().max(5000).nullish(),
  ownerUserId: zId.nullish(),
});

export const zCompanyUpdate = zCompanyCreate.partial().extend({
  id: zId,
  expectedVersion: zExpectedVersion,
});

export const zCompanyFilter = z.object({
  search: z.string().optional(),
  ownerUserId: zId.optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  tagIds: z.array(zId).optional(),
  listId: zId.optional(),
  includeArchived: z.boolean().default(false),
  sort: z.enum(["name", "createdAt", "updatedAt", "displayId"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: zLimit,
  offset: zOffset,
});
export type CompanyFilter = z.infer<typeof zCompanyFilter>;

export interface Person {
  id: string;
  displayId: number;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  country: string | null;
  ownerUserId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const zPersonCreate = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(200).nullish(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(50).nullish(),
  linkedin: z.string().max(500).nullish(),
  location: z.string().max(200).nullish(),
  country: z.string().max(100).nullish(),
  ownerUserId: zId.nullish(),
  /** Optionally link to a company on create. */
  companyId: zId.nullish(),
  companyRole: z.string().max(200).nullish(),
});

export const zPersonUpdate = zPersonCreate
  .omit({ companyId: true, companyRole: true })
  .partial()
  .extend({ id: zId, expectedVersion: zExpectedVersion });

/**
 * List rows carry the primary company name and contact-list memberships
 * (both joined in the repository) so tables can render them without N+1s.
 */
export interface PersonListItem extends Person {
  primaryCompanyName: string | null;
  lists: ContactList[];
}

/** Company list rows carry contact-list memberships for the same reason. */
export interface CompanyListItem extends Company {
  lists: ContactList[];
}

export const zPersonFilter = z.object({
  search: z.string().optional(),
  companyId: zId.optional(),
  ownerUserId: zId.optional(),
  country: z.string().optional(),
  tagIds: z.array(zId).optional(),
  listId: zId.optional(),
  includeArchived: z.boolean().default(false),
  sort: z.enum(["name", "createdAt", "updatedAt", "displayId"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: zLimit,
  offset: zOffset,
});
export type PersonFilter = z.infer<typeof zPersonFilter>;

export interface CompanyPersonLink {
  id: string;
  companyId: string;
  personId: string;
  roleTitle: string | null;
  isPrimary: boolean;
  status: "current" | "past";
  createdAt: string;
}

export const zCompanyPersonLink = z.object({
  companyId: zId,
  personId: zId,
  roleTitle: z.string().max(200).nullish(),
  isPrimary: z.boolean().default(false),
  status: z.enum(["current", "past"]).default("current"),
});

// ---------------------------------------------------------------------------
// Pipelines & stages
// ---------------------------------------------------------------------------

export const PIPELINE_TYPES = ["engagement", "deal"] as const;
export type PipelineType = (typeof PIPELINE_TYPES)[number];

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  color: SemanticColor;
  position: number;
  /** Deal pipelines: probability default (0-100). Null for engagement stages. */
  probability: number | null;
  /** Terminal outcome: won/lost for deals; done/dropped for engagements. */
  outcome: "won" | "lost" | "done" | "dropped" | null;
}

export interface Pipeline {
  id: string;
  type: PipelineType;
  name: string;
  isDefault: boolean;
  position: number;
  stages: Stage[];
}

export const zStageInput = z.object({
  name: z.string().min(1).max(100),
  color: zSemanticColor.default("neutral"),
  probability: z.number().int().min(0).max(100).nullish(),
  outcome: z.enum(["won", "lost", "done", "dropped"]).nullish(),
});

export const zPipelineCreate = z.object({
  type: z.enum(PIPELINE_TYPES),
  name: z.string().min(1).max(100),
  isDefault: z.boolean().default(false),
  stages: z.array(zStageInput).min(1),
});

// ---------------------------------------------------------------------------
// Engagements (back the Leads view)
// ---------------------------------------------------------------------------

export interface Engagement {
  id: string;
  displayId: number;
  title: string;
  companyId: string | null;
  personId: string | null;
  pipelineId: string;
  stageId: string;
  channel: string | null;
  source: string | null;
  ownerUserId: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  dealId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
}

export const zEngagementCreate = z.object({
  title: z.string().max(300).nullish().describe("Defaults to person @ company"),
  companyId: zId.nullish(),
  personId: zId.nullish(),
  pipelineId: zId.nullish().describe("Defaults to the default engagement pipeline"),
  stageId: zId.nullish().describe("Defaults to the pipeline's first stage"),
  channel: z.string().max(100).nullish(),
  source: z.string().max(200).nullish(),
  ownerUserId: zId.nullish(),
  nextAction: z.string().max(500).nullish(),
  nextActionDue: zIsoDate.nullish(),
  offeringId: zId.nullish().describe("Optional offering this lead pitches; linked as primary"),
});

export const zEngagementUpdate = zEngagementCreate
  .omit({ pipelineId: true, stageId: true, offeringId: true })
  .partial()
  .extend({
    id: zId,
    // Never-null on the record; omit to keep, non-empty string to change.
    title: z.string().min(1).max(300).optional(),
    dealId: zId.nullish(),
    expectedVersion: zExpectedVersion,
  });

/** List rows carry denormalized display names (joined in the repository). */
export interface EngagementListItem extends Engagement {
  companyName: string | null;
  personName: string | null;
  lists: ContactList[];
  offerings: Array<{ id: string; name: string; isPrimary: boolean }>;
}

export const zEngagementFilter = z.object({
  search: z.string().optional(),
  pipelineId: zId.optional(),
  stageId: zId.optional(),
  companyId: zId.optional(),
  personId: zId.optional(),
  ownerUserId: zId.optional(),
  channel: z.string().optional(),
  tagIds: z.array(zId).optional(),
  listId: zId.optional(),
  offeringId: zId.optional(),
  stale: z.boolean().optional().describe("Only engagements with no activity for the workspace stale window"),
  includeArchived: z.boolean().default(false),
  sort: z.enum(["displayId", "title", "createdAt", "updatedAt", "lastActivityAt", "nextActionDue"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: zLimit,
  offset: zOffset,
});
export type EngagementFilter = z.infer<typeof zEngagementFilter>;

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export const DEAL_STATUSES = ["open", "won", "lost"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export interface Deal {
  id: string;
  displayId: number;
  title: string;
  companyId: string | null;
  primaryPersonId: string | null;
  pipelineId: string;
  stageId: string;
  status: DealStatus;
  amountMinor: number | null;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
  lostReason: string | null;
  engagementId: string | null;
  ownerUserId: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
}

export const zDealCreate = z.object({
  title: z.string().min(1).max(300),
  companyId: zId.nullish(),
  primaryPersonId: zId.nullish(),
  pipelineId: zId.nullish().describe("Defaults to the default deal pipeline"),
  stageId: zId.nullish().describe("Defaults to the pipeline's first stage"),
  amountMinor: zMoneyMinor.nullish(),
  currency: zCurrency.nullish().describe("Defaults to the workspace currency"),
  probability: z.number().int().min(0).max(100).nullish(),
  expectedCloseDate: zIsoDate.nullish(),
  engagementId: zId.nullish(),
  ownerUserId: zId.nullish(),
  nextAction: z.string().max(500).nullish(),
  nextActionDue: zIsoDate.nullish(),
  offeringId: zId.nullish().describe("Optional offering this deal covers; linked as primary"),
});

export const zDealUpdate = zDealCreate
  .omit({ pipelineId: true, stageId: true, offeringId: true })
  .partial()
  .extend({
    id: zId,
    // Never-null on the record; omit to keep.
    title: z.string().min(1).max(300).optional(),
    currency: zCurrency.optional(),
    expectedVersion: zExpectedVersion,
  });

/** List rows carry denormalized display names (joined in the repository). */
export interface DealListItem extends Deal {
  companyName: string | null;
  primaryPersonName: string | null;
  lists: ContactList[];
  offerings: Array<{ id: string; name: string; isPrimary: boolean }>;
}

export const zDealFilter = z.object({
  search: z.string().optional(),
  pipelineId: zId.optional(),
  stageId: zId.optional(),
  status: z.enum(DEAL_STATUSES).optional(),
  companyId: zId.optional(),
  personId: zId.optional(),
  ownerUserId: zId.optional(),
  tagIds: z.array(zId).optional(),
  listId: zId.optional(),
  offeringId: zId.optional(),
  stale: z.boolean().optional(),
  includeArchived: z.boolean().default(false),
  sort: z
    .enum(["displayId", "title", "amountMinor", "expectedCloseDate", "createdAt", "updatedAt", "lastActivityAt"])
    .default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: zLimit,
  offset: zOffset,
});
export type DealFilter = z.infer<typeof zDealFilter>;

export interface DealStakeholder {
  id: string;
  dealId: string;
  personId: string;
  role: string | null;
  isPrimary: boolean;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Offerings
// ---------------------------------------------------------------------------

export const OFFERING_TYPES = ["product", "service", "package", "other"] as const;
export type OfferingType = (typeof OFFERING_TYPES)[number];

export interface Offering {
  id: string;
  name: string;
  type: OfferingType;
  description: string | null;
  active: boolean;
  ownerUserId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const zOfferingCreate = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(OFFERING_TYPES).default("service"),
  description: z.string().max(5000).nullish(),
  active: z.boolean().default(true),
  ownerUserId: zId.nullish(),
});

export const zOfferingUpdate = zOfferingCreate.partial().extend({
  id: zId,
  expectedVersion: zExpectedVersion,
});

export interface OfferingLink {
  id: string;
  offeringId: string;
  entityType: "engagement" | "deal";
  entityId: string;
  fit: string | null;
  note: string | null;
  isPrimary: boolean;
}

export const zOfferingLinkInput = z.object({
  offeringId: zId,
  entityType: z.enum(["engagement", "deal"]),
  entityId: zId,
  fit: z.string().max(100).nullish(),
  note: z.string().max(1000).nullish(),
  isPrimary: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Activities (unified timeline; tasks are kind "task")
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["note", "call", "email", "meeting", "task", "status_change", "agent_action"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Kinds a caller may log directly (status_change/agent_action are system-emitted). */
export const LOGGABLE_KINDS = ["note", "call", "email", "meeting", "task"] as const;

export type ActorType = "human" | "agent" | "system";

export interface Activity {
  id: string;
  kind: ActivityKind;
  /** Only task activities get a display id (TASK-n). */
  displayId: number | null;
  title: string | null;
  body: string | null;
  companyId: string | null;
  personId: string | null;
  engagementId: string | null;
  dealId: string | null;
  dueAt: string | null;
  assigneeUserId: string | null;
  completedAt: string | null;
  actorType: ActorType;
  actorUserId: string | null;
  actorClientId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

const zActivityLinks = {
  companyId: zId.nullish(),
  personId: zId.nullish(),
  engagementId: zId.nullish(),
  dealId: zId.nullish(),
};

export const zActivityLog = z.object({
  kind: z.enum(LOGGABLE_KINDS),
  title: z.string().max(300).nullish(),
  body: z.string().max(20000).nullish(),
  ...zActivityLinks,
  occurredAt: zIsoDateTime.nullish().describe("Backdate the entry; defaults to now"),
  // task fields
  dueAt: zDueAt.nullish(),
  assigneeUserId: zId.nullish(),
});

export const zActivityUpdate = z.object({
  id: zId,
  title: z.string().max(300).nullish(),
  body: z.string().max(20000).nullish(),
  dueAt: zDueAt.nullish(),
  assigneeUserId: zId.nullish(),
});

export const zActivityFilter = z.object({
  kind: z.enum(ACTIVITY_KINDS).optional(),
  kinds: z.array(z.enum(ACTIVITY_KINDS)).optional(),
  companyId: zId.optional(),
  personId: zId.optional(),
  engagementId: zId.optional(),
  dealId: zId.optional(),
  actorType: z.enum(["human", "agent", "system"]).optional(),
  assigneeUserId: zId.optional(),
  /** Task helpers */
  open: z.boolean().optional().describe("Tasks only: not completed"),
  overdue: z.boolean().optional(),
  dueWithinDays: z.number().int().min(0).max(365).optional(),
  limit: zLimit,
  offset: zOffset,
});
export type ActivityFilter = z.infer<typeof zActivityFilter>;

export const zTaskCreate = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20000).nullish(),
  dueAt: zDueAt.nullish(),
  assigneeUserId: zId.nullish(),
  ...zActivityLinks,
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface Tag {
  id: string;
  name: string;
  color: SemanticColor;
  createdAt: string;
}

export const zTagCreate = z.object({
  name: z.string().min(1).max(80),
  color: zSemanticColor.default("neutral"),
});

export const zTagApply = z.object({
  tagId: zId,
  entityType: z.enum(TAGGABLE_TYPES),
  entityId: zId,
});

// ---------------------------------------------------------------------------
// Contact lists (deliberate audiences/segments: "Job search", "Product X"…)
//
// Tags are loose ad-hoc labels; lists are curated universes a record belongs
// to, with counts on the dashboard and first-class filters. Membership is
// many-to-many across companies, people, engagements and deals.
// ---------------------------------------------------------------------------

export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  color: SemanticColor;
  entityType: ListableType | null;
  createdAt: string;
  updatedAt: string;
}

/** List with per-entity membership counts (dashboard / index views). */
export interface ContactListWithCounts extends ContactList {
  people: number;
  companies: number;
  engagements: number;
  deals: number;
}

export const zListCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  color: zSemanticColor.default("neutral"),
  entityType: z.enum(LISTABLE_TYPES).nullish().describe("Restrict this list to one entity type; omit for a mixed list"),
});

export const zListUpdate = z.object({
  id: zId,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullish(),
  color: zSemanticColor.optional(),
  entityType: z.enum(LISTABLE_TYPES).nullish().optional(),
});

export const zListMembers = z.object({
  listId: zId,
  entityType: z.enum(LISTABLE_TYPES),
  entityIds: z.array(zId).min(1).max(500),
});

// ---------------------------------------------------------------------------
// Custom fields (typed definitions + validated values)
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
  "multi_select",
  "url",
  "email",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDef {
  id: string;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  position: number;
  archivedAt: string | null;
}

export const zCustomFieldCreate = z.object({
  entityType: z.enum(CUSTOM_FIELD_TYPES_ENTITIES),
  label: z.string().min(1).max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().min(1).max(100)).max(100).nullish(),
  required: z.boolean().default(false),
});

export const zCustomFieldUpdate = z.object({
  id: zId,
  label: z.string().min(1).max(100).optional(),
  options: z.array(z.string().min(1).max(100)).max(100).nullish(),
  required: z.boolean().optional(),
});

export type CustomFieldValue = string | number | boolean | string[] | null;

export const zCustomFieldSetValues = z.object({
  entityType: z.enum(CUSTOM_FIELD_TYPES_ENTITIES),
  entityId: zId,
  values: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
    .describe("Map of field key -> typed value (null clears)"),
});

/** Validate one runtime value against a field definition. Throws Error on mismatch. */
export function validateCustomFieldValue(def: CustomFieldDef, value: CustomFieldValue): CustomFieldValue {
  if (value === null) return null;
  const fail = (msg: string): never => {
    throw new Error(`Field "${def.key}" (${def.type}): ${msg}`);
  };
  switch (def.type) {
    case "text":
      return typeof value === "string" ? value : fail("expected text");
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : fail("expected number");
    case "boolean":
      return typeof value === "boolean" ? value : fail("expected boolean");
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fail("expected YYYY-MM-DD");
    case "select":
      if (typeof value !== "string") return fail("expected one option string");
      if (!def.options?.includes(value)) return fail(`allowed: ${def.options?.join(", ")}`);
      return value;
    case "multi_select": {
      if (!Array.isArray(value)) return fail("expected an array of option strings");
      for (const v of value) if (!def.options?.includes(v)) fail(`"${v}" not in allowed: ${def.options?.join(", ")}`);
      return value;
    }
    case "url":
      // Regex (not `new URL`) so this module needs no runtime globals beyond ES.
      if (typeof value !== "string") return fail("expected URL string");
      return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#][^\s]*)?$/i.test(value.trim()) ? value : fail("invalid URL");
    case "email":
      return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : fail("invalid email");
  }
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export const SAVED_VIEW_ENTITIES = ["company", "person", "engagement", "deal", "activity"] as const;
export type SavedViewEntity = (typeof SAVED_VIEW_ENTITIES)[number];

export interface SavedView {
  id: string;
  name: string;
  entityType: SavedViewEntity;
  filters: Record<string, unknown>;
  visibility: "private" | "shared" | "system";
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const zSavedViewCreate = z.object({
  name: z.string().min(1).max(120),
  entityType: z.enum(SAVED_VIEW_ENTITIES),
  filters: z.record(z.unknown()),
  visibility: z.enum(["private", "shared"]).default("private"),
});

// ---------------------------------------------------------------------------
// Pending actions & audit
// ---------------------------------------------------------------------------

export const PENDING_STATUSES = ["pending", "approved", "rejected", "cancelled", "failed"] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export interface PendingAction {
  id: string;
  operation: string;
  input: Record<string, unknown>;
  preview: Record<string, unknown> | null;
  riskCategory: string;
  status: PendingStatus;
  requestedByType: ActorType;
  requestedByUserId: string | null;
  requestedByClientId: string | null;
  requestedAt: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  result: Record<string, unknown> | null;
  expiresAt: string;
}

export interface AuditEvent {
  id: string;
  operation: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  meta: Record<string, unknown> | null;
  actorType: ActorType;
  actorUserId: string | null;
  actorClientId: string | null;
  surface: Surface;
  createdAt: string;
}

export type Surface = "web" | "mcp_http" | "mcp_stdio" | "api" | "system";

export const zAuditFilter = z.object({
  actorType: z.enum(["human", "agent", "system"]).optional(),
  operation: z.string().optional(),
  entityType: z.string().optional(),
  entityId: zId.optional(),
  limit: zLimit,
  offset: zOffset,
});

// ---------------------------------------------------------------------------
// MCP clients
// ---------------------------------------------------------------------------

export interface McpClient {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: McpScope[];
  trust: TrustProfile;
  createdByUserId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export const IMPORT_TARGET_FIELDS = [
  "company.name",
  "company.industry",
  "company.hq",
  "company.country",
  "company.website",
  "company.linkedin",
  "person.name",
  "person.title",
  "person.email",
  "person.linkedin",
  "engagement.channel",
  "engagement.source",
  "engagement.nextAction",
  "note",
  "skip",
] as const;
export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

export const zImportPreview = z.object({
  csv: z.string().min(1).describe("Raw CSV content, first row = headers"),
  mapping: z
    .record(z.enum(IMPORT_TARGET_FIELDS))
    .nullish()
    .describe("Column -> target field. Omit for auto-detection."),
});

export const zImportRun = zImportPreview.extend({
  pipelineId: zId.nullish(),
  stageId: zId.nullish(),
  ownerUserId: zId.nullish(),
  sourceLabel: z.string().max(200).nullish().describe("Stored as engagement source + import tag"),
});

export const zExportCsv = z.object({
  entityType: z.enum(["company", "person", "engagement", "deal", "activity"]),
  includeArchived: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Stats / attention bundles
// ---------------------------------------------------------------------------

export interface HomeStats {
  counts: { companies: number; people: number; engagements: number; deals: number; openDeals: number };
  overdueTasks: Activity[];
  todayTasks: Activity[];
  upcomingTasks: Activity[];
  staleEngagements: { count: number; sample: Engagement[] };
  staleDeals: { count: number; sample: Deal[] };
  pendingApprovals: number;
  recentAgentEvents: AuditEvent[];
  openDealValueByCurrency: Record<string, number>;
}

export interface PipelineStageStat {
  stageId: string;
  stageName: string;
  color: SemanticColor;
  count: number;
  amountMinorByCurrency: Record<string, number>;
  weightedMinorByCurrency: Record<string, number>;
}

export interface SearchHit {
  entityType: EntityType;
  id: string;
  ref: string | null;
  title: string;
  subtitle: string | null;
  archived: boolean;
}
