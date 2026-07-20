/**
 * Drizzle schema (SQLite dialect). Timestamps are ISO-8601 TEXT in UTC.
 * JSON columns use text with JSON.stringify (typed at the repository layer).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// --- Global (not workspace-scoped) ------------------------------------------

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  defaultCurrency: text("default_currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("UTC"),
  settings: text("settings").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** Legacy pre-OpenAuth hash; login credentials live in openauth_kv now. */
    passwordHash: text("password_hash"),
    /** Lifecycle: pending (invited, no credential yet) | active | disabled. */
    status: text("status").notNull().default("active"),
    /** OpenAuth subject, bound once on first successful login (unique). */
    authSubject: text("auth_subject"),
    /** While 1, every operation except password change/logout/whoami is refused. */
    passwordMustChange: integer("password_must_change").notNull().default(0),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("users_email_ux").on(t.email), uniqueIndex("users_auth_subject_ux").on(t.authSubject)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("memberships_ws_user_ux").on(t.workspaceId, t.userId),
    // pg-parity invariants (docs/issues/0022): one membership per user…
    uniqueIndex("memberships_user_ux").on(t.userId),
    // …and exactly one owner per workspace (partial unique index).
    uniqueIndex("memberships_owner_ux").on(t.workspaceId).where(sql`role = 'owner'`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    /** NULL while a verified identity awaits hosted provisioning (v6). */
    userId: text("user_id"),
    /** Adoption key for user-less sessions: the verified, normalized email. */
    email: text("email"),
    /** OpenAuth subject this session was minted for (claims are never authority). */
    authSubject: text("auth_subject"),
    /** OpenAuth refresh token backing this session, revoked on logout. */
    authRefresh: text("auth_refresh"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("sessions_token_ux").on(t.tokenHash), index("sessions_user_ix").on(t.userId)],
);

export const mcpClients = sqliteTable(
  "mcp_clients",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    trust: text("trust").notNull().default("review_risky_actions"),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("mcp_clients_token_ux").on(t.tokenHash), index("mcp_clients_ws_ix").on(t.workspaceId)],
);

// --- Workspace-scoped CRM entities ------------------------------------------

export const workspaceCounters = sqliteTable(
  "workspace_counters",
  {
    workspaceId: text("workspace_id").notNull(),
    entity: text("entity").notNull(),
    nextValue: integer("next_value").notNull().default(1),
  },
  (t) => [uniqueIndex("counters_ws_entity_ux").on(t.workspaceId, t.entity)],
);

export const companies = sqliteTable(
  "companies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    displayId: integer("display_id").notNull(),
    name: text("name").notNull(),
    domain: text("domain"),
    website: text("website"),
    linkedin: text("linkedin"),
    industry: text("industry"),
    hq: text("hq"),
    country: text("country"),
    description: text("description"),
    ownerUserId: text("owner_user_id"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("companies_ws_ix").on(t.workspaceId),
    index("companies_name_ix").on(t.workspaceId, t.name),
    uniqueIndex("companies_ws_display_ux").on(t.workspaceId, t.displayId),
  ],
);

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    displayId: integer("display_id").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    email: text("email"),
    phone: text("phone"),
    linkedin: text("linkedin"),
    location: text("location"),
    country: text("country"),
    ownerUserId: text("owner_user_id"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("people_ws_ix").on(t.workspaceId),
    index("people_name_ix").on(t.workspaceId, t.name),
    uniqueIndex("people_ws_display_ux").on(t.workspaceId, t.displayId),
  ],
);

export const companyPeople = sqliteTable(
  "company_people",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    companyId: text("company_id").notNull(),
    personId: text("person_id").notNull(),
    roleTitle: text("role_title"),
    isPrimary: integer("is_primary").notNull().default(0),
    status: text("status").notNull().default("current"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("company_people_ux").on(t.companyId, t.personId),
    index("company_people_person_ix").on(t.personId),
  ],
);

