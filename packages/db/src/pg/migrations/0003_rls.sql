-- 0003_rls.sql — row-level security and narrow identity resolvers per
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
-- to the policy; runtime roles are not owners anyway (0002).
--
-- crm.sessions and crm.schema_migrations get RLS with NO policy: combined
-- with zero grants in 0002 they are unreachable by every runtime role.

BEGIN;

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

-- Auth-issuer and deployment tables: RLS on, no policy, no grants → denied.
ALTER TABLE crm.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.schema_migrations FORCE ROW LEVEL SECURITY;

-- --- Narrow identity resolvers (doc §Identity before workspace context) -----
-- Global credential resolution is available ONLY through these two fixed
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

CREATE OR REPLACE FUNCTION crm.resolve_user_identity(p_email text)
RETURNS TABLE (user_id uuid, workspace_id uuid, role text, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, pg_temp
AS $$
  SELECT u.id, u.workspace_id, m.role, (u.disabled_at IS NULL)
  FROM crm.users u
  JOIN crm.memberships m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.email = lower(p_email)
$$;

CREATE OR REPLACE FUNCTION crm.resolve_mcp_key(p_token_hash text)
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
    (c.revoked_at IS NULL AND u.id IS NOT NULL AND u.disabled_at IS NULL)
  FROM crm.mcp_clients c
  LEFT JOIN crm.users u
    ON u.id = c.created_by_user_id AND u.workspace_id = c.workspace_id
  LEFT JOIN crm.memberships m
    ON m.user_id = u.id AND m.workspace_id = c.workspace_id
  WHERE c.token_hash = p_token_hash
$$;

ALTER FUNCTION crm.resolve_user_identity(text) OWNER TO crm_identity_resolver;
ALTER FUNCTION crm.resolve_mcp_key(text) OWNER TO crm_identity_resolver;
REVOKE ALL ON FUNCTION crm.resolve_user_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm.resolve_mcp_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.resolve_user_identity(text) TO crm_app;
GRANT EXECUTE ON FUNCTION crm.resolve_mcp_key(text) TO crm_app;

INSERT INTO crm.schema_migrations (version, name) VALUES (3, '0003_rls')
ON CONFLICT (version) DO NOTHING;

COMMIT;
