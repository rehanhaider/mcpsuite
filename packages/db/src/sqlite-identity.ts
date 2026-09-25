/**
 * SQLite implementation of the identity adapter interface (./identity.ts).
 *
 * It wraps the existing SQLite functions in ./auth.ts, ./openauth.ts and
 * ./hosting-access.ts without changing what they do, and adds the one thing
 * they lacked: every method runs as a unit of work on the shared connection
 * (./sqlite-tx.ts). A plain read or write waits for other requests'
 * transactions instead of executing inside one; a method with more than one
 * write runs in a transaction.
 *
 * Deliberate differences from calling those functions directly:
 *   - Code redemption is atomic: consuming the code, writing the credential,
 *     clearing the forced-change flag and (reset) ending sessions commit
 *     together or not at all. A failure part-way leaves the code unspent.
 *   - Identity linking records the email → subject binding in the same
 *     transaction as the user binding.
 *   - Every method waits for the connection, so a read can now wait behind
 *     another request's transaction.
 */
import { and, eq } from "drizzle-orm";
import { nowIso, OpError } from "@mcpsuite/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import {
  createSession,
  destroySession,
  isUnprovisionedSession,
  resolveMcpToken,
  resolveSessionAny,
  userMustChangePassword,
} from "./auth.ts";
import {
  authSubjectKey,
  bindAuthSuccessSync,
  emailForAuthSubjectSync,
  endUserSessions,
  hasPasswordCredentialSync,
  invalidateSubjectRefreshTokens,
  issueAuthCodeSync,
  setOpenAuthPassword,
  sqliteAuthKv,
  verifyAndConsumeAuthCode,
  verifyOpenAuthPassword,
  type AuthKvStore,
} from "./openauth.ts";
import { resolveWorkspaceAccess } from "./hosting-access.ts";
import { withConnection, withTransaction } from "./sqlite-tx.ts";
import type { IdentityStore, IdentityTestHooks } from "./identity.ts";

export function createSqliteIdentity(db: Db, options: { hooks?: IdentityTestHooks } = {}): IdentityStore {
  const sqlite = db.$client;
  const hooks = options.hooks ?? {};
  const unit = <T>(fn: () => T | Promise<T>): Promise<T> => withConnection(sqlite, fn);
  // Flows that read and then write take the write lock up front (see
  // withTransaction), so another process committing in between cannot fail
  // them with SQLITE_BUSY_SNAPSHOT.
  const atomic = <T>(fn: () => Promise<T>): Promise<T> => withTransaction(sqlite, fn, { immediate: true });
  // Session lookups run on every authenticated request and almost always only
  // read: a deferred transaction takes no write lock for a read, so other
  // processes sharing the file keep writing. Writes (minting, logout, the rare
  // adoption) take the lock only when they happen.
  const atomicRead = <T>(fn: () => Promise<T>): Promise<T> => withTransaction(sqlite, fn);

  const rawKv = sqliteAuthKv(db);
  const authKv: AuthKvStore = {
    get: (key) => unit(() => rawKv.get(key)),
    set: (key, value, expiry) => unit(() => rawKv.set(key, value, expiry)),
    remove: (key) => unit(() => rawKv.remove(key)),
    scanPrefix: (prefix) => unit(() => rawKv.scanPrefix(prefix)),
  };

  /** A user id that is a member of the workspace, or not_found. */
  const assertMember = (workspaceId: string, userId: string): void => {
    const member = db
      .select({ id: t.memberships.id })
      .from(t.memberships)
      .where(and(eq(t.memberships.workspaceId, workspaceId), eq(t.memberships.userId, userId)))
      .get();
    if (!member) throw OpError.notFound("user", userId);
  };

  const identity: IdentityStore = {
    withTransaction: atomic,

    // --- sessions ---------------------------------------------------------
    // createSession inserts, then sweeps expired rows; resolution may link
    // and rewrite rows. Each runs as one (deferred) transaction.
    createSession: (userId, link) => atomicRead(async () => createSession(db, userId, link)),
    resolveSessionAny: (token) => atomicRead(async () => resolveSessionAny(db, token)),
    async resolveSession(token) {
      const resolved = await identity.resolveSessionAny(token);
      return resolved && !isUnprovisionedSession(resolved) ? resolved : null;
    },
    destroySession: (token) => atomicRead(async () => destroySession(db, token)),
    endUserSessions: (workspaceId, userId) =>
      atomic(async () => {
        assertMember(workspaceId, userId);
        return endUserSessions(db, userId);
      }),

    // --- login storage ----------------------------------------------------
    authKv,
    setPassword: (email, password) => unit(() => setOpenAuthPassword(db, email, password)),
    verifyPassword: (email, password) => unit(() => verifyOpenAuthPassword(db, email, password)),
    hasPasswordCredential: (email) => unit(() => hasPasswordCredentialSync(db, email)),

    // --- codes ------------------------------------------------------------
    issueCode: (workspaceId, userId, purpose) =>
      atomic(async () => {
        assertMember(workspaceId, userId);
        return issueAuthCodeSync(db, { userId, purpose });
      }),
    verifyAndConsumeCode: (input) => atomic(() => verifyAndConsumeAuthCode(db, input)),
    redeemCodeAndSetPassword: (input) =>
      atomic(async () => {
        const verdict = await verifyAndConsumeAuthCode(db, { email: input.email, purpose: input.purpose, code: input.code });
        // A wrong guess commits its attempt count; only success continues.
        if (!verdict.ok) return verdict;
        await hooks.afterCodeConsumed?.();
        await setOpenAuthPassword(db, input.email, input.password);
        // A self-chosen password satisfies any forced-change requirement.
        db.update(t.users).set({ passwordMustChange: 0, updatedAt: nowIso() }).where(eq(t.users.id, verdict.userId)).run();
        if (input.purpose === "reset") {
          endUserSessions(db, verdict.userId);
          const user = db.select().from(t.users).where(eq(t.users.id, verdict.userId)).get();
          if (user?.authSubject) await invalidateSubjectRefreshTokens(db, user.authSubject);
        }
        return { ok: true as const, userId: verdict.userId };
      }),

    // --- identity linking -------------------------------------------------
    resolveAuthSuccess: (email, opts) =>
      atomic(async () => {
        const result = bindAuthSuccessSync(db, email, opts);
        if (result.status === "linked" || result.status === "unprovisioned") {
          await hooks.afterSubjectBound?.();
          await rawKv.set(authSubjectKey(email), JSON.stringify(result.subject), null);
        }
        return result;
      }),
    findUserByAuthSubject: (subject) =>
      unit(() => {
        const user = db.select().from(t.users).where(eq(t.users.authSubject, subject)).get();
        if (!user) return null;
        const membership = db.select().from(t.memberships).where(eq(t.memberships.userId, user.id)).get();
        if (!membership) return null;
        return { id: user.id, status: user.status, email: user.email, workspaceId: membership.workspaceId };
      }),
    emailForAuthSubject: (subject) => unit(() => emailForAuthSubjectSync(db, subject)),

    // --- MCP keys ---------------------------------------------------------
    resolveMcpToken: (bearerToken) => unit(() => resolveMcpToken(db, bearerToken)),

    // --- gates ------------------------------------------------------------
    workspaceAccess: (workspaceId) => unit(() => resolveWorkspaceAccess(db, workspaceId)),
    passwordMustChange: (_workspaceId, userId) => unit(() => userMustChangePassword(db, userId)),
  };
  return identity;
}