export const pipelines = sqliteTable(
  "pipelines",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    isDefault: integer("is_default").notNull().default(0),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("pipelines_ws_ix").on(t.workspaceId, t.type)],
);

export const stages = sqliteTable(
  "stages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    pipelineId: text("pipeline_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("neutral"),
    position: integer("position").notNull().default(0),
    probability: integer("probability"),
    outcome: text("outcome"),
  },
  (t) => [index("stages_pipeline_ix").on(t.pipelineId)],
);

export const engagements = sqliteTable(
  "engagements",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    displayId: integer("display_id").notNull(),
    title: text("title").notNull(),
    companyId: text("company_id"),
    personId: text("person_id"),
    pipelineId: text("pipeline_id").notNull(),
    stageId: text("stage_id").notNull(),
    channel: text("channel"),
    source: text("source"),
    ownerUserId: text("owner_user_id"),
    nextAction: text("next_action"),
    nextActionDue: text("next_action_due"),
    dealId: text("deal_id"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastActivityAt: text("last_activity_at"),
  },
  (t) => [
    index("engagements_ws_ix").on(t.workspaceId),
    index("engagements_stage_ix").on(t.stageId),
    index("engagements_company_ix").on(t.companyId),
    index("engagements_person_ix").on(t.personId),
    uniqueIndex("engagements_ws_display_ux").on(t.workspaceId, t.displayId),
  ],
);

export const deals = sqliteTable(
  "deals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    displayId: integer("display_id").notNull(),
    title: text("title").notNull(),
    companyId: text("company_id"),
    primaryPersonId: text("primary_person_id"),
    pipelineId: text("pipeline_id").notNull(),
    stageId: text("stage_id").notNull(),
    status: text("status").notNull().default("open"),
    amountMinor: integer("amount_minor"),
    currency: text("currency").notNull(),
    probability: integer("probability"),
    expectedCloseDate: text("expected_close_date"),
    lostReason: text("lost_reason"),
    engagementId: text("engagement_id"),
    ownerUserId: text("owner_user_id"),
    nextAction: text("next_action"),
    nextActionDue: text("next_action_due"),
    closedAt: text("closed_at"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastActivityAt: text("last_activity_at"),
  },
  (t) => [
    index("deals_ws_ix").on(t.workspaceId),
    index("deals_stage_ix").on(t.stageId),
    index("deals_company_ix").on(t.companyId),
    uniqueIndex("deals_ws_display_ux").on(t.workspaceId, t.displayId),
  ],
);

export const dealStakeholders = sqliteTable(
  "deal_stakeholders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    dealId: text("deal_id").notNull(),
    personId: text("person_id").notNull(),
    role: text("role"),
    isPrimary: integer("is_primary").notNull().default(0),
    note: text("note"),
  },
  (t) => [uniqueIndex("deal_stakeholders_ux").on(t.dealId, t.personId)],
);

export const offerings = sqliteTable(
  "offerings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("service"),
    description: text("description"),
    active: integer("active").notNull().default(1),
    ownerUserId: text("owner_user_id"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("offerings_ws_ix").on(t.workspaceId)],
);

