-- 0001_schema.sql — crm schema: tables, same-workspace composite foreign keys,
-- uniqueness, indexes. Hand-written; applied in order by src/pg/migrate.ts (or
-- psql -f) using a deployment role (crm_migrator/superuser), never a runtime
-- role. Requires PostgreSQL >= 15 (ON DELETE SET NULL (column) form; target is
-- PostgreSQL 17).
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
--
-- Roles/grants land in 0002; RLS policies and identity resolvers in 0003.

BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;

-- Deployment-only bookkeeping (no runtime grants; RLS-denied in 0003).
CREATE TABLE IF NOT EXISTS crm.schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

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
CREATE TABLE crm.users (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES crm.workspaces (id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX users_email_ux ON crm.users (email);
CREATE INDEX users_ws_ix ON crm.users (workspace_id);

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

-- Global auth-issuer data. No runtime grants, RLS-denied in 0003; identity
-- resolution happens only through the narrow resolver functions.
CREATE TABLE crm.sessions (
  id         uuid PRIMARY KEY,
  token_hash text NOT NULL,
  user_id    uuid NOT NULL REFERENCES crm.users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
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

INSERT INTO crm.schema_migrations (version, name) VALUES (1, '0001_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
