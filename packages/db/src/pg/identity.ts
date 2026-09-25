/**
 * PostgreSQL implementation of the identity adapter interface (../identity.ts).
 *
 * The runtime login role (crm_app) has no grants on the identity-level tables
 * (sessions, openauth_kv, auth_codes): every read and write there goes
 * through the fixed SECURITY DEFINER functions in schema.sql. Anything that
 * touches workspace-owned rows (users, mcp_clients) binds the transaction to
 * that workspace first, so forced row-level security still applies.
 *
 * Every method runs in the request's ambient transaction (./tx.ts): it joins
 * one opened by `withTransaction`, `ports.tx` or another method, and
 * otherwise opens its own. Identity flows discover their workspace part-way
 * (a code or a key resolves it), so a transaction starts unbound and binds
 * once the workspace is known.
 *
 * Differences from the SQLite adapter, both deliberate:
 *   - Workspace access always resolves `active`. The hosting-control access
 *     table does not exist on PostgreSQL until #5 adds it; this stub is
 *     replaced there, not wrapped.
 *   - A disabled user's setup/reset code does not redeem
 *     (crm.redeem_auth_code), as crm.consume_auth_code already behaves.
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

/** Rate-limit record for code issuance, kept in the issuer's storage. */
const issueLogKey = (email: string): string => joinAuthKey(["mcpsuite:code-issue", normalizeEmail(email)]);