export const offeringLinks = sqliteTable(
  "offering_links",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    offeringId: text("offering_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fit: text("fit"),
    note: text("note"),
    isPrimary: integer("is_primary").notNull().default(0),
  },
  (t) => [
    uniqueIndex("offering_links_ux").on(t.offeringId, t.entityType, t.entityId),
    index("offering_links_entity_ix").on(t.entityType, t.entityId),
  ],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    displayId: integer("display_id"),
    title: text("title"),
    body: text("body"),
    companyId: text("company_id"),
    personId: text("person_id"),
    engagementId: text("engagement_id"),
    dealId: text("deal_id"),
    dueAt: text("due_at"),
    assigneeUserId: text("assignee_user_id"),
    completedAt: text("completed_at"),
    actorType: text("actor_type").notNull().default("human"),
    actorUserId: text("actor_user_id"),
    actorClientId: text("actor_client_id"),
    meta: text("meta"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("activities_ws_ix").on(t.workspaceId, t.createdAt),
    index("activities_kind_ix").on(t.workspaceId, t.kind),
    index("activities_company_ix").on(t.companyId),
    index("activities_person_ix").on(t.personId),
    index("activities_engagement_ix").on(t.engagementId),
    index("activities_deal_ix").on(t.dealId),
    index("activities_due_ix").on(t.workspaceId, t.dueAt),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("neutral"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("tags_ws_name_ux").on(t.workspaceId, t.name)],
);

export const taggings = sqliteTable(
  "taggings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    tagId: text("tag_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (t) => [
    uniqueIndex("taggings_ux").on(t.tagId, t.entityType, t.entityId),
    index("taggings_entity_ix").on(t.entityType, t.entityId),
  ],
);

export const lists = sqliteTable(
  "lists",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("neutral"),
    entityType: text("entity_type"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("lists_ws_name_ux").on(t.workspaceId, t.name)],
);

export const listMembers = sqliteTable(
  "list_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    listId: text("list_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("list_members_ux").on(t.listId, t.entityType, t.entityId),
    index("list_members_entity_ix").on(t.entityType, t.entityId),
    index("list_members_list_ix").on(t.listId),
  ],
);

export const customFieldDefs = sqliteTable(
  "custom_field_definitions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    entityType: text("entity_type").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    options: text("options"),
    required: integer("required").notNull().default(0),
    position: integer("position").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("cfd_ws_entity_key_ux").on(t.workspaceId, t.entityType, t.key)],
);

export const customFieldValues = sqliteTable(
  "custom_field_values",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    fieldId: text("field_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    value: text("value"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("cfv_field_entity_ux").on(t.fieldId, t.entityId),
    index("cfv_entity_ix").on(t.entityType, t.entityId),
  ],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    entityType: text("entity_type").notNull(),
    filters: text("filters").notNull().default("{}"),
    visibility: text("visibility").notNull().default("private"),
    ownerUserId: text("owner_user_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("saved_views_ws_ix").on(t.workspaceId)],
);

export const pendingActions = sqliteTable(
  "pending_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    operation: text("operation").notNull(),
    input: text("input").notNull(),
    preview: text("preview"),
    riskCategory: text("risk_category").notNull(),
    status: text("status").notNull().default("pending"),
    requestedByType: text("requested_by_type").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    requestedByClientId: text("requested_by_client_id"),
    requestedAt: text("requested_at").notNull(),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: text("reviewed_at"),
    reviewNote: text("review_note"),
    result: text("result"),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("pending_ws_status_ix").on(t.workspaceId, t.status)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    operation: text("operation").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    meta: text("meta"),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorClientId: text("actor_client_id"),
    surface: text("surface").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("audit_ws_ix").on(t.workspaceId, t.createdAt),
    index("audit_entity_ix").on(t.entityType, t.entityId),
  ],
);

// --- Authentication (OpenAuth issuer + CRM code bookkeeping) ----------------

/**
 * OpenAuth's StorageAdapter backing table. Keys are OpenAuth's segment arrays
 * joined with 0x1f; values are JSON; expiry is epoch millis (null = none).
 * OpenAuth owns everything in here: password hashes, signing/encryption keys,
 * authorization codes, refresh tokens, email→subject bindings.
 */
export const openauthKv = sqliteTable("openauth_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiry: integer("expiry"),
}, (t) => [index("openauth_kv_expiry_ix").on(t.expiry)]);

/**
 * CRM-issued single-use setup/reset codes (docs/auth-api.md): hashed at rest,
 * expiring, attempt-capped; regeneration invalidates earlier codes of the
 * same purpose (used_at is also set when a code is superseded).
 */
export const authCodes = sqliteTable(
  "auth_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    purpose: text("purpose").notNull(), // 'setup' | 'reset'
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [index("auth_codes_user_ix").on(t.userId, t.purpose), index("auth_codes_email_ix").on(t.email, t.createdAt)],
);
