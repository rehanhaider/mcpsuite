-- 0002_roles_grants.sql — PostgreSQL roles and least-privilege grants per
-- docs/architecture/postgres-tenant-isolation.md §"PostgreSQL roles".
--
--   crm_schema_owner       NOLOGIN  owns every crm object and policy
--   crm_identity_resolver  NOLOGIN  owns the two narrow resolver functions
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

BEGIN;

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
-- login role can ever use table-owner RLS bypass (FORCE in 0003 closes the
-- rest). Functions created in 0003 set their own ownership.
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
-- is still gated by the forced RLS policies in 0003.
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

-- The identity resolver role reads only the identity tables its two fixed
-- SECURITY DEFINER functions (0003) need. It has no login and no other access.
GRANT SELECT ON crm.users, crm.memberships, crm.mcp_clients TO crm_identity_resolver;

-- crm.sessions and crm.schema_migrations receive NO runtime grants at all:
-- sessions are auth-issuer data owned by the product's auth storage adapter;
-- schema_migrations is deployment-only metadata.

-- Deliberately NO "ALTER DEFAULT PRIVILEGES ... GRANT" here: a newly created
-- table is inaccessible to every runtime role until a migration explicitly
-- classifies it, grants it, and adds its RLS policy (doc §Table
-- classification: "new tables default to inaccessible").

INSERT INTO crm.schema_migrations (version, name) VALUES (2, '0002_roles_grants')
ON CONFLICT (version) DO NOTHING;

COMMIT;
