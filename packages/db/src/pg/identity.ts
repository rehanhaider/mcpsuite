/**
 * PostgreSQL implementation of the identity adapter interface (../identity.ts).
 *
 * Every rule lives here, in TypeScript: sessions and adoption, the issuer
 * storage, code issue and redemption, ending sessions, and subject linking.
 * The database contributes row-level security and four read-only lookups
 * (schema.sql, "Cross-workspace lookups"): sign-in must find a user before a
 * workspace is bound, and a transaction without a workspace sees no user rows.
 *
 * The identity-level tables (sessions, openauth_kv, auth_codes) follow the
 * request's two phases. Unbound, rows are reachable and this module reads them
 * only by key (token hash, email, issuer key). Bound, only the workspace's
 * users' sessions and codes are reachable. Every statement that ends or
 * issues something for a user runs bound, and also names the bound
 * workspace's users explicitly.
 *
 * Every method runs in the request's ambient transaction (./tx.ts): it joins
 * one opened by `withTransaction`, `ports.tx` or another method, and
 * otherwise opens its own. Identity flows discover their workspace part-way
 * (a code or a key resolves it), so a transaction starts unbound and binds
 * once the workspace is known.
 *
 * The same store serves hosting control (crm_operator), which may only issue
 * codes, check that a password credential exists, and resolve a subject's
 * email — it can read issuer keys but never their values.
 *
 * Difference from the SQLite adapter, deliberate:
 *   - A disabled user's setup/reset code does not redeem.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { clampScopes, newId, OpError, type McpScope, type Role, type TrustProfile, type UserStatus } from "@mcpsuite/core";
import { SESSION_TTL_MS, type ResolvedMcpClient, type SessionUser, type UnprovisionedSession } from "../auth.ts";
import {
  AUTH_CODE_ISSUE_MAX,
  AUTH_CODE_ISSUE_WINDOW_MS,
  AUTH_CODE_MAX_ATTEMPTS,
  AUTH_CODE_TTL_MS,
  OPENAUTH_KEY_SEPARATOR,
  authPasswordKey,
  authSubjectKey,
  generateAuthCode,
  joinAuthKey,
  normalizeAuthCode,
  normalizeEmail,
  openAuthHashPassword,
  openAuthVerifyPassword,
  type AuthCodeVerification,
  type AuthKvStore,
  type AuthLinkResult,
  type OpenAuthScryptHash,
} from "../openauth.ts";
import type { IdentityStore, IdentityTestHooks } from "../identity.ts";
import type { PgDb } from "./repositories.ts";
import { bindAmbientWorkspace, inPgTransaction } from "./tx.ts";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Malformed ids must behave like random nonexistent ids, not type errors. */
const uid = (v: string): string => (UUID_RE.test(v) ? v : NIL_UUID);

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoN = (v: unknown): string | null => (v == null ? null : iso(v));

/** Walks err.cause chains for the SQLSTATE the pg driver attaches. */
const pgErrorCode = (e: unknown): string | undefined => {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
};

const rows = async <T = Record<string, unknown>>(x: PgDb, q: SQL): Promise<T[]> => {
  const res = (await x.execute(q)) as unknown;
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: unknown[] }).rows ?? []) as T[];
};

/** Issuer keys are path segments joined with the separator; prefixes match whole segments. */
const segmentPrefix = (segments: string[]): string => joinAuthKey(segments) + OPENAUTH_KEY_SEPARATOR;

/** The fixed identity fields the lookup functions return (schema.sql). */
interface IdentityRow {
  user_id: string;
  workspace_id: string;
  role: string;
  status: string;
  email: string;
  auth_subject: string | null;
  password_must_change: boolean;
  disabled_at: unknown;
}

/**
 * Remove the OpenAuth issuer's stored state for one identity: the password
 * hash and email → subject binding ("email" ␟ <email> ␟ …) and the subject's
 * refresh tokens ("oauth:refresh" ␟ <subject> ␟ …). Whole-segment prefixes
 * only — one email can sit inside another (bob@acme.com in jimbob@acme.com).
 * Used by permanent user and workspace deletion, before the user row goes.
 */
