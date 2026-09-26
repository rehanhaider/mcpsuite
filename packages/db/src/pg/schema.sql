-- schema.sql — the complete hand-written PostgreSQL schema for the hosted
-- multi-tenant deployment: crm tables, same-workspace composite foreign keys,
-- roles and least-privilege grants, forced row-level security, the read-only
-- SECURITY DEFINER cross-workspace lookups, hosting control's private
-- `hosting` schema, and the schema_version stamp. Applied in ONE transaction by src/pg/init.ts (or `psql -f`) — only
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

-- Global auth-issuer data, scoped by the identity-storage policies below
-- (§Row-level security). A session
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
-- storage TTL. Scoped by the identity-storage policies below; hosting control
-- may read keys but never values.

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
-- (user, purpose) marks the previous ones used (single active code per
-- purpose), so the rows also count issues for the per-email rate limit;
-- redemption locks the code row, so a code is redeemed at most once under any
-- concurrency (src/pg/identity.ts). Rows die with their user (ON DELETE CASCADE —
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

-- Deployment-only stamp: what schema is on disk (only hosting control may read
-- it, see below). A future updater reads it to pick its upgrade steps.
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
--   crm_identity_resolver  NOLOGIN  owns the read-only cross-workspace lookups
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

-- Identity-level tables (sessions, openauth_kv, auth_codes). A credential
-- exists before any workspace context does — sign-in DISCOVERS the workspace
-- — so these carry no workspace_id. The runtime reaches them directly; the
-- policies below scope them (§Row-level security):
--   crm_app       full access: the web process signs users in and keeps the
--                 OpenAuth issuer storage.
--   crm_operator  what provisioning, owner recovery and deletion need: codes
--                 for its bound workspace's users, ending their sessions, and
--                 issuer keys by name. Column grants withhold every credential
--                 — openauth_kv.value, sessions.token_hash/auth_refresh,
--                 auth_codes.code_hash — so hosting control cannot read one.
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.sessions, crm.openauth_kv, crm.auth_codes TO crm_app;
GRANT SELECT (user_id), DELETE ON crm.sessions TO crm_operator;
GRANT SELECT (user_id, email, purpose, created_at, used_at), INSERT, UPDATE (used_at) ON crm.auth_codes TO crm_operator;
GRANT SELECT (key, expires_at), DELETE ON crm.openauth_kv TO crm_operator;

-- The non-login resolver role owns the read-only lookup functions below
-- (§Cross-workspace lookups) and may read exactly what they return. It has no
-- other access.
GRANT SELECT ON crm.users, crm.memberships, crm.mcp_clients, crm.openauth_kv TO crm_identity_resolver;

-- crm.schema_version is deployment metadata: crm_app has no grant; hosting
-- control may read it (health check, below).

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
-- workspace-scoped: a credential exists before any workspace context does
-- (sign-in is the step that DISCOVERS the workspace). Their policies follow
-- the request's two phases:
--   unbound (app.workspace_id not set — sign-in, session and code lookups):
--     rows are reachable, and the adapter reads them only by key (token
--     hash, email, code, issuer key). A set but malformed workspace is NOT
--     unbound: it sees no user rows, so it reaches nothing (deny by default);
--   bound (the transaction has its workspace): only rows of that
--     workspace's users are reachable — the policy's sub-select on crm.users
--     runs under the users table's own workspace policy.
-- crm_operator is always bound when it touches them. Cross-workspace reads
-- of users, memberships and mcp_clients happen only through the read-only
-- lookup functions below, so a transaction without a workspace sees zero
-- rows of every workspace table. schema_version is denied to crm_app
-- (hosting control may read it).
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

-- Identity-level and deployment tables: RLS on and forced; the policies
-- below admit exactly the phases described above.
ALTER TABLE crm.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.openauth_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.openauth_kv FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.auth_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_version FORCE ROW LEVEL SECURITY;

-- crm_app: the issuer storage is keyed global data; sessions and codes are
-- reachable unbound (by key) and, once bound, only for the workspace's users.
-- A bound transaction may also reach sessions with no user yet (hosted open
-- registration): adoption upgrades such a row after binding its workspace.
CREATE POLICY identity_storage ON crm.openauth_kv
  TO crm_app USING (true) WITH CHECK (true);
CREATE POLICY identity_storage ON crm.sessions
  TO crm_app
  USING (coalesce(current_setting('app.workspace_id', true), '') = ''
         OR (crm.current_workspace_id() IS NOT NULL AND user_id IS NULL)
         OR user_id IN (SELECT id FROM crm.users))
  WITH CHECK (coalesce(current_setting('app.workspace_id', true), '') = ''
         OR (crm.current_workspace_id() IS NOT NULL AND user_id IS NULL)
         OR user_id IN (SELECT id FROM crm.users));
CREATE POLICY identity_storage ON crm.auth_codes
  TO crm_app
  USING (coalesce(current_setting('app.workspace_id', true), '') = '' OR user_id IN (SELECT id FROM crm.users))
  WITH CHECK (coalesce(current_setting('app.workspace_id', true), '') = '' OR user_id IN (SELECT id FROM crm.users));

-- crm_operator: only its bound workspace's users' sessions and codes; issuer
-- keys by name (the column grants withhold every credential).
CREATE POLICY operator_storage ON crm.openauth_kv
  TO crm_operator USING (true);
CREATE POLICY operator_storage ON crm.sessions
  TO crm_operator USING (user_id IN (SELECT id FROM crm.users));
CREATE POLICY operator_storage ON crm.auth_codes
  TO crm_operator
  USING (user_id IN (SELECT id FROM crm.users))
  WITH CHECK (user_id IN (SELECT id FROM crm.users));

-- --- Cross-workspace lookups (doc §Identity before workspace context) -------
-- Sign-in, session and MCP key resolution must find a user before any
-- workspace is bound, and a transaction without a workspace sees no user
-- rows. These read-only SECURITY DEFINER functions, owned by the non-login
-- crm_identity_resolver, answer exactly one keyed question each — a single
-- SELECT, no writes, no logic. Every rule about what a match MEANS (who may
-- sign in, adoption, code redemption) lives in the adapter
-- (src/pg/identity.ts), not here. They never list or search.

CREATE POLICY identity_resolution ON crm.users
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY identity_resolution ON crm.memberships
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY identity_resolution ON crm.mcp_clients
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY email_lookup ON crm.openauth_kv
  FOR SELECT TO crm_identity_resolver USING (true);

-- The member behind an email, a verified OpenAuth subject, or a user id — in
-- any status (the caller decides what the status allows) — with the fixed
-- identity fields sign-in needs. Never names, password material or lists.
CREATE FUNCTION crm.identity_by_email(p_email text)
RETURNS TABLE (
  user_id uuid,
  workspace_id uuid,
  role text,
  status text,
  email text,
  auth_subject text,
  password_must_change boolean,
  disabled_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, u.status, u.email, u.auth_subject, u.password_must_change, u.disabled_at
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.email = lower(p_email)
$$;

CREATE FUNCTION crm.identity_by_subject(p_subject text)
RETURNS TABLE (
  user_id uuid,
  workspace_id uuid,
  role text,
  status text,
  email text,
  auth_subject text,
  password_must_change boolean,
  disabled_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, u.status, u.email, u.auth_subject, u.password_must_change, u.disabled_at
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.auth_subject IS NOT NULL AND u.auth_subject = p_subject
$$;

CREATE FUNCTION crm.identity_by_user_id(p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  workspace_id uuid,
  role text,
  status text,
  email text,
  auth_subject text,
  password_must_change boolean,
  disabled_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, u.status, u.email, u.auth_subject, u.password_must_change, u.disabled_at
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.id = p_user_id
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

-- Reverse lookup: the verified email an OpenAuth subject was minted for, from
-- the issuer's email → subject records ("email" ␟ <email> ␟ "subject").
CREATE FUNCTION crm.email_for_auth_subject(p_subject text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT split_part(key, chr(31), 2)
  FROM crm.openauth_kv
  WHERE starts_with(key, 'email' || chr(31))
    AND array_length(string_to_array(key, chr(31)), 1) = 3
    AND split_part(key, chr(31), 3) = 'subject'
    AND value = to_jsonb(p_subject)
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY key
  LIMIT 1
$$;

-- =============================================================================
-- Hosting control — the `hosting` schema (packages/hosting-control).
--
-- The private hosting control service connects as crm_operator, with its own
-- DATABASE_URL. Its own records live here, reachable by crm_operator only:
--
--   idempotency_receipts  one row per Idempotency-Key (replay / conflict);
--   service_audit         append-mostly log of every hosting request; after
--                         permanent deletion only the one-way target hash
--                         remains (workspace_id is set NULL);
--   auth_delivery_outbox  setup/reset code deliveries awaiting send;
--   workspace_access      the lock/expiry state the CRM enforces.
--
-- Receipts and the service audit are hosting control's own records, not
-- workspace data: a receipt is read before any target is known, so their
-- policies admit crm_operator on every row. workspace_access and the outbox
-- are workspace data: their policies admit only the transaction's
-- workspace, as for the crm tables. The one read across workspaces is the
-- delivery sweep's list of pending deliveries, through the fixed definer
-- hosting.pending_auth_deliveries() (ids and purpose only).
--
-- crm_app has no USAGE on this schema. The CRM reads the access state of its
-- OWN workspace only through crm.workspace_access_state (below).
--
-- Rows of a deleted workspace: workspace_access and the outbox cascade from
-- crm.workspaces; the service audit has no foreign key (it outlives the
-- workspace, redacted).
-- =============================================================================

CREATE SCHEMA hosting;

CREATE TABLE hosting.idempotency_receipts (
  idempotency_key text PRIMARY KEY,
  action          text NOT NULL,
  request_hash    text NOT NULL,
  target_hash     text,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  http_status     integer,
  response_body   text,
  request_id      text NOT NULL,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz
);

CREATE TABLE hosting.workspace_access (
  workspace_id      uuid PRIMARY KEY REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  access_mode       text NOT NULL DEFAULT 'active' CHECK (access_mode IN ('active', 'locked')),
  access_expires_at timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

-- workspace_id is text: a request may name an id that never existed.
CREATE TABLE hosting.service_audit (
  id               uuid PRIMARY KEY,
  request_id       text NOT NULL,
  idempotency_key  text,
  action           text NOT NULL,
  method           text NOT NULL,
  path             text NOT NULL,
  workspace_id     text,
  target_hash      text,
  reason           text,
  service_identity text NOT NULL,
  result_code      text NOT NULL,
  http_status      integer NOT NULL,
  retryable        boolean NOT NULL DEFAULT false,
  product_version  text,
  started_at       timestamptz NOT NULL,
  completed_at     timestamptz NOT NULL
);
CREATE INDEX service_audit_ws_ix ON hosting.service_audit (workspace_id);
CREATE INDEX service_audit_hash_ix ON hosting.service_audit (target_hash);

CREATE TABLE hosting.auth_delivery_outbox (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('setup', 'reset')),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'abandoned')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX auth_outbox_state_ix ON hosting.auth_delivery_outbox (state, created_at);
CREATE INDEX auth_outbox_ws_ix ON hosting.auth_delivery_outbox (workspace_id);

ALTER SCHEMA hosting OWNER TO crm_schema_owner;
ALTER TABLE hosting.idempotency_receipts OWNER TO crm_schema_owner;
ALTER TABLE hosting.workspace_access OWNER TO crm_schema_owner;
ALTER TABLE hosting.service_audit OWNER TO crm_schema_owner;
ALTER TABLE hosting.auth_delivery_outbox OWNER TO crm_schema_owner;

REVOKE ALL ON SCHEMA hosting FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hosting FROM PUBLIC;
GRANT USAGE ON SCHEMA hosting TO crm_operator, crm_identity_resolver;

GRANT SELECT, INSERT, UPDATE, DELETE ON hosting.idempotency_receipts TO crm_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON hosting.workspace_access TO crm_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON hosting.auth_delivery_outbox TO crm_operator;
-- Audit rows are never deleted; UPDATE exists for the deletion redaction.
GRANT SELECT, INSERT, UPDATE ON hosting.service_audit TO crm_operator;
-- The access-state reader below.
GRANT SELECT ON hosting.workspace_access TO crm_identity_resolver;
-- The delivery sweep's reader below.
GRANT SELECT ON hosting.auth_delivery_outbox TO crm_identity_resolver;

ALTER TABLE hosting.idempotency_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.idempotency_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE hosting.service_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.service_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE hosting.auth_delivery_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.auth_delivery_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE hosting.workspace_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.workspace_access FORCE ROW LEVEL SECURITY;

CREATE POLICY operator_records ON hosting.idempotency_receipts
  TO crm_operator USING (true) WITH CHECK (true);
CREATE POLICY operator_records ON hosting.service_audit
  TO crm_operator USING (true) WITH CHECK (true);
CREATE POLICY workspace_isolation ON hosting.workspace_access
  TO crm_operator
  USING (workspace_id = crm.current_workspace_id())
  WITH CHECK (workspace_id = crm.current_workspace_id());
CREATE POLICY access_state_read ON hosting.workspace_access
  FOR SELECT TO crm_identity_resolver USING (true);
CREATE POLICY workspace_isolation ON hosting.auth_delivery_outbox
  TO crm_operator
  USING (workspace_id = crm.current_workspace_id())
  WITH CHECK (workspace_id = crm.current_workspace_id());
CREATE POLICY delivery_sweep ON hosting.auth_delivery_outbox
  FOR SELECT TO crm_identity_resolver USING (true);

-- The delivery sweep's input (crm_operator): every pending delivery, oldest
-- first, as hosting control's own references — outbox id, workspace, user and
-- purpose. No email, no code, no CRM data. Each row is then handled in a
-- transaction bound to its workspace.
CREATE FUNCTION hosting.pending_auth_deliveries()
RETURNS TABLE (id uuid, workspace_id uuid, user_id uuid, purpose text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = hosting, pg_temp
AS $$
  SELECT o.id, o.workspace_id, o.user_id, o.purpose, o.attempts
  FROM hosting.auth_delivery_outbox o
  WHERE o.state = 'pending'
  ORDER BY o.created_at
$$;
ALTER FUNCTION hosting.pending_auth_deliveries() OWNER TO crm_identity_resolver;
REVOKE ALL ON FUNCTION hosting.pending_auth_deliveries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hosting.pending_auth_deliveries() TO crm_operator;

-- The CRM's read of its own workspace's access state (crm_app). Returns the
-- stored row only when p_workspace_id is the transaction's workspace — never
-- another workspace's, never a list. No row means the workspace is active;
-- the caller applies expiry at read time.
CREATE FUNCTION crm.workspace_access_state(p_workspace_id uuid)
RETURNS TABLE (access_mode text, access_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT a.access_mode, a.access_expires_at
  FROM hosting.workspace_access a
  WHERE a.workspace_id = p_workspace_id
    AND p_workspace_id = crm.current_workspace_id()
$$;

-- The deployment stamp, readable (not writable) by hosting control for its
-- health check.
GRANT SELECT ON crm.schema_version TO crm_operator;
CREATE POLICY operator_read ON crm.schema_version
  FOR SELECT TO crm_operator USING (true);

-- --- Ownership + execution grants -------------------------------------------
-- Owned by the non-login resolver role, EXECUTE revoked from PUBLIC and
-- granted to crm_app. Hosting control resolves a verified subject to its
-- email when it provisions a trial-first owner; it calls nothing else here.

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'identity_by_email(text)',
    'identity_by_subject(text)',
    'identity_by_user_id(uuid)',
    'resolve_mcp_key(text)',
    'email_for_auth_subject(text)',
    'workspace_access_state(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION crm.%s OWNER TO crm_identity_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION crm.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION crm.%s TO crm_app', fn);
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION crm.email_for_auth_subject(text) TO crm_operator;

-- --- Version stamp -----------------------------------------------------------

INSERT INTO crm.schema_version (version) VALUES (1);

COMMIT;
