/**
 * The complete hand-written SQLite schema (one statement batch), applied by
 * connection.ts ONLY when the database is empty (no `workspaces` table).
 * Mirrored by the drizzle model in schema.ts.
 *
 * Versioning: `PRAGMA user_version` is stamped with SCHEMA_VERSION when the
 * schema is created (and retro-stamped to 1 on existing pre-stamp databases).
 * There is no in-place upgrade machinery yet — it ships together with the
 * first post-release schema change, which bumps SCHEMA_VERSION and uses the
 * stamp to identify what is on disk.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- --- Workspace root and identity --------------------------------------------

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- status: 'pending' | 'active' | 'disabled' (docs/auth-api.md);
-- auth_subject is the OpenAuth \`sub\` claim, bound once at first login.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  auth_subject TEXT,
  password_must_change INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_email_ux ON users(email);
CREATE UNIQUE INDEX users_auth_subject_ux ON users(auth_subject);

-- One membership per user; exactly one owner per workspace (pg parity).
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memberships_ws_user_ux ON memberships(workspace_id, user_id);
CREATE UNIQUE INDEX memberships_user_ux ON memberships(user_id);
CREATE UNIQUE INDEX memberships_owner_ux ON memberships(workspace_id) WHERE role = 'owner';

-- A session may exist for a verified identity BEFORE its CRM user does
-- (docs/auth-api.md §Hosted open registration): user_id is nullable and
-- email carries the adoption key the session resolver binds on.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  auth_subject TEXT,
  auth_refresh TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_token_ix ON sessions(token_hash);
CREATE INDEX sessions_user_ix ON sessions(user_id);

CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  trust TEXT NOT NULL DEFAULT 'review_risky_actions',
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX mcp_clients_token_ux ON mcp_clients(token_hash);
CREATE INDEX mcp_clients_ws_ix ON mcp_clients(workspace_id);

-- OpenAuth issuer key-value storage (credentials/keys/tokens — the CRM never
-- stores login passwords itself) and setup/reset code bookkeeping.
CREATE TABLE openauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expiry INTEGER
);
CREATE INDEX openauth_kv_expiry_ix ON openauth_kv(expiry);

CREATE TABLE auth_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX auth_codes_user_ix ON auth_codes(user_id, purpose);
CREATE INDEX auth_codes_email_ix ON auth_codes(email, created_at);

-- --- Workspace-owned CRM tables ---------------------------------------------

CREATE TABLE workspace_counters (
  workspace_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX counters_ws_entity_ux ON workspace_counters(workspace_id, entity);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  linkedin TEXT,
  industry TEXT,
  hq TEXT,
  country TEXT,
  description TEXT,
  owner_user_id TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX companies_ws_ix ON companies(workspace_id);
CREATE INDEX companies_name_ix ON companies(workspace_id, name);
CREATE UNIQUE INDEX companies_ws_display_ux ON companies(workspace_id, display_id);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  location TEXT,
  country TEXT,
  owner_user_id TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX people_ws_ix ON people(workspace_id);
CREATE INDEX people_name_ix ON people(workspace_id, name);
CREATE UNIQUE INDEX people_ws_display_ux ON people(workspace_id, display_id);

CREATE TABLE company_people (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role_title TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'current',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX company_people_ux ON company_people(company_id, person_id);
CREATE INDEX company_people_person_ix ON company_people(person_id);

CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX pipelines_ws_ix ON pipelines(workspace_id, type);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'neutral',
  position INTEGER NOT NULL DEFAULT 0,
  probability INTEGER,
  outcome TEXT
);
CREATE INDEX stages_pipeline_ix ON stages(pipeline_id);

CREATE TABLE engagements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  company_id TEXT,
  person_id TEXT,
  pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  channel TEXT,
  source TEXT,
  owner_user_id TEXT,
  next_action TEXT,
  next_action_due TEXT,
  deal_id TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);
CREATE INDEX engagements_ws_ix ON engagements(workspace_id);
CREATE INDEX engagements_stage_ix ON engagements(stage_id);
CREATE INDEX engagements_company_ix ON engagements(company_id);
CREATE INDEX engagements_person_ix ON engagements(person_id);
CREATE UNIQUE INDEX engagements_ws_display_ux ON engagements(workspace_id, display_id);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  company_id TEXT,
  primary_person_id TEXT,
  pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  amount_minor INTEGER,
  currency TEXT NOT NULL,
  probability INTEGER,
  expected_close_date TEXT,
  lost_reason TEXT,
  engagement_id TEXT,
  owner_user_id TEXT,
  next_action TEXT,
  next_action_due TEXT,
  closed_at TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);
CREATE INDEX deals_ws_ix ON deals(workspace_id);
CREATE INDEX deals_stage_ix ON deals(stage_id);
CREATE INDEX deals_company_ix ON deals(company_id);
CREATE UNIQUE INDEX deals_ws_display_ux ON deals(workspace_id, display_id);

CREATE TABLE deal_stakeholders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE UNIQUE INDEX deal_stakeholders_ux ON deal_stakeholders(deal_id, person_id);

CREATE TABLE offerings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'service',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  owner_user_id TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX offerings_ws_ix ON offerings(workspace_id);

CREATE TABLE offering_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fit TEXT,
  note TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX offering_links_ux ON offering_links(offering_id, entity_type, entity_id);
CREATE INDEX offering_links_entity_ix ON offering_links(entity_type, entity_id);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_id INTEGER,
  title TEXT,
  body TEXT,
  company_id TEXT,
  person_id TEXT,
  engagement_id TEXT,
  deal_id TEXT,
  due_at TEXT,
  assignee_user_id TEXT,
  completed_at TEXT,
  actor_type TEXT NOT NULL DEFAULT 'human',
  actor_user_id TEXT,
  actor_client_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX activities_ws_ix ON activities(workspace_id, created_at);
CREATE INDEX activities_kind_ix ON activities(workspace_id, kind);
CREATE INDEX activities_company_ix ON activities(company_id);
CREATE INDEX activities_person_ix ON activities(person_id);
CREATE INDEX activities_engagement_ix ON activities(engagement_id);
CREATE INDEX activities_deal_ix ON activities(deal_id);
CREATE INDEX activities_due_ix ON activities(workspace_id, due_at);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tags_ws_name_ux ON tags(workspace_id, name);

CREATE TABLE taggings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL
);
CREATE UNIQUE INDEX taggings_ux ON taggings(tag_id, entity_type, entity_id);
CREATE INDEX taggings_entity_ix ON taggings(entity_type, entity_id);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  entity_type TEXT
);
CREATE UNIQUE INDEX lists_ws_name_ux ON lists(workspace_id, name);

CREATE TABLE list_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX list_members_ux ON list_members(list_id, entity_type, entity_id);
CREATE INDEX list_members_entity_ix ON list_members(entity_type, entity_id);
CREATE INDEX list_members_list_ix ON list_members(list_id);

CREATE TABLE custom_field_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cfd_ws_entity_key_ux ON custom_field_definitions(workspace_id, entity_type, key);

CREATE TABLE custom_field_values (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cfv_field_entity_ux ON custom_field_values(field_id, entity_id);
CREATE INDEX cfv_entity_ix ON custom_field_values(entity_type, entity_id);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX saved_views_ws_ix ON saved_views(workspace_id);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input TEXT NOT NULL,
  preview TEXT,
  risk_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_type TEXT NOT NULL,
  requested_by_user_id TEXT,
  requested_by_client_id TEXT,
  requested_at TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  result TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX pending_ws_status_ix ON pending_actions(workspace_id, status);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  meta TEXT,
  actor_type TEXT NOT NULL,
  actor_user_id TEXT,
  actor_client_id TEXT,
  surface TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_ws_ix ON audit_events(workspace_id, created_at);
CREATE INDEX audit_entity_ix ON audit_events(entity_type, entity_id);
`;
