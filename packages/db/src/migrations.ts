/**
 * Versioned, hand-authored SQL migrations (SQLite dialect). Applied in order
 * by the runner in connection.ts; tracked in schema_migrations.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "v1-initial-schema",
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ux ON users(email);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_ws_user_ux ON memberships(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_ux ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_ix ON sessions(user_id);

CREATE TABLE IF NOT EXISTS mcp_clients (
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
CREATE UNIQUE INDEX IF NOT EXISTS mcp_clients_token_ux ON mcp_clients(token_hash);
CREATE INDEX IF NOT EXISTS mcp_clients_ws_ix ON mcp_clients(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_counters (
  workspace_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS counters_ws_entity_ux ON workspace_counters(workspace_id, entity);

CREATE TABLE IF NOT EXISTS companies (
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
CREATE INDEX IF NOT EXISTS companies_ws_ix ON companies(workspace_id);
CREATE INDEX IF NOT EXISTS companies_name_ix ON companies(workspace_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS companies_ws_display_ux ON companies(workspace_id, display_id);

CREATE TABLE IF NOT EXISTS people (
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
CREATE INDEX IF NOT EXISTS people_ws_ix ON people(workspace_id);
CREATE INDEX IF NOT EXISTS people_name_ix ON people(workspace_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS people_ws_display_ux ON people(workspace_id, display_id);

CREATE TABLE IF NOT EXISTS company_people (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role_title TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'current',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS company_people_ux ON company_people(company_id, person_id);
CREATE INDEX IF NOT EXISTS company_people_person_ix ON company_people(person_id);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipelines_ws_ix ON pipelines(workspace_id, type);

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'neutral',
  position INTEGER NOT NULL DEFAULT 0,
  probability INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS stages_pipeline_ix ON stages(pipeline_id);

CREATE TABLE IF NOT EXISTS engagements (
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
CREATE INDEX IF NOT EXISTS engagements_ws_ix ON engagements(workspace_id);
CREATE INDEX IF NOT EXISTS engagements_stage_ix ON engagements(stage_id);
CREATE INDEX IF NOT EXISTS engagements_company_ix ON engagements(company_id);
CREATE INDEX IF NOT EXISTS engagements_person_ix ON engagements(person_id);
CREATE UNIQUE INDEX IF NOT EXISTS engagements_ws_display_ux ON engagements(workspace_id, display_id);

CREATE TABLE IF NOT EXISTS deals (
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
CREATE INDEX IF NOT EXISTS deals_ws_ix ON deals(workspace_id);
CREATE INDEX IF NOT EXISTS deals_stage_ix ON deals(stage_id);
CREATE INDEX IF NOT EXISTS deals_company_ix ON deals(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS deals_ws_display_ux ON deals(workspace_id, display_id);

CREATE TABLE IF NOT EXISTS deal_stakeholders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_stakeholders_ux ON deal_stakeholders(deal_id, person_id);

CREATE TABLE IF NOT EXISTS offerings (
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
CREATE INDEX IF NOT EXISTS offerings_ws_ix ON offerings(workspace_id);

CREATE TABLE IF NOT EXISTS offering_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fit TEXT,
  note TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS offering_links_ux ON offering_links(offering_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS offering_links_entity_ix ON offering_links(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS activities (
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
CREATE INDEX IF NOT EXISTS activities_ws_ix ON activities(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS activities_kind_ix ON activities(workspace_id, kind);
CREATE INDEX IF NOT EXISTS activities_company_ix ON activities(company_id);
CREATE INDEX IF NOT EXISTS activities_person_ix ON activities(person_id);
CREATE INDEX IF NOT EXISTS activities_engagement_ix ON activities(engagement_id);
CREATE INDEX IF NOT EXISTS activities_deal_ix ON activities(deal_id);
CREATE INDEX IF NOT EXISTS activities_due_ix ON activities(workspace_id, due_at);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_ws_name_ux ON tags(workspace_id, name);

CREATE TABLE IF NOT EXISTS taggings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS taggings_ux ON taggings(tag_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS taggings_entity_ix ON taggings(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
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
CREATE UNIQUE INDEX IF NOT EXISTS cfd_ws_entity_key_ux ON custom_field_definitions(workspace_id, entity_type, key);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cfv_field_entity_ux ON custom_field_values(field_id, entity_id);
CREATE INDEX IF NOT EXISTS cfv_entity_ix ON custom_field_values(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS saved_views (
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
CREATE INDEX IF NOT EXISTS saved_views_ws_ix ON saved_views(workspace_id);

CREATE TABLE IF NOT EXISTS pending_actions (
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
CREATE INDEX IF NOT EXISTS pending_ws_status_ix ON pending_actions(workspace_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
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
CREATE INDEX IF NOT EXISTS audit_ws_ix ON audit_events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS audit_entity_ix ON audit_events(entity_type, entity_id);
`,
  },
  {
    version: 2,
    name: "v2-contact-lists",
    sql: `
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lists_ws_name_ux ON lists(workspace_id, name);

CREATE TABLE IF NOT EXISTS list_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS list_members_ux ON list_members(list_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS list_members_entity_ix ON list_members(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS list_members_list_ix ON list_members(list_id);
`,
  },
  {
    version: 3,
    name: "v3-typed-lists",
    sql: `ALTER TABLE lists ADD COLUMN entity_type TEXT;`,
  },
  {
    version: 4,
    // Agent authority now derives from the creating user at request time;
    // clients without a creator are inert. Pre-ownership rows could only have
    // been made by the single local owner, so attribute them accordingly.
    name: "v4-agent-clients-belong-to-a-user",
    sql: `
UPDATE mcp_clients SET created_by_user_id = (
  SELECT m.user_id FROM memberships m
  WHERE m.workspace_id = mcp_clients.workspace_id AND m.role = 'owner'
  LIMIT 1
) WHERE created_by_user_id IS NULL;`,
  },
  {
    version: 5,
    // Database-backed OpenAuth identity (docs/issues/0022, docs/auth-api.md):
    // user lifecycle status + one-time auth-subject binding + forced password
    // change; OpenAuth's KV storage (credentials/keys/tokens — the CRM stops
    // storing login passwords); CRM-issued setup/reset code bookkeeping;
    // sessions linked to the OpenAuth subject; and the pg-parity invariants —
    // one membership per user, one owner per workspace.
    name: "v5-openauth-identity",
    sql: `
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN auth_subject TEXT;
ALTER TABLE users ADD COLUMN password_must_change INTEGER NOT NULL DEFAULT 0;
UPDATE users SET status = 'disabled' WHERE disabled_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_subject_ux ON users(auth_subject);

ALTER TABLE sessions ADD COLUMN auth_subject TEXT;
ALTER TABLE sessions ADD COLUMN auth_refresh TEXT;

CREATE TABLE IF NOT EXISTS openauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expiry INTEGER
);
CREATE INDEX IF NOT EXISTS openauth_kv_expiry_ix ON openauth_kv(expiry);

CREATE TABLE IF NOT EXISTS auth_codes (
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
CREATE INDEX IF NOT EXISTS auth_codes_user_ix ON auth_codes(user_id, purpose);
CREATE INDEX IF NOT EXISTS auth_codes_email_ix ON auth_codes(email, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_ux ON memberships(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_owner_ux ON memberships(workspace_id) WHERE role = 'owner';`,
  },
  {
    version: 6,
    // Hosted open registration (docs/auth-api.md §Hosted open registration):
    // a verified OpenAuth identity may hold a session BEFORE its CRM user
    // exists (trial-first signup provisions the workspace after email
    // verification). user_id becomes nullable; email is the adoption key the
    // session resolver uses to bind the user once provisioning creates it.
    name: "v6-unprovisioned-sessions",
    sql: `
ALTER TABLE sessions RENAME TO sessions_v5;
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
INSERT INTO sessions (id, token_hash, user_id, email, auth_subject, auth_refresh, expires_at, created_at)
  SELECT id, token_hash, user_id, NULL, auth_subject, auth_refresh, expires_at, created_at FROM sessions_v5;
DROP TABLE sessions_v5;
CREATE INDEX IF NOT EXISTS sessions_token_ix ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_ix ON sessions(user_id);`,
  },
];
