-- schema.sql — the complete hand-written PostgreSQL schema for the hosted
-- multi-tenant deployment: crm tables, same-workspace composite foreign keys,
-- roles and least-privilege grants, forced row-level security, the narrow
-- SECURITY DEFINER identity/credential functions, and the schema_version
-- stamp. Applied in ONE transaction by src/pg/init.ts (or `psql -f`) — only
-- when the database is empty (no crm.workspaces) — using a deployment role
-- (crm_migrator/superuser), never a runtime role. Requires PostgreSQL >= 15
-- (ON DELETE SET NULL (column) form; target is PostgreSQL 17).
--
-- There is no in-place upgrade machinery yet — it ships together with the
-- first post-release schema change, keyed off crm.schema_version.
--
-- Design source: docs/architecture/postgres-tenant-isolation.md
--   * every workspace-owned parent has UNIQUE (workspace_id, id);
--   * direct child relationships carry the workspace in their FK, so a row can
--     never reference another workspace's parent — independent of RLS;
--   * tenant-configurable uniqueness always starts with workspace_id;
--   * user deletion clears live references (SET NULL (col)) while workspace-
--     owned history remains; workspace deletion cascades everything;
--   * generic entity_type/entity_id association tables are split into typed
--     tables so each target has a real composite FK (doc §Flexible
--     association features);
--   * audit_events.entity_type/entity_id stay generic text: historical data,
--     never a live reference.

BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;

-- --- Workspace root and identity -------------------------------------------