export function createPgIdentity(db: PgDb, options: { hooks?: IdentityTestHooks } = {}): IdentityStore {
  const hooks = options.hooks ?? {};

  /** Run fn in the ambient transaction, unbound or bound to a workspace. */
  const inTx = <T>(workspaceId: string | null, fn: (x: PgDb) => Promise<T>): Promise<T> =>
    inPgTransaction(db, workspaceId === null ? null : uid(workspaceId), fn);

  const rows = async <T = Record<string, unknown>>(x: PgDb, q: SQL): Promise<T[]> => {
    const res = (await x.execute(q)) as unknown;
    if (Array.isArray(res)) return res as T[];
    return ((res as { rows?: unknown[] }).rows ?? []) as T[];
  };

  // --- issuer storage over the crm.openauth_kv_* functions ----------------

  const kvGet = async (x: PgDb, key: string): Promise<string | null> => {
    const [row] = await rows<{ value: unknown }>(x, sql`SELECT crm.openauth_kv_get(${key}) AS value`);
    return row?.value == null ? null : JSON.stringify(row.value);
  };
  const kvSet = async (x: PgDb, key: string, value: string, expiry: number | null): Promise<void> => {
    const expiresAt = expiry == null ? null : new Date(expiry).toISOString();
    await rows(x, sql`SELECT crm.openauth_kv_set(${key}, ${value}::jsonb, ${expiresAt}::timestamptz)`);
  };
  const kvRemove = async (x: PgDb, key: string): Promise<void> => {
    await rows(x, sql`SELECT crm.openauth_kv_remove(${key})`);
  };
  const kvScan = async (x: PgDb, prefix: string): Promise<Array<{ key: string; value: string }>> => {
    const found = await rows<{ key: string; value: unknown }>(x, sql`SELECT key, value FROM crm.openauth_kv_scan(${prefix})`);
    return found.map((r) => ({ key: r.key, value: JSON.stringify(r.value) }));
  };

  // The functions return values only; expiry is enforced inside them
  // (expired rows are invisible), so it is reported as null here.
  const authKv: AuthKvStore = {
    get: (key) =>
      inTx(null, async (x) => {
        const value = await kvGet(x, key);
        return value == null ? null : { value, expiry: null };
      }),
    set: (key, value, expiry) => inTx(null, (x) => kvSet(x, key, value, expiry)),
    remove: (key) => inTx(null, (x) => kvRemove(x, key)),
    scanPrefix: (prefix) =>
      inTx(null, async (x) => (await kvScan(x, prefix)).map((r) => ({ key: r.key, value: r.value, expiry: null }))),
  };

  /** Revoke every refresh token issued to a subject. */
  const revokeSubjectRefreshTokens = async (x: PgDb, subject: string): Promise<void> => {
    const prefix = joinAuthKey(["oauth:refresh", subject]) + OPENAUTH_KEY_SEPARATOR;
    for (const row of await kvScan(x, prefix)) await kvRemove(x, row.key);
  };

  /** A user's subject, read under the bound workspace (RLS). */
  const subjectOf = async (x: PgDb, userId: string): Promise<string | null> => {
    const [row] = await rows<{ auth_subject: string | null }>(
      x,
      sql`SELECT auth_subject FROM crm.users WHERE id = ${uid(userId)}::uuid`,
    );
    return row?.auth_subject ?? null;
  };

  /** Sessions + refresh tokens of a user in the bound workspace. */
  const endSessions = async (x: PgDb, userId: string): Promise<number> => {
    const [row] = await rows<{ n: number }>(x, sql`SELECT crm.delete_user_sessions(${uid(userId)}::uuid) AS n`);
    const subject = await subjectOf(x, userId);
    if (subject) await revokeSubjectRefreshTokens(x, subject);
    return Number(row?.n ?? 0);
  };

  const redeem = async (
    x: PgDb,
    input: { email: string; purpose: "setup" | "reset"; code: string },
  ): Promise<AuthCodeVerification & { workspaceId?: string }> => {
    const [row] = await rows<{ outcome: string; user_id: string | null; workspace_id: string | null }>(
      x,
      sql`SELECT * FROM crm.redeem_auth_code(${normalizeEmail(input.email)}, ${input.purpose}, ${sha256Hex(
        normalizeAuthCode(input.code),
      )}, ${AUTH_CODE_MAX_ATTEMPTS})`,
    );
    if (row?.outcome === "ok" && row.user_id && row.workspace_id) {
      return { ok: true, userId: row.user_id, workspaceId: row.workspace_id };
    }
    const reason = row?.outcome === "expired_code" || row?.outcome === "rate_limited" ? row.outcome : "invalid_code";
    return { ok: false, reason };
  };

  const identity: IdentityStore = {
    withTransaction: (fn) => inTx(null, () => fn()),

    // --- sessions ---------------------------------------------------------

    createSession: (userId, link = {}) =>
      inTx(null, async (x) => {
        const token = `sess_${randomBytes(32).toString("hex")}`;
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        await rows(
          x,
          sql`SELECT crm.create_session(${sha256Hex(token)}, ${userId === null ? null : uid(userId)}::uuid, ${
            link.email ? normalizeEmail(link.email) : null
          }, ${link.authSubject ?? null}, ${link.authRefresh ?? null}, ${expiresAt}::timestamptz)`,
        );
        return { token, expiresAt };
      }),

    resolveSessionAny: async (token) => {
      if (!token) return null;
      return inTx(null, async (x) => {
        const [row] = await rows<Record<string, unknown>>(x, sql`SELECT * FROM crm.resolve_session(${sha256Hex(token)})`);
        if (!row) return null;
        if (row.kind === "unprovisioned") {
          return {
            unprovisioned: true,
            email: String(row.email),
            authSubject: (row.auth_subject as string | null) ?? null,
          } satisfies UnprovisionedSession;
        }
        // The resolver returns fixed identity fields only; the profile is read
        // inside the resolved workspace, under row-level security.
        const workspaceId = String(row.workspace_id);
        await bindAmbientWorkspace(db, workspaceId);
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
              FROM crm.users WHERE id = ${String(row.user_id)}::uuid`,
        );
        if (!profile) return null;
        const role = row.role as Role;
        return {
          user: {
            id: String(row.user_id),
            email: profile.email,
            name: profile.name,
            role,
            status: profile.status as UserStatus,
            hasPassword: profile.has_password === true,
            disabledAt: isoN(profile.disabled_at),
            createdAt: iso(profile.created_at),
          },
          workspaceId,
          role,
          passwordMustChange: row.password_must_change === true,
          authSubject: (row.auth_subject as string | null) ?? null,
        } satisfies SessionUser;
      });
    },

    async resolveSession(token) {
      const resolved = await identity.resolveSessionAny(token);
      return resolved && !("unprovisioned" in resolved) ? resolved : null;
    },

    destroySession: (token) =>
      inTx(null, async (x) => {
        const [row] = await rows<{ refresh: string | null }>(x, sql`SELECT crm.destroy_session(${sha256Hex(token)}) AS refresh`);
        const refresh = row?.refresh;
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
        return stored != null && openAuthVerifyPassword(password, JSON.parse(stored) as OpenAuthScryptHash);
      }),
    hasPasswordCredential: (email) => inTx(null, async (x) => (await kvGet(x, authPasswordKey(email))) != null),

    // --- codes ------------------------------------------------------------

    issueCode: (workspaceId, userId, purpose) =>
      inTx(workspaceId, async (x) => {
        if (purpose !== "setup" && purpose !== "reset") {
          throw OpError.validation(`Unknown credential code purpose: ${String(purpose)}`);
        }
        const [user] = await rows<{ email: string }>(x, sql`SELECT email FROM crm.users WHERE id = ${uid(userId)}::uuid`);
        if (!user) throw OpError.notFound("user", userId);

        // Issue rate limit per email, same window and cap as the SQLite
        // adapter. Codes superseded by crm.issue_auth_code are deleted, so the
        // issue history is kept in the issuer storage instead.
        const now = Date.now();
        const logKey = issueLogKey(user.email);
        const logged = await kvGet(x, logKey);
        const recent = (logged ? (JSON.parse(logged) as number[]) : []).filter((at) => at > now - AUTH_CODE_ISSUE_WINDOW_MS);
        if (recent.length >= AUTH_CODE_ISSUE_MAX) {
          throw new OpError("conflict", "Too many codes issued for this email — wait a few minutes and try again");
        }
        await kvSet(x, logKey, JSON.stringify([...recent, now]), now + AUTH_CODE_ISSUE_WINDOW_MS);

        const code = generateAuthCode();
        const expiresAt = new Date(now + AUTH_CODE_TTL_MS[purpose]).toISOString();
        const [issued] = await rows<{ id: string | null }>(
          x,
          sql`SELECT crm.issue_auth_code(${uid(userId)}::uuid, ${purpose}, ${sha256Hex(normalizeAuthCode(code))}, ${expiresAt}::timestamptz) AS id`,
        );
        if (!issued?.id) throw OpError.notFound("user", userId);
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
        await rows(
          x,
          sql`UPDATE crm.users SET password_must_change = false, updated_at = now() WHERE id = ${verdict.userId}::uuid`,
        );
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
        const [user] = await rows<{ user_id: string; workspace_id: string; status: string; subject_linked: boolean }>(
          x,
          sql`SELECT user_id, workspace_id, status, subject_linked FROM crm.resolve_auth_email(${normalized})`,
        );
        if (!user) {
          if (!opts.openRegistration) return { status: "not_invited" };
          // Hosted open registration: a verified email without a CRM user gets
          // a stable subject and an unprovisioned session. Reuse a subject
          // minted for this email earlier (login before provisioning).
          const prior = await kvGet(x, authSubjectKey(normalized));
          const priorValue = prior == null ? null : (JSON.parse(prior) as unknown);
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
            // Changed since resolve_auth_email: bound by another sign-in, or
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
        const [row] = await rows<{ user_id: string; workspace_id: string; status: string; email: string }>(
          x,
          sql`SELECT * FROM crm.find_user_by_auth_subject(${subject})`,
        );
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

    // Part 1 stub (see the file header): replaced by #5.
    workspaceAccess: async () => ({ mode: "active", expiresAt: null }),

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
