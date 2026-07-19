-- 0004_auth.sql — OpenAuth identity model: user lifecycle status, OpenAuth
-- subject linking, forced-password-change flag, issuer key-value storage,
-- setup/reset code bookkeeping, and the subject-keyed identity resolvers.
--
-- Design source: docs/architecture/postgres-tenant-isolation.md
--   §"Authentication tables"  — OpenAuth credentials, setup/reset codes and
--     verification state are GLOBAL ISSUER DATA, not workspace data. CRM
--     persistence ports cannot query them.
--   §"Identity before workspace context" — global credential resolution is
--     available only through fixed SECURITY DEFINER functions owned by a
--     dedicated non-login role.
--
-- RLS posture for the identity-level tables (openauth_kv, auth_codes, and the
-- pre-existing sessions):
--
--   These tables are NOT workspace-scoped — a credential exists before any
--   workspace context does (login is the step that DISCOVERS the workspace),
--   so a `workspace_id = crm.current_workspace_id()` policy is meaningless
--   for them. They follow the exact posture 0003 gave crm.sessions:
--   RLS ENABLE + FORCE with NO policy for any login role and ZERO grants to
--   crm_app / crm_operator — direct table access is denied to every runtime
--   login role. The ONLY sanctioned path is the fixed SECURITY DEFINER
--   functions below, owned by the non-login crm_identity_resolver, which
--   receives narrow per-command grants plus an explicit all-rows policy so
--   the fixed function bodies (and nothing else) can reach the rows. This
--   extends crm_identity_resolver's existing charter ("only the fixed
--   function bodies receive global identity access") from credential
--   RESOLUTION to credential STORAGE — one narrow definer role instead of a
--   second cluster-global role.
--
-- Grants summary after this migration:
--   crm_app       EXECUTE on the functions below; still NO direct access to
--                 sessions / openauth_kv / auth_codes / schema_migrations.
--   crm_operator  unchanged (workspace lifecycle only; no credential access).
--   crm_identity_resolver
--                 + SELECT,INSERT,UPDATE,DELETE on openauth_kv, auth_codes
--                 + SELECT,DELETE            on sessions
--                 (all consumed only inside its SECURITY DEFINER functions).

BEGIN;

-- --- 1. users: lifecycle status, OpenAuth subject, forced password change ---
--
-- status: 'pending'  invited, no credentials yet — may NOT authenticate;
--         'active'   normal user;
--         'disabled' login disabled by an admin — may NOT authenticate.
-- disabled_at stays (it is the human-visible "since when"); the CHECK below
-- keeps the pair coherent so no code path can produce a half-disabled user.
-- auth_subject is the OpenAuth `sub` claim: globally unique across the
-- deployment (isolation doc §"Uniqueness and information disclosure" allows
-- exactly this and the normalized email as deployment-wide identities).

ALTER TABLE crm.users
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN auth_subject text,
  ADD COLUMN password_must_change boolean NOT NULL DEFAULT false;

UPDATE crm.users SET status = 'disabled' WHERE disabled_at IS NOT NULL;

ALTER TABLE crm.users
  ADD CONSTRAINT users_status_ck CHECK (status IN ('pending', 'active', 'disabled')),
  ADD CONSTRAINT users_status_disabled_ck CHECK ((status = 'disabled') = (disabled_at IS NOT NULL));

CREATE UNIQUE INDEX users_auth_subject_ux ON crm.users (auth_subject) WHERE auth_subject IS NOT NULL;

-- --- 2. OpenAuth issuer storage (identity-level, NOT workspace-scoped) ------
--
-- Generic key-value store backing the public product's OpenAuth storage
-- adapter (tokens, authorization state, verification records). Keys are
-- opaque issuer-defined strings; values are issuer JSON; expires_at implements
-- storage TTL. Runtime access ONLY via crm.openauth_kv_* below.

CREATE TABLE crm.openauth_kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz
);
CREATE INDEX openauth_kv_expires_ix ON crm.openauth_kv (expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE crm.openauth_kv OWNER TO crm_schema_owner;
ALTER TABLE crm.openauth_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.openauth_kv FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_storage ON crm.openauth_kv
  TO crm_identity_resolver USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.openauth_kv TO crm_identity_resolver;

-- --- 3. Setup / reset code bookkeeping (identity-level) ---------------------
--
-- Column-parity with the SQLite v5 table (docs/auth-api.md): one row per
-- issued single-use code; only the SHA-256 hash is stored, plus the user's
-- email at issue time (redemption UIs are email+code shaped) and an attempts
-- counter for redemption throttling at the auth surface. Issuing a new code
-- for a (user, purpose) deletes the previous ones (single active code per
-- purpose); consumption is a single atomic UPDATE so a code can be redeemed
-- at most once under any concurrency. Rows die with their user (ON DELETE
-- CASCADE — FK enforcement is exempt from RLS by design, which is also what
-- lets user deletion cascade into sessions).

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
ALTER TABLE crm.auth_codes OWNER TO crm_schema_owner;
ALTER TABLE crm.auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.auth_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_storage ON crm.auth_codes
  TO crm_identity_resolver USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.auth_codes TO crm_identity_resolver;

-- --- 4. sessions: subject linkage + the fixed revocation path ---------------
--
-- Mirror of the SQLite v5 session columns: a session row records the OpenAuth
-- subject it was minted for and the refresh token to revoke at logout
-- (docs/auth-api.md §Sessions).
--
-- 0003 left crm.sessions with RLS-no-policy and zero grants. Disable/delete
-- revocation (docs/issues/0022) must end sessions pg-side inside the same
-- transaction, so the resolver role gains exactly SELECT (WHERE/RETURNING
-- visibility) + DELETE, consumed only by crm.delete_user_sessions below.
-- crm_app still cannot touch the table directly.

ALTER TABLE crm.sessions
  ADD COLUMN auth_subject text,
  ADD COLUMN auth_refresh text;

CREATE POLICY auth_storage ON crm.sessions
  TO crm_identity_resolver USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON crm.sessions TO crm_identity_resolver;

-- --- 5. Identity resolvers (subject-keyed) ----------------------------------
--
-- resolve_user_identity — the AUTHENTICATION authority — now keys on the
-- VERIFIED OpenAuth subject and returns a row ONLY for status = 'active'
-- users: pending and disabled users do not authenticate, full stop.
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

DROP FUNCTION IF EXISTS crm.resolve_user_identity(text);

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

-- MCP keys: the creating user must now be ACTIVE (pending creators cannot
-- lend authority any more than disabled ones — same resolver-enforced rule).
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
    (c.revoked_at IS NULL AND u.id IS NOT NULL AND u.status = 'active')
  FROM crm.mcp_clients c
  LEFT JOIN crm.users u
    ON u.id = c.created_by_user_id AND u.workspace_id = c.workspace_id
  LEFT JOIN crm.memberships m
    ON m.user_id = u.id AND m.workspace_id = c.workspace_id
  WHERE c.token_hash = p_token_hash
$$;

-- --- 6. Credential storage functions (the sanctioned runtime path) ----------
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

-- --- 7. Ownership + execution grants ----------------------------------------
-- Same model as 0003: owned by the non-login resolver role, EXECUTE revoked
-- from PUBLIC and granted only to crm_app.

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

INSERT INTO crm.schema_migrations (version, name) VALUES (4, '0004_auth')
ON CONFLICT (version) DO NOTHING;

COMMIT;