CREATE TABLE crm.workspaces (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  default_currency text NOT NULL DEFAULT 'USD',
  timezone         text NOT NULL DEFAULT 'UTC',
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

-- users carry a mandatory hidden workspace_id as the isolation key (doc
-- §Workspace root and identity tables). Email stays deployment-global.
--
-- status: 'pending'  invited, no credentials yet — may NOT authenticate;
--         'active'   normal user;
--         'disabled' login disabled by an admin — may NOT authenticate.
-- disabled_at is the human-visible "since when"; the CHECK keeps the pair
-- coherent so no code path can produce a half-disabled user. auth_subject is
-- the OpenAuth `sub` claim: globally unique across the deployment (isolation
-- doc §"Uniqueness and information disclosure" allows exactly this and the
-- normalized email as deployment-wide identities).
CREATE TABLE crm.users (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  email                text NOT NULL,
  name                 text NOT NULL,
  password_hash        text,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  auth_subject         text,
  password_must_change boolean NOT NULL DEFAULT false,
  UNIQUE (workspace_id, id),
  CONSTRAINT users_status_ck CHECK (status IN ('pending', 'active', 'disabled')),
  CONSTRAINT users_status_disabled_ck CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_ux ON crm.users (email);
CREATE INDEX users_ws_ix ON crm.users (workspace_id);
CREATE UNIQUE INDEX users_auth_subject_ux ON crm.users (auth_subject) WHERE auth_subject IS NOT NULL;

-- One membership per user; role lives here; exactly one owner per workspace.
CREATE TABLE crm.memberships (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  role         text NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (user_id),
  UNIQUE (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES crm.users (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX memberships_one_owner_ux ON crm.memberships (workspace_id) WHERE role = 'owner';

-- Global auth-issuer data. No runtime grants, RLS-denied below; identity
-- resolution happens only through the narrow resolver functions. A session
-- records the OpenAuth subject it was minted for and the refresh token to
-- revoke at logout (docs/auth-api.md §Sessions). A session may exist for a
-- verified identity BEFORE its CRM user does (docs/auth-api.md §Hosted open
-- registration): user_id is nullable and email carries the adoption key.
CREATE TABLE crm.sessions (
  id           uuid PRIMARY KEY,
  token_hash   text NOT NULL,
  user_id      uuid REFERENCES crm.users (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL,
  auth_subject text,
  auth_refresh text,
  email        text,
  UNIQUE (token_hash)
);
CREATE INDEX sessions_user_ix ON crm.sessions (user_id);

-- An MCP client and its creating user belong to the same workspace; deleting
-- the creator leaves the client inert (created_by_user_id goes NULL).
CREATE TABLE crm.mcp_clients (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  name               text NOT NULL,
  token_hash         text NOT NULL,
  token_prefix       text NOT NULL,
  scopes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  trust              text NOT NULL DEFAULT 'review_risky_actions',
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  UNIQUE (token_hash),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (created_by_user_id)
);
CREATE INDEX mcp_clients_ws_ix ON crm.mcp_clients (workspace_id);

-- --- OpenAuth issuer storage (identity-level, NOT workspace-scoped) ---------
--
-- Generic key-value store backing the public product's OpenAuth storage
-- adapter (tokens, authorization state, verification records). Keys are
-- opaque issuer-defined strings; values are issuer JSON; expires_at implements
-- storage TTL. Runtime access ONLY via the crm.openauth_kv_* functions below.

CREATE TABLE crm.openauth_kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz
);
CREATE INDEX openauth_kv_expires_ix ON crm.openauth_kv (expires_at) WHERE expires_at IS NOT NULL;

-- --- Setup / reset code bookkeeping (identity-level) ------------------------
--
-- Column-parity with the SQLite table (docs/auth-api.md): one row per issued
-- single-use code; only the SHA-256 hash is stored, plus the user's email at
-- issue time (redemption UIs are email+code shaped) and an attempts counter
-- for redemption throttling at the auth surface. Issuing a new code for a
-- (user, purpose) deletes the previous ones (single active code per purpose);
-- consumption is a single atomic UPDATE so a code can be redeemed at most
-- once under any concurrency. Rows die with their user (ON DELETE CASCADE —
-- FK enforcement is exempt from RLS by design, which is also what lets user
-- deletion cascade into sessions).

CREATE TABLE crm.auth_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES crm.users (id) ON DELETE CASCADE,
  email      text NOT NULL,
  purpose    text NOT NULL CHECK (purpose IN ('setup', 'reset')),
  code_hash  text NOT NULL UNIQUE,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX auth_codes_user_ix ON crm.auth_codes (user_id, purpose);
CREATE INDEX auth_codes_email_ix ON crm.auth_codes (email, created_at);

-- Deployment-only stamp: what schema is on disk (no runtime grants; RLS-denied
-- below). A future updater reads it to pick its upgrade steps.
CREATE TABLE crm.schema_version (
  version integer NOT NULL
);

-- --- Workspace-owned CRM tables ---------------------------------------------

CREATE TABLE crm.workspace_counters (
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  entity       text NOT NULL,
  next_value   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, entity)
);

CREATE TABLE crm.companies (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  display_id    integer NOT NULL,
  name          text NOT NULL,
  domain        text,
  website       text,
  linkedin      text,
  industry      text,
  hq            text,
  country       text,
  description   text,
  owner_user_id uuid,
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX companies_name_ix ON crm.companies (workspace_id, name);

CREATE TABLE crm.people (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  display_id    integer NOT NULL,
  name          text NOT NULL,
  title         text,
  email         text,
  phone         text,
  linkedin      text,
  location      text,
  country       text,
  owner_user_id uuid,
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX people_name_ix ON crm.people (workspace_id, name);

CREATE TABLE crm.company_people (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  company_id   uuid NOT NULL,
  person_id    uuid NOT NULL,
  role_title   text,
  is_primary   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'current',
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, company_id, person_id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES crm.companies (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, person_id)  REFERENCES crm.people (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX company_people_person_ix ON crm.company_people (workspace_id, person_id);

CREATE TABLE crm.pipelines (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  type         text NOT NULL,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX pipelines_ws_ix ON crm.pipelines (workspace_id, type);

-- The extra UNIQUE (workspace_id, pipeline_id, id) lets engagements/deals
-- prove "stage belongs to that pipeline in that workspace" with one FK.
CREATE TABLE crm.stages (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  pipeline_id  uuid NOT NULL,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT 'neutral',
  position     integer NOT NULL DEFAULT 0,
  probability  integer,
  outcome      text,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, pipeline_id, id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES crm.pipelines (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX stages_pipeline_ix ON crm.stages (workspace_id, pipeline_id);

CREATE TABLE crm.engagements (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  display_id       integer NOT NULL,
  title            text NOT NULL,
  company_id       uuid,
  person_id        uuid,
  pipeline_id      uuid NOT NULL,
  stage_id         uuid NOT NULL,
  channel          text,
  source           text,
  owner_user_id    uuid,
  next_action      text,
  next_action_due  text,
  deal_id          uuid,
  archived_at      timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  last_activity_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES crm.companies (workspace_id, id) ON DELETE SET NULL (company_id),
  FOREIGN KEY (workspace_id, person_id)  REFERENCES crm.people (workspace_id, id) ON DELETE SET NULL (person_id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES crm.pipelines (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id, stage_id) REFERENCES crm.stages (workspace_id, pipeline_id, id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
  -- (workspace_id, deal_id) FK added after crm.deals below (circular pair).
);
CREATE INDEX engagements_ws_ix ON crm.engagements (workspace_id);
CREATE INDEX engagements_stage_ix ON crm.engagements (workspace_id, stage_id);
CREATE INDEX engagements_company_ix ON crm.engagements (workspace_id, company_id);
CREATE INDEX engagements_person_ix ON crm.engagements (workspace_id, person_id);

CREATE TABLE crm.deals (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  display_id          integer NOT NULL,
  title               text NOT NULL,
  company_id          uuid,
  primary_person_id   uuid,
  pipeline_id         uuid NOT NULL,
  stage_id            uuid NOT NULL,
  status              text NOT NULL DEFAULT 'open',
  amount_minor        bigint,
  currency            text NOT NULL,
  probability         integer,
  expected_close_date text,
  lost_reason         text,
  engagement_id       uuid,
  owner_user_id       uuid,
  next_action         text,
  next_action_due     text,
  closed_at           timestamptz,
  archived_at         timestamptz,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  last_activity_at    timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES crm.companies (workspace_id, id) ON DELETE SET NULL (company_id),
  FOREIGN KEY (workspace_id, primary_person_id)
    REFERENCES crm.people (workspace_id, id) ON DELETE SET NULL (primary_person_id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES crm.pipelines (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id, stage_id) REFERENCES crm.stages (workspace_id, pipeline_id, id),
  FOREIGN KEY (workspace_id, engagement_id)
    REFERENCES crm.engagements (workspace_id, id) ON DELETE SET NULL (engagement_id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX deals_ws_ix ON crm.deals (workspace_id);
CREATE INDEX deals_stage_ix ON crm.deals (workspace_id, stage_id);
CREATE INDEX deals_company_ix ON crm.deals (workspace_id, company_id);

ALTER TABLE crm.engagements
  ADD CONSTRAINT engagements_deal_fk
  FOREIGN KEY (workspace_id, deal_id) REFERENCES crm.deals (workspace_id, id) ON DELETE SET NULL (deal_id);

CREATE TABLE crm.deal_stakeholders (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  deal_id      uuid NOT NULL,
  person_id    uuid NOT NULL,
  role         text,
  is_primary   boolean NOT NULL DEFAULT false,
  note         text,
  UNIQUE (workspace_id, deal_id, person_id),
  FOREIGN KEY (workspace_id, deal_id)   REFERENCES crm.deals (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, person_id) REFERENCES crm.people (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE crm.offerings (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          text NOT NULL DEFAULT 'service',
  description   text,
  active        boolean NOT NULL DEFAULT true,
  owner_user_id uuid,
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX offerings_ws_ix ON crm.offerings (workspace_id);

CREATE TABLE crm.engagement_offering_links (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  offering_id   uuid NOT NULL,
  entity_id     uuid NOT NULL,
  fit           text,
  note          text,
  is_primary    boolean NOT NULL DEFAULT false,
  UNIQUE (workspace_id, offering_id, entity_id),
  FOREIGN KEY (workspace_id, offering_id) REFERENCES crm.offerings (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id)   REFERENCES crm.engagements (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX engagement_offering_links_entity_ix ON crm.engagement_offering_links (workspace_id, entity_id);

CREATE TABLE crm.deal_offering_links (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  offering_id   uuid NOT NULL,
  entity_id     uuid NOT NULL,
  fit           text,
  note          text,
  is_primary    boolean NOT NULL DEFAULT false,
  UNIQUE (workspace_id, offering_id, entity_id),
  FOREIGN KEY (workspace_id, offering_id) REFERENCES crm.offerings (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id)   REFERENCES crm.deals (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_offering_links_entity_ix ON crm.deal_offering_links (workspace_id, entity_id);

CREATE TABLE crm.activities (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  kind             text NOT NULL,
  display_id       integer,
  title            text,
  body             text,
  company_id       uuid,
  person_id        uuid,
  engagement_id    uuid,
  deal_id          uuid,
  due_at           text,
  assignee_user_id uuid,
  completed_at     timestamptz,
  actor_type       text NOT NULL DEFAULT 'human',
  actor_user_id    uuid,
  actor_client_id  uuid,
  meta             jsonb,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, company_id)    REFERENCES crm.companies (workspace_id, id) ON DELETE SET NULL (company_id),
  FOREIGN KEY (workspace_id, person_id)     REFERENCES crm.people (workspace_id, id) ON DELETE SET NULL (person_id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES crm.engagements (workspace_id, id) ON DELETE SET NULL (engagement_id),
  FOREIGN KEY (workspace_id, deal_id)       REFERENCES crm.deals (workspace_id, id) ON DELETE SET NULL (deal_id),
  FOREIGN KEY (workspace_id, assignee_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (assignee_user_id),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (actor_user_id),
  FOREIGN KEY (workspace_id, actor_client_id)
    REFERENCES crm.mcp_clients (workspace_id, id) ON DELETE SET NULL (actor_client_id)
);
CREATE INDEX activities_ws_ix ON crm.activities (workspace_id, created_at);
CREATE INDEX activities_kind_ix ON crm.activities (workspace_id, kind);
CREATE INDEX activities_company_ix ON crm.activities (workspace_id, company_id);
CREATE INDEX activities_person_ix ON crm.activities (workspace_id, person_id);
CREATE INDEX activities_engagement_ix ON crm.activities (workspace_id, engagement_id);
CREATE INDEX activities_deal_ix ON crm.activities (workspace_id, deal_id);
CREATE INDEX activities_due_ix ON crm.activities (workspace_id, due_at);

CREATE TABLE crm.tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT 'neutral',
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE crm.company_tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  tag_id       uuid NOT NULL,
  entity_id    uuid NOT NULL,
  UNIQUE (workspace_id, tag_id, entity_id),
  FOREIGN KEY (workspace_id, tag_id)    REFERENCES crm.tags (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.companies (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX company_tags_entity_ix ON crm.company_tags (workspace_id, entity_id);

CREATE TABLE crm.person_tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  tag_id       uuid NOT NULL,
  entity_id    uuid NOT NULL,
  UNIQUE (workspace_id, tag_id, entity_id),
  FOREIGN KEY (workspace_id, tag_id)    REFERENCES crm.tags (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.people (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX person_tags_entity_ix ON crm.person_tags (workspace_id, entity_id);

CREATE TABLE crm.engagement_tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  tag_id       uuid NOT NULL,
  entity_id    uuid NOT NULL,
  UNIQUE (workspace_id, tag_id, entity_id),
  FOREIGN KEY (workspace_id, tag_id)    REFERENCES crm.tags (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.engagements (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX engagement_tags_entity_ix ON crm.engagement_tags (workspace_id, entity_id);

CREATE TABLE crm.deal_tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  tag_id       uuid NOT NULL,
  entity_id    uuid NOT NULL,
  UNIQUE (workspace_id, tag_id, entity_id),
  FOREIGN KEY (workspace_id, tag_id)    REFERENCES crm.tags (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.deals (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_tags_entity_ix ON crm.deal_tags (workspace_id, entity_id);

CREATE TABLE crm.lists (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  color        text NOT NULL DEFAULT 'neutral',
  entity_type  text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE crm.company_list_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  list_id      uuid NOT NULL,
  entity_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, list_id, entity_id),
  FOREIGN KEY (workspace_id, list_id)   REFERENCES crm.lists (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.companies (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX company_list_members_entity_ix ON crm.company_list_members (workspace_id, entity_id);

CREATE TABLE crm.person_list_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  list_id      uuid NOT NULL,
  entity_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, list_id, entity_id),
  FOREIGN KEY (workspace_id, list_id)   REFERENCES crm.lists (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.people (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX person_list_members_entity_ix ON crm.person_list_members (workspace_id, entity_id);

CREATE TABLE crm.engagement_list_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  list_id      uuid NOT NULL,
  entity_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, list_id, entity_id),
  FOREIGN KEY (workspace_id, list_id)   REFERENCES crm.lists (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.engagements (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX engagement_list_members_entity_ix ON crm.engagement_list_members (workspace_id, entity_id);

CREATE TABLE crm.deal_list_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  list_id      uuid NOT NULL,
  entity_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, list_id, entity_id),
  FOREIGN KEY (workspace_id, list_id)   REFERENCES crm.lists (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.deals (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_list_members_entity_ix ON crm.deal_list_members (workspace_id, entity_id);

CREATE TABLE crm.custom_field_definitions (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  key          text NOT NULL,
  label        text NOT NULL,
  type         text NOT NULL,
  options      jsonb,
  required     boolean NOT NULL DEFAULT false,
  position     integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, entity_type, key)
);

CREATE TABLE crm.company_custom_field_values (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  field_id     uuid NOT NULL,
  entity_id    uuid NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, field_id, entity_id),
  FOREIGN KEY (workspace_id, field_id)  REFERENCES crm.custom_field_definitions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.companies (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX company_cfv_entity_ix ON crm.company_custom_field_values (workspace_id, entity_id);

CREATE TABLE crm.person_custom_field_values (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  field_id     uuid NOT NULL,
  entity_id    uuid NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, field_id, entity_id),
  FOREIGN KEY (workspace_id, field_id)  REFERENCES crm.custom_field_definitions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.people (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX person_cfv_entity_ix ON crm.person_custom_field_values (workspace_id, entity_id);

CREATE TABLE crm.engagement_custom_field_values (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  field_id     uuid NOT NULL,
  entity_id    uuid NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, field_id, entity_id),
  FOREIGN KEY (workspace_id, field_id)  REFERENCES crm.custom_field_definitions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.engagements (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX engagement_cfv_entity_ix ON crm.engagement_custom_field_values (workspace_id, entity_id);

CREATE TABLE crm.deal_custom_field_values (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  field_id     uuid NOT NULL,
  entity_id    uuid NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, field_id, entity_id),
  FOREIGN KEY (workspace_id, field_id)  REFERENCES crm.custom_field_definitions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.deals (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_cfv_entity_ix ON crm.deal_custom_field_values (workspace_id, entity_id);

CREATE TABLE crm.offering_custom_field_values (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  field_id     uuid NOT NULL,
  entity_id    uuid NOT NULL,
  value        jsonb,
  updated_at   timestamptz NOT NULL,
  UNIQUE (workspace_id, field_id, entity_id),
  FOREIGN KEY (workspace_id, field_id)  REFERENCES crm.custom_field_definitions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entity_id) REFERENCES crm.offerings (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX offering_cfv_entity_ix ON crm.offering_custom_field_values (workspace_id, entity_id);

CREATE TABLE crm.saved_views (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  name          text NOT NULL,
  entity_type   text NOT NULL,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility    text NOT NULL DEFAULT 'private',
  owner_user_id uuid,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX saved_views_ws_ix ON crm.saved_views (workspace_id);

CREATE TABLE crm.pending_actions (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  operation              text NOT NULL,
  input                  jsonb NOT NULL,
  preview                jsonb,
  risk_category          text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  requested_by_type      text NOT NULL,
  requested_by_user_id   uuid,
  requested_by_client_id uuid,
  requested_at           timestamptz NOT NULL,
  reviewed_by_user_id    uuid,
  reviewed_at            timestamptz,
  review_note            text,
  result                 jsonb,
  expires_at             timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (requested_by_user_id),
  FOREIGN KEY (workspace_id, reviewed_by_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (reviewed_by_user_id),
  FOREIGN KEY (workspace_id, requested_by_client_id)
    REFERENCES crm.mcp_clients (workspace_id, id) ON DELETE SET NULL (requested_by_client_id)
);
CREATE INDEX pending_ws_status_ix ON crm.pending_actions (workspace_id, status);

-- entity_type/entity_id are deliberately generic text: audit rows are
-- history, not live references (doc §Flexible association features).
CREATE TABLE crm.audit_events (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  operation       text NOT NULL,
  entity_type     text,
  entity_id       text,
  summary         text NOT NULL,
  meta            jsonb,
  actor_type      text NOT NULL,
  actor_user_id   uuid,
  actor_client_id uuid,
  surface         text NOT NULL,
  created_at      timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES crm.users (workspace_id, id) ON DELETE SET NULL (actor_user_id),
  FOREIGN KEY (workspace_id, actor_client_id)
    REFERENCES crm.mcp_clients (workspace_id, id) ON DELETE SET NULL (actor_client_id)
);
CREATE INDEX audit_ws_ix ON crm.audit_events (workspace_id, created_at);
CREATE INDEX audit_entity_ix ON crm.audit_events (workspace_id, entity_type, entity_id);

-- =============================================================================
-- PostgreSQL roles and least-privilege grants per
-- docs/architecture/postgres-tenant-isolation.md §"PostgreSQL roles".
--
--   crm_schema_owner       NOLOGIN  owns every crm object and policy
--   crm_identity_resolver  NOLOGIN  owns the narrow resolver/credential fns
--   crm_app                LOGIN    web / operation API / MCP runtime
--   crm_operator           LOGIN    private hosting-control service
--
-- No runtime role is a superuser, a table owner, a BYPASSRLS member, or able
-- to create/alter schemas, tables, policies, functions or roles. Passwords
-- are NOT set here: deployment (or the test harness) sets them with
-- `ALTER ROLE crm_app PASSWORD ...` using its own secret management.
--
-- Roles are cluster-global, so creation is guarded for idempotency across
-- databases sharing one cluster. Grants are per-database and re-run safely.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_schema_owner') THEN
    CREATE ROLE crm_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_identity_resolver') THEN
    CREATE ROLE crm_identity_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_operator') THEN
    CREATE ROLE crm_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- The schema and every table are owned by the non-login schema owner, so no
-- login role can ever use table-owner RLS bypass (FORCE below closes the
-- rest). Functions created below set their own ownership.
ALTER SCHEMA crm OWNER TO crm_schema_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'crm' LOOP
    EXECUTE format('ALTER TABLE crm.%I OWNER TO crm_schema_owner', r.tablename);
  END LOOP;
END
$$;

-- Lock the schema down, then grant back exactly what runtime needs.
REVOKE ALL ON SCHEMA crm FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA crm TO crm_app, crm_operator, crm_identity_resolver;

-- Workspace-owned product tables: plain CRUD for the runtime roles; every row
-- is still gated by the forced RLS policies below.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  crm.workspaces,
  crm.users,
  crm.memberships,
  crm.mcp_clients,
  crm.workspace_counters,
  crm.companies,
  crm.people,
  crm.company_people,
  crm.pipelines,
  crm.stages,
  crm.engagements,
  crm.deals,
  crm.deal_stakeholders,
  crm.offerings,
  crm.engagement_offering_links,
  crm.deal_offering_links,
  crm.activities,
  crm.tags,
  crm.company_tags,
  crm.person_tags,
  crm.engagement_tags,
  crm.deal_tags,
  crm.lists,
  crm.company_list_members,
  crm.person_list_members,
  crm.engagement_list_members,
  crm.deal_list_members,
  crm.custom_field_definitions,
  crm.company_custom_field_values,
  crm.person_custom_field_values,
  crm.engagement_custom_field_values,
  crm.deal_custom_field_values,
  crm.offering_custom_field_values,
  crm.saved_views,
  crm.pending_actions,
  crm.audit_events
TO crm_app, crm_operator;

-- The identity resolver role touches only what its fixed SECURITY DEFINER
-- functions (below) need: read the identity tables, read/write the OpenAuth
-- issuer storage and code bookkeeping, and read/delete sessions for the fixed
-- revocation path. It has no login and no other access.
GRANT SELECT ON crm.users, crm.memberships, crm.mcp_clients TO crm_identity_resolver;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.openauth_kv, crm.auth_codes TO crm_identity_resolver;
GRANT SELECT, DELETE ON crm.sessions TO crm_identity_resolver;

-- crm.sessions (beyond the resolver's narrow grant) and crm.schema_version
-- receive NO runtime grants at all: sessions are auth-issuer data owned by
-- the product's auth storage adapter; schema_version is deployment-only
-- metadata.

-- Deliberately NO "ALTER DEFAULT PRIVILEGES ... GRANT" here: a newly created
-- table is inaccessible to every runtime role until a schema change
-- explicitly classifies it, grants it, and adds its RLS policy (doc §Table
-- classification: "new tables default to inaccessible").

-- =============================================================================
-- Row-level security and narrow identity resolvers per
-- docs/architecture/postgres-tenant-isolation.md.
--
-- Session-GUC contract: every request transaction installs its trusted
-- workspace BEFORE the first CRM query using the transaction-local form
--
--     SET LOCAL app.workspace_id = '<uuid>';
--     -- or, parameterized (what the adapter sends):
--     SELECT set_config('app.workspace_id', $1, true);
--
-- `set_config(..., true)` is the parameterizable equivalent of SET LOCAL: the
-- value evaporates at COMMIT/ROLLBACK, so a pooled connection can never carry
-- the previous request's workspace. crm.current_workspace_id() returns NULL
-- when the setting is absent, empty, or malformed — and every policy compares
-- against it, so a missing context denies everything (default deny).
--
-- Every workspace-owned table is ENABLE + FORCE row level security with one
-- policy carrying both USING (read/update/delete visibility) and WITH CHECK
-- (insert/update assignment) — a row outside the transaction's workspace can
-- be neither seen nor produced. FORCE keeps even a future table owner subject
-- to the policy; runtime roles are not owners anyway.
--
-- The identity-level tables (sessions, openauth_kv, auth_codes) are NOT
-- workspace-scoped — a credential exists before any workspace context does
-- (login is the step that DISCOVERS the workspace). They get RLS ENABLE +
-- FORCE with NO policy for any login role and ZERO grants to crm_app /
-- crm_operator — direct table access is denied to every runtime login role.
-- The ONLY sanctioned path is the fixed SECURITY DEFINER functions below,
-- owned by the non-login crm_identity_resolver, which receives narrow
-- per-command grants plus an explicit all-rows policy so the fixed function
-- bodies (and nothing else) can reach the rows. schema_version gets the same
-- no-policy, no-grant denial.
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.current_workspace_id()
RETURNS uuid
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE
  raw text := current_setting('app.workspace_id', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN raw::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;  -- malformed context must deny, not error
  END;
END
$$;

ALTER FUNCTION crm.current_workspace_id() OWNER TO crm_schema_owner;
REVOKE ALL ON FUNCTION crm.current_workspace_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.current_workspace_id() TO crm_app, crm_operator, crm_identity_resolver;

-- The workspace root row itself: visible only as the current workspace.
ALTER TABLE crm.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm.workspaces
  TO crm_app, crm_operator
  USING (id = crm.current_workspace_id())
  WITH CHECK (id = crm.current_workspace_id());

-- Every workspace-owned table (registry mirrored by the isolation tests —
-- keep the two lists identical when adding tables).
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users',
    'memberships',
    'mcp_clients',
    'workspace_counters',
    'companies',
    'people',
    'company_people',
    'pipelines',
    'stages',
    'engagements',
    'deals',
    'deal_stakeholders',
    'offerings',
    'engagement_offering_links',
    'deal_offering_links',
    'activities',
    'tags',
    'company_tags',
    'person_tags',
    'engagement_tags',
    'deal_tags',
    'lists',
    'company_list_members',
    'person_list_members',
    'engagement_list_members',
    'deal_list_members',
    'custom_field_definitions',
    'company_custom_field_values',
    'person_custom_field_values',
    'engagement_custom_field_values',
    'deal_custom_field_values',
    'offering_custom_field_values',
    'saved_views',
    'pending_actions',
    'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON crm.%I '
      'TO crm_app, crm_operator '
      'USING (workspace_id = crm.current_workspace_id()) '
      'WITH CHECK (workspace_id = crm.current_workspace_id())',
      tbl
    );
  END LOOP;
END
$$;

-- Auth-issuer and deployment tables: RLS on; the auth_storage policies below
-- open them to the resolver role only; schema_version stays fully denied.
ALTER TABLE crm.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.openauth_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.openauth_kv FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.auth_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_version FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_storage ON crm.sessions
  TO crm_identity_resolver USING (true) WITH CHECK (true);
CREATE POLICY auth_storage ON crm.openauth_kv
  TO crm_identity_resolver USING (true) WITH CHECK (true);
CREATE POLICY auth_storage ON crm.auth_codes
  TO crm_identity_resolver USING (true) WITH CHECK (true);

-- --- Narrow identity resolvers (doc §Identity before workspace context) -----
-- Global credential resolution is available ONLY through these fixed
-- SECURITY DEFINER functions owned by the non-login crm_identity_resolver.
-- They take one verified credential fact, return one row of fixed fields
-- (never names, emails-by-pattern, password material, or lists), and are the
-- step BEFORE a workspace transaction is opened. The identity_resolution
-- SELECT policies below apply to crm_identity_resolver only.

CREATE POLICY identity_resolution ON crm.users
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY identity_resolution ON crm.memberships
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY identity_resolution ON crm.mcp_clients
  FOR SELECT TO crm_identity_resolver USING (true);

-- resolve_user_identity — the AUTHENTICATION authority — keys on the VERIFIED
-- OpenAuth subject and returns a row ONLY for status = 'active' users:
-- pending and disabled users do not authenticate, full stop.
--
-- The email arm demanded by identity linking is deliberately a SEPARATE
-- function (resolve_auth_email) so no authentication code path can treat an
-- email match as a login. It serves exactly the issuer success callback
-- (docs/auth-api.md §password/authorize), which runs only AFTER OpenAuth
-- verified ownership of the email/credential, and needs to triage:
--   pending + not linked  → activate: bind subject once, then log in
--   active  + not linked  → first OpenAuth login of a pre-OpenAuth user
--                           (e.g. after owner recovery): bind subject
--   linked (any status)   → subject already authoritative; email is stale as
--                           a key — the callback re-resolves by subject
--   disabled              → reject as account_disabled (distinct from
--                           not_invited, per the landed UI contract)
-- It returns the fixed triage fields only — never names, password state, or
-- another workspace's data — and is NOT a list/search interface.

CREATE FUNCTION crm.resolve_user_identity(p_subject text)
RETURNS TABLE (user_id uuid, workspace_id uuid, role text, password_must_change boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, u.password_must_change
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.status = 'active'
    AND u.auth_subject IS NOT NULL
    AND u.auth_subject = p_subject
$$;

CREATE FUNCTION crm.resolve_auth_email(p_email text)
RETURNS TABLE (user_id uuid, workspace_id uuid, role text, status text, subject_linked boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, u.status, (u.auth_subject IS NOT NULL)
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.email = lower(p_email)
$$;

-- MCP keys: the creating user must be ACTIVE (pending creators cannot lend
-- authority any more than disabled ones — same resolver-enforced rule).
CREATE FUNCTION crm.resolve_mcp_key(p_token_hash text)
RETURNS TABLE (
  client_id uuid,
  workspace_id uuid,
  user_id uuid,
  role text,
  scopes jsonb,
  trust text,
  enabled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT
    c.id,
    c.workspace_id,
    u.id,
    m.role,
    c.scopes,
    c.trust,
    (c.revoked_at IS NULL AND u.id IS NOT NULL AND u.status = 'active')
  FROM crm.mcp_clients c
  LEFT JOIN crm.users u
    ON u.id = c.created_by_user_id AND u.workspace_id = c.workspace_id
  LEFT JOIN crm.memberships m
    ON m.user_id = u.id AND m.workspace_id = c.workspace_id
  WHERE c.token_hash = p_token_hash
$$;

-- --- Credential storage functions (the sanctioned runtime path) -------------
--
-- OpenAuth storage contract: get / set(+TTL) / remove / scan-by-prefix.
-- Identity-level by nature, so none of these consult the workspace GUC; they
-- are callable outside a workspace transaction (the issuer runs before a
-- workspace is known). scan uses starts_with (no LIKE pattern injection).
-- Expired rows are invisible to get/scan; set sweeps them opportunistically.

CREATE FUNCTION crm.openauth_kv_get(p_key text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT value FROM crm.openauth_kv
  WHERE key = p_key AND (expires_at IS NULL OR expires_at > now())
$$;

CREATE FUNCTION crm.openauth_kv_set(p_key text, p_value jsonb, p_expires_at timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  WITH swept AS (
    DELETE FROM crm.openauth_kv WHERE expires_at IS NOT NULL AND expires_at <= now()
  )
  INSERT INTO crm.openauth_kv (key, value, expires_at)
  VALUES (p_key, p_value, p_expires_at)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
$$;

CREATE FUNCTION crm.openauth_kv_remove(p_key text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  DELETE FROM crm.openauth_kv WHERE key = p_key
$$;

CREATE FUNCTION crm.openauth_kv_scan(p_prefix text)
RETURNS TABLE (key text, value jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT key, value FROM crm.openauth_kv
  WHERE starts_with(key, p_prefix) AND (expires_at IS NULL OR expires_at > now())
  ORDER BY key
$$;

-- Issue a single-use code for a user IN THE CURRENT WORKSPACE (the issuing
-- surfaces — invite, reset — are admin operations inside a workspace
-- transaction). Deletes that user's previous codes of the same purpose, so at
-- most one code per (user, purpose) is redeemable. Returns the new row id, or
-- NULL when the user is not visible in this workspace or is disabled — the
-- adapter translates NULL to not_found, indistinguishable from a random id.
CREATE FUNCTION crm.issue_auth_code(p_user_id uuid, p_purpose text, p_code_hash text, p_expires_at timestamptz)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  WITH target AS (
    SELECT id, email FROM crm.users
    WHERE id = p_user_id
      AND workspace_id = crm.current_workspace_id()
      AND status <> 'disabled'
  ),
  cleared AS (
    DELETE FROM crm.auth_codes c USING target t
    WHERE c.user_id = t.id AND c.purpose = p_purpose
  )
  INSERT INTO crm.auth_codes (user_id, email, purpose, code_hash, expires_at)
  SELECT t.id, t.email, p_purpose, p_code_hash, p_expires_at FROM target t
  RETURNING id
$$;

-- Atomically redeem a code: the UPDATE both checks single-use/expiry and
-- burns the code, so concurrent redemptions see exactly one winner. Runs
-- BEFORE a workspace transaction exists (the redeemer is not logged in), so
-- like resolve_mcp_key it is keyed on the hash and not workspace-guarded; it
-- returns the fixed identity pair the caller needs to proceed.
CREATE FUNCTION crm.consume_auth_code(p_code_hash text, p_purpose text)
RETURNS TABLE (user_id uuid, workspace_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  UPDATE crm.auth_codes c
  SET used_at = now()
  FROM crm.users u
  WHERE c.code_hash = p_code_hash
    AND c.purpose = p_purpose
    AND c.used_at IS NULL
    AND c.expires_at > now()
    AND u.id = c.user_id
    AND u.status <> 'disabled'
  RETURNING c.user_id, u.workspace_id
$$;

-- Disable/delete revocation sweep (docs/issues/0022): hard-delete every login
-- session of a user IN THE CURRENT WORKSPACE. Returns the number removed.
CREATE FUNCTION crm.delete_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  WITH target AS (
    SELECT id FROM crm.users
    WHERE id = p_user_id AND workspace_id = crm.current_workspace_id()
  ),
  deleted AS (
    DELETE FROM crm.sessions s USING target t WHERE s.user_id = t.id RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- Permanent user deletion also revokes the OpenAuth issuer's stored state for
-- that identity. The issuer keys rows by the subject (refresh tokens,
-- authorization state) AND by the normalized email (password hash,
-- email→subject binding — docs/auth-api.md §Storage), so both markers are
-- purged; substring matching is deliberate because OpenAuth joins key path
-- segments with a control separator, and both markers are globally unique
-- deployment-wide. Guarded to a user visible in the current workspace, so a
-- workspace transaction can never purge another workspace's credentials; call
-- it BEFORE deleting the user row.
CREATE FUNCTION crm.purge_openauth_identity(p_user_id uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  WITH target AS (
    SELECT auth_subject, email FROM crm.users
    WHERE id = p_user_id AND workspace_id = crm.current_workspace_id()
  ),
  deleted AS (
    DELETE FROM crm.openauth_kv k USING target t
    WHERE (t.auth_subject IS NOT NULL AND position(t.auth_subject IN k.key) > 0)
       OR position(lower(t.email) IN lower(k.key)) > 0
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- --- Ownership + execution grants -------------------------------------------
-- Owned by the non-login resolver role, EXECUTE revoked from PUBLIC and
-- granted only to crm_app.

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'resolve_user_identity(text)',
    'resolve_auth_email(text)',
    'resolve_mcp_key(text)',
    'openauth_kv_get(text)',
    'openauth_kv_set(text, jsonb, timestamptz)',
    'openauth_kv_remove(text)',
    'openauth_kv_scan(text)',
    'issue_auth_code(uuid, text, text, timestamptz)',
    'consume_auth_code(text, text)',
    'delete_user_sessions(uuid)',
    'purge_openauth_identity(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION crm.%s OWNER TO crm_identity_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION crm.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION crm.%s TO crm_app', fn);
  END LOOP;
END
$$;

-- --- Version stamp -----------------------------------------------------------

INSERT INTO crm.schema_version (version) VALUES (1);

COMMIT;
