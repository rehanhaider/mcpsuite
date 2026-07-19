-- 0005: hosted open registration (docs/auth-api.md §Hosted open registration).
-- Sessions may exist for a verified identity BEFORE its CRM user does
-- (trial-first signup): user_id becomes nullable and email carries the
-- adoption key. Mirrors SQLite migration v6-unprovisioned-sessions.
ALTER TABLE crm.sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE crm.sessions ADD COLUMN IF NOT EXISTS email text;
