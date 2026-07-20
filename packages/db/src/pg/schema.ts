/**
 * PostgreSQL schema model (drizzle-orm/pg-core) for the hosted multi-tenant
 * deployment. Mirrors the SQLite schema in `../schema.ts` *semantically*; the
 * authoritative DDL — including every constraint, composite foreign key,
 * row-level-security policy, role and grant — is the hand-written SQL in
 * `./schema.sql`. This module exists so the PostgreSQL adapter
 * (`./repositories.ts`) can build queries; it deliberately declares only
 * tables, columns and primary keys (drizzle FK/index declarations would
 * duplicate the SQL and cannot express PG15 `ON DELETE SET NULL (column)`).
 *
 * Divergences from the SQLite schema, per
 * docs/architecture/postgres-tenant-isolation.md ("clean target schema"):
 *
 * 1. **ids are `uuid`** (SQLite: TEXT). The app generates UUIDv7 via
 *    `newId()`, which is a valid uuid literal. Every workspace-owned parent
 *    additionally carries `UNIQUE (workspace_id, id)` (in SQL) so children can
 *    declare composite same-workspace foreign keys.
 * 2. **`workspace_id uuid NOT NULL` on every workspace-owned table**,
 *    including `users` (new — the isolation key mandated by the doc; SQLite
 *    users are global). `memberships` enforce one membership per user
 *    (`UNIQUE (user_id)`) and exactly one owner per workspace (partial unique
 *    index) in SQL.
 * 3. **Real `boolean`s** (SQLite: INTEGER 0/1): is_primary, is_default,
 *    required, active.
 * 4. **System instants are `timestamptz`** (SQLite: ISO-8601 TEXT):
 *    created_at, updated_at, archived_at, disabled_at, revoked_at,
 *    last_used_at, completed_at, closed_at, last_activity_at, requested_at,
 *    reviewed_at, expires_at, applied_at. Columns use drizzle mode "date";
 *    the adapter converts to/from ISO-8601 UTC strings at the port boundary
 *    so domain types are unchanged.
 * 5. **User-entered scheduling markers stay `text`**: next_action_due,
 *    expected_close_date, due_at. The domain accepts date-only or datetime
 *    strings (`zDueAt`), filters compare on the date part
 *    (`substr(due_at, 1, 10)`), and a timestamptz round-trip would rewrite
 *    stored values ("2026-08-01" → "2026-08-01T00:00:00.000Z"). Zod validates
 *    shape at the catalog boundary.
 * 6. **JSON payloads are `jsonb`** (SQLite: TEXT + JSON.stringify): settings,
 *    scopes, options, filters, input, preview, result, meta, custom-field
 *    value. The adapter reads/writes objects directly — no parse/stringify.
 * 7. **`amount_minor` is `bigint` (mode number)** — SQLite INTEGER is 64-bit;
 *    int4 would silently cap money at ~21M major units.
 * 8. **Generic `entity_type + entity_id` association tables are split into
 *    typed physical tables** so every relationship has a real composite
 *    same-workspace FK (doc §"Flexible association features"):
 *      taggings            → company_tags / person_tags / engagement_tags / deal_tags
 *      list_members        → {company,person,engagement,deal}_list_members
 *      offering_links      → engagement_offering_links / deal_offering_links
 *      custom_field_values → {company,person,engagement,deal,offering}_custom_field_values
 *    The adapter dispatches on the validated entity type and presents the
 *    unchanged generic port API. `audit_events.entity_type/entity_id` stay
 *    generic TEXT on purpose: they are historical data, not live references.
 * 9. Enum-ish values (roles, statuses, kinds, colors, trust, entity types)
 *    remain `text` — project convention keeps them data, not DDL constants.
 *
 * All tables live in the `crm` schema (doc: the private SaaS `saas` schema
 * may reference `crm.workspaces.id` but the crm schema never references saas).
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const crm = pgSchema("crm");

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// --- Workspace root and identity -------------------------------------------

export const workspaces = crm.table("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  defaultCurrency: text("default_currency").notNull(),
  timezone: text("timezone").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const users = crm.table("users", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  /** 'pending' | 'active' | 'disabled' (schema.sql; CHECK-constrained, coherent with disabledAt). */
  status: text("status").notNull(),
  /** Verified OpenAuth `sub`; globally unique when set (partial unique index, schema.sql). */
  authSubject: text("auth_subject"),
  passwordMustChange: boolean("password_must_change").notNull(),
  disabledAt: ts("disabled_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const memberships = crm.table("memberships", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  createdAt: ts("created_at").notNull(),
});

/**
 * Global auth-issuer data (doc §"Authentication tables"): RLS-enabled with no
 * policy, so workspace runtime roles can never read it. Identity resolution
 * goes through the narrow SECURITY DEFINER resolvers in schema.sql.
 */