export async function purgeIssuerIdentity(x: PgDb, who: { email: string; subject: string | null }): Promise<void> {
  const emailPrefix = segmentPrefix(["email", normalizeEmail(who.email)]);
  if (who.subject) {
    const refreshPrefix = segmentPrefix(["oauth:refresh", who.subject]);
    await rows(
      x,
      sql`DELETE FROM crm.openauth_kv WHERE starts_with(key, ${emailPrefix}) OR starts_with(key, ${refreshPrefix})`,
    );
  } else {
    await rows(x, sql`DELETE FROM crm.openauth_kv WHERE starts_with(key, ${emailPrefix})`);
  }
}

export function createPgIdentity(db: PgDb, options: { hooks?: IdentityTestHooks } = {}): IdentityStore {
  const hooks = options.hooks ?? {};

  /** Run fn in the ambient transaction, unbound or bound to a workspace. */
  const inTx = <T>(workspaceId: string | null, fn: (x: PgDb) => Promise<T>): Promise<T> =>
    inPgTransaction(db, workspaceId === null ? null : uid(workspaceId), fn);

  const lookup = async (x: PgDb, q: SQL): Promise<IdentityRow | null> => (await rows<IdentityRow>(x, q))[0] ?? null;

  // --- issuer storage (crm.openauth_kv) ------------------------------------
  // Expired rows are invisible to reads; writes sweep them first.

  const expiryOf = (v: unknown): number | null => (v == null ? null : (v instanceof Date ? v : new Date(String(v))).getTime());

  const kvGet = async (x: PgDb, key: string): Promise<{ value: string; expiry: number | null } | null> => {
    const [row] = await rows<{ value: unknown; expires_at: unknown }>(
      x,
      sql`SELECT value, expires_at FROM crm.openauth_kv
          WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`,
    );
    return row ? { value: JSON.stringify(row.value), expiry: expiryOf(row.expires_at) } : null;
  };
  const kvSet = async (x: PgDb, key: string, value: string, expiry: number | null): Promise<void> => {
    const expiresAt = expiry == null ? null : new Date(expiry).toISOString();
    await rows(x, sql`DELETE FROM crm.openauth_kv WHERE expires_at IS NOT NULL AND expires_at <= now()`);
    await rows(
      x,
      sql`INSERT INTO crm.openauth_kv (key, value, expires_at) VALUES (${key}, ${value}::jsonb, ${expiresAt}::timestamptz)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
  };
  const kvRemove = async (x: PgDb, key: string): Promise<void> => {
    await rows(x, sql`DELETE FROM crm.openauth_kv WHERE key = ${key}`);
  };
  const kvScan = async (x: PgDb, prefix: string): Promise<Array<{ key: string; value: string; expiry: number | null }>> => {
    const found = await rows<{ key: string; value: unknown; expires_at: unknown }>(
      x,
      sql`SELECT key, value, expires_at FROM crm.openauth_kv
          WHERE starts_with(key, ${prefix}) AND (expires_at IS NULL OR expires_at > now())
          ORDER BY key`,
    );
    return found.map((r) => ({ key: r.key, value: JSON.stringify(r.value), expiry: expiryOf(r.expires_at) }));
  };

  const authKv: AuthKvStore = {
    get: (key) => inTx(null, (x) => kvGet(x, key)),
    set: (key, value, expiry) => inTx(null, (x) => kvSet(x, key, value, expiry)),
    remove: (key) => inTx(null, (x) => kvRemove(x, key)),
    scanPrefix: (prefix) => inTx(null, (x) => kvScan(x, prefix)),
  };

  /** A user's subject, read under the bound workspace (RLS). */
  const subjectOf = async (x: PgDb, userId: string): Promise<string | null> => {
    const [row] = await rows<{ auth_subject: string | null }>(
      x,
      sql`SELECT auth_subject FROM crm.users WHERE id = ${uid(userId)}::uuid`,
    );
    return row?.auth_subject ?? null;
  };

  /**
   * End a user's sign-ins: every CRM session and the issuer refresh tokens of
   * the user's subject. Runs bound; the statements also name the bound
   * workspace's users, so an unbound call ends nothing.
   */
  const endSessions = async (x: PgDb, userId: string): Promise<number> => {
    const subject = await subjectOf(x, userId);
    const ended = await rows(
      x,
      sql`DELETE FROM crm.sessions
          WHERE user_id = ${uid(userId)}::uuid AND user_id IN (SELECT id FROM crm.users)
          RETURNING 1`,
    );
    if (subject) {
      await rows(x, sql`DELETE FROM crm.openauth_kv WHERE starts_with(key, ${segmentPrefix(["oauth:refresh", subject])})`);
    }
    return ended.length;
  };

  /**
   * Redeem the way the redemption screens ask: email + purpose + code, against
   * the latest unused code, locked for the rest of the transaction so a code
   * is redeemed at most once under any concurrency. An expired code or one at
   * its attempt cap is refused; a wrong code counts an attempt (and burns the
   * code at the cap) — the caller returns rather than throws, so the attempt
   * commits. A concurrent redemption waits on the lock; when the holder has
   * used or burned the code, the row fails its re-check and PostgreSQL moves
   * on to the next unused row. There is none: issuing a code supersedes every
   * earlier unused code of the same purpose (issueCode, under the per-email
   * lock), so the waiter answers invalid_code, as SQLite does. Keep that
   * invariant — without it a waiter would fall through to an older live code.
   */
  const redeem = async (
    x: PgDb,
    input: { email: string; purpose: "setup" | "reset"; code: string },
  ): Promise<AuthCodeVerification & { workspaceId?: string }> => {
    const [code] = await rows<{ id: string; user_id: string; code_hash: string; attempts: number; expired: boolean }>(
      x,
      sql`SELECT id, user_id, code_hash, attempts, (expires_at <= now()) AS expired
          FROM crm.auth_codes
          WHERE email = ${normalizeEmail(input.email)} AND purpose = ${input.purpose} AND used_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
    );
    if (!code) return { ok: false, reason: "invalid_code" };
    if (code.expired) return { ok: false, reason: "expired_code" };
    if (code.attempts >= AUTH_CODE_MAX_ATTEMPTS) return { ok: false, reason: "rate_limited" };
    if (code.code_hash !== sha256Hex(normalizeAuthCode(input.code))) {
      const attempts = code.attempts + 1;
      const burned = attempts >= AUTH_CODE_MAX_ATTEMPTS;
      await rows(
        x,
        burned
          ? sql`UPDATE crm.auth_codes SET attempts = ${attempts}, used_at = now() WHERE id = ${code.id}::uuid`
          : sql`UPDATE crm.auth_codes SET attempts = ${attempts} WHERE id = ${code.id}::uuid`,
      );
      return { ok: false, reason: burned ? "rate_limited" : "invalid_code" };
    }
    const user = await lookup(x, sql`SELECT * FROM crm.identity_by_user_id(${code.user_id}::uuid)`);
    if (!user || user.status === "disabled") return { ok: false, reason: "invalid_code" };
    await rows(x, sql`UPDATE crm.auth_codes SET used_at = now() WHERE id = ${code.id}::uuid`);
    return { ok: true, userId: code.user_id, workspaceId: user.workspace_id };
  };

  const identity: IdentityStore = {
    withTransaction: (fn) => inTx(null, () => fn()),

    // --- sessions ---------------------------------------------------------

    createSession: (userId, link = {}) =>
      inTx(null, async (x) => {
        const token = `sess_${randomBytes(32).toString("hex")}`;
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        await rows(x, sql`DELETE FROM crm.sessions WHERE expires_at <= now()`);
        await rows(
          x,
          sql`INSERT INTO crm.sessions (id, token_hash, user_id, email, auth_subject, auth_refresh, expires_at, created_at)
              VALUES (gen_random_uuid(), ${sha256Hex(token)}, ${userId === null ? null : uid(userId)}::uuid,
                      ${link.email ? normalizeEmail(link.email) : null}, ${link.authSubject ?? null},
                      ${link.authRefresh ?? null}, ${expiresAt}::timestamptz, now())`,
        );
        return { token, expiresAt };
      }),

    // Resolve a session token to the CURRENT identity (token claims are never
    // authority), as resolveSessionAny in ../auth.ts. A user-less session is
    // adopted when an active user with its email now exists: the session's
    // subject is bound to that user once and the session row upgraded in
    // place. If that user already bound a different subject, the session can
    // never own it and is deleted. Otherwise it surfaces as unprovisioned.
    // Only active, enabled members resolve as a user.
    resolveSessionAny: async (token) => {
      if (!token) return null;
      return inTx(null, async (x) => {
        const [session] = await rows<{
          id: string;
          user_id: string | null;
          email: string | null;
          auth_subject: string | null;
          expired: boolean;
        }>(
          x,
          sql`SELECT id, user_id, email, auth_subject, (expires_at <= now()) AS expired
              FROM crm.sessions WHERE token_hash = ${sha256Hex(token)}`,
        );
        if (!session || session.expired) return null;

        let userId = session.user_id;
        if (userId === null) {
          if (!session.email) return null;
          const candidate = await lookup(x, sql`SELECT * FROM crm.identity_by_email(${session.email})`);
          if (!candidate || candidate.disabled_at != null || candidate.status !== "active") {
            return {
              unprovisioned: true,
              email: session.email,
              authSubject: session.auth_subject,
            } satisfies UnprovisionedSession;
          }
          if (candidate.auth_subject && session.auth_subject && candidate.auth_subject !== session.auth_subject) {
            await rows(x, sql`DELETE FROM crm.sessions WHERE id = ${session.id}::uuid`);
            return null;
          }
          await bindAmbientWorkspace(db, candidate.workspace_id);
          if (!candidate.auth_subject && session.auth_subject) {
            // Bind once: a sign-in binding a different subject at the same
            // moment wins the row; this session then conflicts and is deleted.
            const bound = await rows(
              x,
              sql`UPDATE crm.users SET auth_subject = ${session.auth_subject}, updated_at = now()
                  WHERE id = ${candidate.user_id}::uuid AND auth_subject IS NULL
                  RETURNING id`,
            );
            if (bound.length === 0 && (await subjectOf(x, candidate.user_id)) !== session.auth_subject) {
              await rows(x, sql`DELETE FROM crm.sessions WHERE id = ${session.id}::uuid`);
              return null;
            }
          }
          await rows(
            x,
            sql`UPDATE crm.sessions SET user_id = ${candidate.user_id}::uuid, email = NULL WHERE id = ${session.id}::uuid`,
          );
          userId = candidate.user_id;
        }

        const member = await lookup(x, sql`SELECT * FROM crm.identity_by_user_id(${userId}::uuid)`);
        if (!member || member.status !== "active" || member.disabled_at != null) return null;
        // The lookup returns fixed identity fields only; the profile is read
        // inside the resolved workspace, under row-level security.
        await bindAmbientWorkspace(db, member.workspace_id);
        const [profile] = await rows<{
          email: string;
          name: string;
          status: string;
          has_password: boolean;
          disabled_at: unknown;
          created_at: unknown;
        }>(
          x,
          sql`SELECT email, name, status, (password_hash IS NOT NULL) AS has_password, disabled_at, created_at
              FROM crm.users WHERE id = ${member.user_id}::uuid`,
        );
        if (!profile) return null;
        const role = member.role as Role;
        return {
          user: {
            id: member.user_id,
            email: profile.email,
            name: profile.name,
            role,
            status: profile.status as UserStatus,
            hasPassword: profile.has_password === true,
            disabledAt: isoN(profile.disabled_at),
            createdAt: iso(profile.created_at),
          },
          workspaceId: member.workspace_id,
          role,
          passwordMustChange: member.password_must_change === true,
          authSubject: session.auth_subject,
        } satisfies SessionUser;
      });
    },

    async resolveSession(token) {
      const resolved = await identity.resolveSessionAny(token);
      return resolved && !("unprovisioned" in resolved) ? resolved : null;
    },

    destroySession: (token) =>
      inTx(null, async (x) => {
        const [row] = await rows<{ auth_refresh: string | null }>(
          x,
          sql`DELETE FROM crm.sessions WHERE token_hash = ${sha256Hex(token)} RETURNING auth_refresh`,
        );
        const refresh = row?.auth_refresh;
        if (!refresh) return;
        // Refresh token format is "<subject>:<id>" (OpenAuth issuer.ts).
        const idx = refresh.lastIndexOf(":");
        if (idx > 0) await kvRemove(x, joinAuthKey(["oauth:refresh", refresh.slice(0, idx), refresh.slice(idx + 1)]));
      }),

    endUserSessions: (workspaceId, userId) =>
      inTx(workspaceId, async (x) => {
        if (!(await memberVisible(x, userId))) throw OpError.notFound("user", userId);
        return endSessions(x, userId);
      }),

    // --- login storage ----------------------------------------------------

    authKv,
    setPassword: (email, password) =>
      inTx(null, (x) => kvSet(x, authPasswordKey(email), JSON.stringify(openAuthHashPassword(password)), null)),
    verifyPassword: (email, password) =>
      inTx(null, async (x) => {
        const stored = await kvGet(x, authPasswordKey(email));
        return stored != null && openAuthVerifyPassword(password, JSON.parse(stored.value) as OpenAuthScryptHash);
      }),
    // Key and expiry only — hosting control may not read credential values.
    hasPasswordCredential: (email) =>
      inTx(null, async (x) => {
        const found = await rows(
          x,
          sql`SELECT 1 FROM crm.openauth_kv
              WHERE key = ${authPasswordKey(email)} AND (expires_at IS NULL OR expires_at > now())`,
        );
        return found.length === 1;
      }),

    // --- codes ------------------------------------------------------------

    issueCode: (workspaceId, userId, purpose) =>
      inTx(workspaceId, async (x) => {
        if (purpose !== "setup" && purpose !== "reset") {
          throw OpError.validation(`Unknown credential code purpose: ${String(purpose)}`);
        }
        const [user] = await rows<{ email: string; status: string }>(
          x,
          sql`SELECT email, status FROM crm.users WHERE id = ${uid(userId)}::uuid`,
        );
        if (!user || user.status === "disabled") throw OpError.notFound("user", userId);

        // Issue rate limit per email, same window and cap as the SQLite
        // adapter, counted from the code rows themselves (superseded codes are
        // marked used, not deleted). The per-email lock makes concurrent issues
        // count one another.
        await rows(x, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcpsuite:code-issue:${normalizeEmail(user.email)}`}, 0))`);
        const [recent] = await rows<{ n: number }>(
          x,
          sql`SELECT count(*)::int AS n FROM crm.auth_codes
              WHERE email = ${user.email} AND created_at > now() - ${AUTH_CODE_ISSUE_WINDOW_MS} * interval '1 millisecond'`,
        );
        if (Number(recent?.n ?? 0) >= AUTH_CODE_ISSUE_MAX) {
          throw new OpError("conflict", "Too many codes issued for this email — wait a few minutes and try again");
        }

        const code = generateAuthCode();
        const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS[purpose]).toISOString();
        // Supersede: completing an old code and regenerating cannot both succeed.
        await rows(
          x,
          sql`UPDATE crm.auth_codes SET used_at = now()
              WHERE user_id = ${uid(userId)}::uuid AND purpose = ${purpose} AND used_at IS NULL`,
        );
        await rows(
          x,
          sql`INSERT INTO crm.auth_codes (user_id, email, purpose, code_hash, expires_at)
              VALUES (${uid(userId)}::uuid, ${user.email}, ${purpose}, ${sha256Hex(normalizeAuthCode(code))}, ${expiresAt}::timestamptz)`,
        );
        if (purpose === "reset") await endSessions(x, userId);
        return { code, expiresAt };
      }),

    verifyAndConsumeCode: (input) =>
      inTx(null, async (x) => {
        const verdict = await redeem(x, input);
        return verdict.ok ? { ok: true as const, userId: verdict.userId } : verdict;
      }),

    redeemCodeAndSetPassword: (input) =>
      inTx(null, async (x) => {
        const verdict = await redeem(x, input);
        // A wrong guess commits its attempt count; only success continues.
        if (!verdict.ok) return verdict;
        await hooks.afterCodeConsumed?.();
        await bindAmbientWorkspace(db, verdict.workspaceId!);
        await kvSet(x, authPasswordKey(input.email), JSON.stringify(openAuthHashPassword(input.password)), null);
        // A self-chosen password satisfies any forced-change requirement.
        const cleared = await rows(
          x,
          sql`UPDATE crm.users SET password_must_change = false, updated_at = now()
              WHERE id = ${verdict.userId}::uuid RETURNING id`,
        );
        if (cleared.length !== 1) throw new Error("Code redemption could not reach its user in the bound workspace");
        if (input.purpose === "reset") await endSessions(x, verdict.userId);
        return { ok: true as const, userId: verdict.userId };
      }),

    // --- identity linking -------------------------------------------------

    resolveAuthSuccess: (email, opts = {}) =>
      inTx(null, async (x): Promise<AuthLinkResult> => {
        const normalized = normalizeEmail(email);
        // One sign-in success per email at a time, as SQLite's connection lock
        // gives: without it two simultaneous first sign-ins each mint a
        // subject (open registration) and the later write wins. The lock is
        // transaction-scoped, so it releases at commit or rollback.
        await rows(x, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcpsuite:auth-success:${normalized}`}, 0))`);
        const found = await lookup(x, sql`SELECT * FROM crm.identity_by_email(${normalized})`);
        const user = found && { ...found, subject_linked: found.auth_subject !== null };
        if (!user) {
          if (!opts.openRegistration) return { status: "not_invited" };
          // Hosted open registration: a verified email without a CRM user gets
          // a stable subject and an unprovisioned session. Reuse a subject
          // minted for this email earlier (login before provisioning).
          const prior = await kvGet(x, authSubjectKey(normalized));
          const priorValue = prior == null ? null : (JSON.parse(prior.value) as unknown);
          const subject =
            typeof priorValue === "string" && priorValue.startsWith("acct_") ? priorValue : `acct_${newId()}`;
          await hooks.afterSubjectBound?.();
          await kvSet(x, authSubjectKey(normalized), JSON.stringify(subject), null);
          return { status: "unprovisioned", subject };
        }
        if (user.status === "disabled") return { status: "disabled" };

        await bindAmbientWorkspace(db, user.workspace_id);
        let subject: string;
        if (user.subject_linked) {
          subject = (await subjectOf(x, user.user_id))!;
          if (user.status === "pending") {
            // Defensive: a bound subject implies an activated account.
            await rows(x, sql`UPDATE crm.users SET status = 'active', updated_at = now() WHERE id = ${user.user_id}::uuid`);
          }
        } else {
          // First successful sign-in (pending invite, or an active user after
          // an owner-recovery code): bind the subject once and activate. The
          // `auth_subject IS NULL` guard makes the bind happen exactly once
          // under concurrency: a second sign-in racing this one waits on the
          // row, finds it already bound, and adopts that subject instead of
          // overwriting it.
          const minted = `acct_${newId()}`;
          let bound: Array<{ id: string }>;
          try {
            bound = await rows<{ id: string }>(
              x,
              sql`UPDATE crm.users SET auth_subject = ${minted}, status = 'active', updated_at = now()
                  WHERE id = ${user.user_id}::uuid AND auth_subject IS NULL AND status <> 'disabled' RETURNING id`,
            );
          } catch (e) {
            if (pgErrorCode(e) === "23505") throw new OpError("conflict", "That login identity is already linked to another user");
            throw e;
          }
          if (bound.length === 1) {
            subject = minted;
          } else {
            // Changed since the lookup: bound by another sign-in, or
            // disabled by an admin in between.
            const [current] = await rows<{ status: string; auth_subject: string | null }>(
              x,
              sql`SELECT status, auth_subject FROM crm.users WHERE id = ${user.user_id}::uuid`,
            );
            if (current?.status === "disabled") return { status: "disabled" };
            if (!current?.auth_subject) throw new OpError("conflict", "The account changed during sign-in — try again");
            subject = current.auth_subject;
          }
        }
        await hooks.afterSubjectBound?.();
        await kvSet(x, authSubjectKey(normalized), JSON.stringify(subject), null);
        return { status: "linked", userId: user.user_id, subject };
      }),

    findUserByAuthSubject: (subject) =>
      inTx(null, async (x) => {
        const row = await lookup(x, sql`SELECT * FROM crm.identity_by_subject(${subject})`);
        return row ? { id: row.user_id, workspaceId: row.workspace_id, status: row.status, email: row.email } : null;
      }),

    emailForAuthSubject: (subject) =>
      inTx(null, async (x) => {
        const [row] = await rows<{ email: string | null }>(x, sql`SELECT crm.email_for_auth_subject(${subject}) AS email`);
        return row?.email ?? null;
      }),

    // --- MCP keys ---------------------------------------------------------

    resolveMcpToken: async (bearerToken) => {
      if (!bearerToken) return null;
      return inTx(null, async (x): Promise<ResolvedMcpClient | null> => {
        const [key] = await rows<{
          client_id: string;
          workspace_id: string;
          user_id: string | null;
          role: string | null;
          scopes: unknown;
          trust: string;
          enabled: boolean;
        }>(x, sql`SELECT * FROM crm.resolve_mcp_key(${sha256Hex(bearerToken)})`);
        // Revoked, creator gone/disabled/pending, or creator no longer a member.
        if (!key || !key.enabled || !key.user_id || !key.role) return null;
        await bindAmbientWorkspace(db, key.workspace_id);
        const [client] = await rows<{ name: string }>(
          x,
          sql`UPDATE crm.mcp_clients SET last_used_at = now() WHERE id = ${key.client_id}::uuid RETURNING name`,
        );
        if (!client) return null;
        const role = key.role as Role;
        const scopes = Array.isArray(key.scopes) ? (key.scopes as McpScope[]) : [];
        return {
          clientId: key.client_id,
          workspaceId: key.workspace_id,
          name: client.name,
          scopes: clampScopes(scopes, role),
          trust: key.trust as TrustProfile,
          userId: key.user_id,
          role,
        };
      });
    },

    // --- gates ------------------------------------------------------------

    // Hosting control's lock/expiry for the workspace (crm.workspace_access_state,
    // same contract as ../hosting-access.ts): no row → active; locked, or
    // active with an expiry at or before now → locked.
    workspaceAccess: (workspaceId) =>
      inTx(workspaceId, async (x) => {
        const [row] = await rows<{ access_mode: string; access_expires_at: unknown }>(
          x,
          sql`SELECT access_mode, access_expires_at FROM crm.workspace_access_state(${uid(workspaceId)}::uuid)`,
        );
        if (!row) return { mode: "active" as const, expiresAt: null };
        const expiresAt = isoN(row.access_expires_at);
        const locked = row.access_mode === "locked" || (expiresAt !== null && expiresAt <= new Date().toISOString());
        return { mode: locked ? ("locked" as const) : ("active" as const), expiresAt };
      }),

    passwordMustChange: (workspaceId, userId) =>
      inTx(workspaceId, async (x) => {
        const [row] = await rows<{ flag: boolean }>(
          x,
          sql`SELECT password_must_change AS flag FROM crm.users WHERE id = ${uid(userId)}::uuid`,
        );
        return row?.flag === true;
      }),
  };

  /** A user visible in the bound workspace. */
  async function memberVisible(x: PgDb, userId: string): Promise<boolean> {
    const [row] = await rows<{ id: string }>(x, sql`SELECT id FROM crm.users WHERE id = ${uid(userId)}::uuid`);
    return row != null;
  }

  return identity;
}