export const sessions = crm.table("sessions", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  /** NULL while a verified identity awaits hosted provisioning (docs/auth-api.md §Hosted open registration). */
  userId: uuid("user_id"),
  /** Adoption key for user-less sessions. */
  email: text("email"),
  /** OpenAuth subject the session was minted for. */
  authSubject: text("auth_subject"),
  /** Refresh token for logout-time revocation. */
  authRefresh: text("auth_refresh"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
});

/**
 * OpenAuth issuer key-value storage and setup/reset code bookkeeping (schema.sql).
 * Identity-level, NOT workspace-scoped: like crm.sessions they carry
 * RLS-on/no-runtime-policy and zero grants for crm_app/crm_operator, and are
 * reachable only through the fixed SECURITY DEFINER functions
 * (crm.openauth_kv_*, crm.issue_auth_code, crm.consume_auth_code,
 * crm.delete_user_sessions, crm.purge_openauth_subject). These drizzle tables
 * exist for the schema mirror and admin-side tests — the adapter never
 * queries them directly.
 */
export const openauthKv = crm.table("openauth_kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  expiresAt: ts("expires_at"),
});

export const authCodes = crm.table("auth_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  email: text("email").notNull(),
  purpose: text("purpose").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull(),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const mcpClients = crm.table("mcp_clients", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  trust: text("trust").notNull(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: ts("created_at").notNull(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
});

// --- Workspace-owned CRM entities -------------------------------------------

export const workspaceCounters = crm.table(
  "workspace_counters",
  {
    workspaceId: uuid("workspace_id").notNull(),
    entity: text("entity").notNull(),
    nextValue: integer("next_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.entity] })],
);

export const companies = crm.table("companies", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  displayId: integer("display_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain"),
  website: text("website"),
  linkedin: text("linkedin"),
  industry: text("industry"),
  hq: text("hq"),
  country: text("country"),
  description: text("description"),
  ownerUserId: uuid("owner_user_id"),
  archivedAt: ts("archived_at"),
  version: integer("version").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const people = crm.table("people", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  displayId: integer("display_id").notNull(),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  linkedin: text("linkedin"),
  location: text("location"),
  country: text("country"),
  ownerUserId: uuid("owner_user_id"),
  archivedAt: ts("archived_at"),
  version: integer("version").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const companyPeople = crm.table("company_people", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  companyId: uuid("company_id").notNull(),
  personId: uuid("person_id").notNull(),
  roleTitle: text("role_title"),
  isPrimary: boolean("is_primary").notNull(),
  status: text("status").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const pipelines = crm.table("pipelines", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull(),
  position: integer("position").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const stages = crm.table("stages", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  position: integer("position").notNull(),
  probability: integer("probability"),
  outcome: text("outcome"),
});

export const engagements = crm.table("engagements", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  displayId: integer("display_id").notNull(),
  title: text("title").notNull(),
  companyId: uuid("company_id"),
  personId: uuid("person_id"),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  channel: text("channel"),
  source: text("source"),
  ownerUserId: uuid("owner_user_id"),
  nextAction: text("next_action"),
  nextActionDue: text("next_action_due"),
  dealId: uuid("deal_id"),
  archivedAt: ts("archived_at"),
  version: integer("version").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  lastActivityAt: ts("last_activity_at"),
});

export const deals = crm.table("deals", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  displayId: integer("display_id").notNull(),
  title: text("title").notNull(),
  companyId: uuid("company_id"),
  primaryPersonId: uuid("primary_person_id"),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  status: text("status").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }),
  currency: text("currency").notNull(),
  probability: integer("probability"),
  expectedCloseDate: text("expected_close_date"),
  lostReason: text("lost_reason"),
  engagementId: uuid("engagement_id"),
  ownerUserId: uuid("owner_user_id"),
  nextAction: text("next_action"),
  nextActionDue: text("next_action_due"),
  closedAt: ts("closed_at"),
  archivedAt: ts("archived_at"),
  version: integer("version").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  lastActivityAt: ts("last_activity_at"),
});

export const dealStakeholders = crm.table("deal_stakeholders", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  dealId: uuid("deal_id").notNull(),
  personId: uuid("person_id").notNull(),
  role: text("role"),
  isPrimary: boolean("is_primary").notNull(),
  note: text("note"),
});

export const offerings = crm.table("offerings", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description"),
  active: boolean("active").notNull(),
  ownerUserId: uuid("owner_user_id"),
  archivedAt: ts("archived_at"),
  version: integer("version").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const activities = crm.table("activities", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  kind: text("kind").notNull(),
  displayId: integer("display_id"),
  title: text("title"),
  body: text("body"),
  companyId: uuid("company_id"),
  personId: uuid("person_id"),
  engagementId: uuid("engagement_id"),
  dealId: uuid("deal_id"),
  dueAt: text("due_at"),
  assigneeUserId: uuid("assignee_user_id"),
  completedAt: ts("completed_at"),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  actorClientId: uuid("actor_client_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const tags = crm.table("tags", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const lists = crm.table("lists", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull(),
  entityType: text("entity_type"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const customFieldDefs = crm.table("custom_field_definitions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  entityType: text("entity_type").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  options: jsonb("options").$type<string[]>(),
  required: boolean("required").notNull(),
  position: integer("position").notNull(),
  archivedAt: ts("archived_at"),
  createdAt: ts("created_at").notNull(),
});

export const savedViews = crm.table("saved_views", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  visibility: text("visibility").notNull(),
  ownerUserId: uuid("owner_user_id"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const pendingActions = crm.table("pending_actions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  operation: text("operation").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  preview: jsonb("preview").$type<Record<string, unknown>>(),
  riskCategory: text("risk_category").notNull(),
  status: text("status").notNull(),
  requestedByType: text("requested_by_type").notNull(),
  requestedByUserId: uuid("requested_by_user_id"),
  requestedByClientId: uuid("requested_by_client_id"),
  requestedAt: ts("requested_at").notNull(),
  reviewedByUserId: uuid("reviewed_by_user_id"),
  reviewedAt: ts("reviewed_at"),
  reviewNote: text("review_note"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  expiresAt: ts("expires_at").notNull(),
});

/** entity_type/entity_id are historical text, never treated as live references. */
export const auditEvents = crm.table("audit_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  operation: text("operation").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  summary: text("summary").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  actorClientId: uuid("actor_client_id"),
  surface: text("surface").notNull(),
  createdAt: ts("created_at").notNull(),
});

/** Deployment-only metadata; runtime roles have no access (doc §Table classification). */
export const schemaVersion = crm.table("schema_version", {
  version: integer("version").notNull(),
});

// --- Typed association tables (divergence 8) --------------------------------
// The factories give all tables of a family the same TypeScript shape so the
// adapter can dispatch on entity type without union-typing pain. `entity_id`
// is a real composite FK to its specific parent in the SQL DDL.

const tagLinkTable = (name: string) =>
  crm.table(name, {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    entityId: uuid("entity_id").notNull(),
  });

export const companyTags = tagLinkTable("company_tags");
export const personTags = tagLinkTable("person_tags");
export const engagementTags = tagLinkTable("engagement_tags");
export const dealTags = tagLinkTable("deal_tags");

export const TAG_LINK_TABLES = {
  company: companyTags,
  person: personTags,
  engagement: engagementTags,
  deal: dealTags,
} as const;

const listMemberTable = (name: string) =>
  crm.table(name, {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    listId: uuid("list_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: ts("created_at").notNull(),
  });

export const companyListMembers = listMemberTable("company_list_members");
export const personListMembers = listMemberTable("person_list_members");
export const engagementListMembers = listMemberTable("engagement_list_members");
export const dealListMembers = listMemberTable("deal_list_members");

export const LIST_MEMBER_TABLES = {
  company: companyListMembers,
  person: personListMembers,
  engagement: engagementListMembers,
  deal: dealListMembers,
} as const;

const offeringLinkTable = (name: string) =>
  crm.table(name, {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    offeringId: uuid("offering_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    fit: text("fit"),
    note: text("note"),
    isPrimary: boolean("is_primary").notNull(),
  });

export const engagementOfferingLinks = offeringLinkTable("engagement_offering_links");
export const dealOfferingLinks = offeringLinkTable("deal_offering_links");

export const OFFERING_LINK_TABLES = {
  engagement: engagementOfferingLinks,
  deal: dealOfferingLinks,
} as const;

const customFieldValueTable = (name: string) =>
  crm.table(name, {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    value: jsonb("value").$type<unknown>(),
    updatedAt: ts("updated_at").notNull(),
  });

export const companyCustomFieldValues = customFieldValueTable("company_custom_field_values");
export const personCustomFieldValues = customFieldValueTable("person_custom_field_values");
export const engagementCustomFieldValues = customFieldValueTable("engagement_custom_field_values");
export const dealCustomFieldValues = customFieldValueTable("deal_custom_field_values");
export const offeringCustomFieldValues = customFieldValueTable("offering_custom_field_values");

export const CUSTOM_FIELD_VALUE_TABLES = {
  company: companyCustomFieldValues,
  person: personCustomFieldValues,
  engagement: engagementCustomFieldValues,
  deal: dealCustomFieldValues,
  offering: offeringCustomFieldValues,
} as const;
