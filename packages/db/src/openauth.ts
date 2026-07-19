/**
 * Database-backed OpenAuth integration (docs/auth-api.md, docs/issues/0022):
 *
 *   - `AuthKvStore` — the small dialect-agnostic KV port the OpenAuth
 *     StorageAdapter sits on (SQLite here; the PostgreSQL adapter mirrors it).
 *   - `createOpenAuthStorage` — OpenAuth 0.4.3 `StorageAdapter` semantics
 *     (structural type; this package deliberately does not depend on
 *     @openauthjs/openauth) over an AuthKvStore.
 *   - Password-hash read/write in OpenAuth's own scrypt shape, so the CRM can
 *     set credentials (setup/reset codes) that the PasswordProvider verifies.
 *   - CRM-issued single-use setup/reset codes: hashed at rest, expiring,
 *     regenerable, attempt-capped and issue-rate-limited per email.
 *   - The delivery seam `deliverAuthCode` (hosted webhook vs display mode).
 *   - Identity linking `resolveAuthSuccess`: pending user activation +
 *     one-time subject binding; unknown email → not invited.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, like, lt, sql, type SQL } from "drizzle-orm";
import { newId, nowIso, OpError } from "@emcp/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { sha256Hex } from "./services.ts";

// ---------------------------------------------------------------------------
// KV port + OpenAuth storage adapter
// ---------------------------------------------------------------------------

/** OpenAuth joins key segments with 0x1f; we store the joined string. */
export const OPENAUTH_KEY_SEPARATOR = String.fromCharCode(0x1f);

export function joinAuthKey(key: string[]): string {
  return key.join(OPENAUTH_KEY_SEPARATOR);
}

export function splitAuthKey(key: string): string[] {
  return key.split(OPENAUTH_KEY_SEPARATOR);
}

/**
 * The dialect-agnostic storage seam. Keys are opaque joined strings, values
 * raw JSON, expiry epoch milliseconds (null = never). The PostgreSQL adapter
 * implements the same four methods over its own openauth_kv table.
 */
export interface AuthKvStore {
  get(key: string): Promise<{ value: string; expiry: number | null } | null>;
  set(key: string, value: string, expiry: number | null): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every row whose key starts with `prefix` (plain string prefix, no decoding). */
  scanPrefix(prefix: string): Promise<Array<{ key: string; value: string; expiry: number | null }>>;
}

/** Escape %, _ and \ for a LIKE pattern with ESCAPE '\'. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `key LIKE '<prefix>%'` with a proper ESCAPE clause (keys contain "_" freely). */
function keyHasPrefix(prefix: string): SQL {
  return sql`${t.openauthKv.key} LIKE ${`${likeEscape(prefix)}%`} ESCAPE '\\'`;
}

export function sqliteAuthKv(db: Db): AuthKvStore {
  return {
    async get(key) {
      const row = db.select().from(t.openauthKv).where(eq(t.openauthKv.key, key)).get();
      if (!row) return null;
      if (row.expiry != null && row.expiry <= Date.now()) {
        db.delete(t.openauthKv).where(eq(t.openauthKv.key, key)).run();
        return null;
      }
      return { value: row.value, expiry: row.expiry };
    },
    async set(key, value, expiry) {
      db.insert(t.openauthKv)
        .values({ key, value, expiry })
        .onConflictDoUpdate({ target: t.openauthKv.key, set: { value, expiry } })
        .run();
    },
    async remove(key) {
      db.delete(t.openauthKv).where(eq(t.openauthKv.key, key)).run();
    },
    async scanPrefix(prefix) {
      // Opportunistic cleanup keeps scans (refresh-token enumeration) honest.
      db.delete(t.openauthKv).where(lt(t.openauthKv.expiry, Date.now())).run();
      const rows = db.select().from(t.openauthKv).where(keyHasPrefix(prefix)).all();
      const now = Date.now();
      return rows.filter((r) => r.expiry == null || r.expiry > now).map((r) => ({ key: r.key, value: r.value, expiry: r.expiry }));
    },
  };
}

/**
 * Structural copy of OpenAuth 0.4.3's `StorageAdapter` interface — kept in
 * sync by the web adapter's typecheck (it assigns this to the real type).
 */
export interface OpenAuthStorageAdapter {
  get(key: string[]): Promise<Record<string, unknown> | undefined>;
  remove(key: string[]): Promise<void>;
  set(key: string[], value: unknown, expiry?: Date): Promise<void>;
  scan(prefix: string[]): AsyncIterable<[string[], unknown]>;
}

export function createOpenAuthStorage(kv: AuthKvStore): OpenAuthStorageAdapter {
  return {
    async get(key) {
      const row = await kv.get(joinAuthKey(key));
      if (!row) return undefined;
      return JSON.parse(row.value) as Record<string, unknown>;
    },
    async set(key, value, expiry) {
      await kv.set(joinAuthKey(key), JSON.stringify(value ?? null), expiry ? expiry.getTime() : null);
    },
    async remove(key) {
      await kv.remove(joinAuthKey(key));
    },
    async *scan(prefix) {
      const joined = joinAuthKey(prefix);
      const rows = await kv.scanPrefix(joined);
      for (const row of rows) {
        // Match OpenAuth's semantics: the prefix is a whole-segment prefix.
        if (row.key !== joined && !row.key.startsWith(joined + OPENAUTH_KEY_SEPARATOR)) continue;
        yield [splitAuthKey(row.key), JSON.parse(row.value)];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAuth credential records (email → password hash / subject)
// ---------------------------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const passwordKey = (email: string): string[] => ["email", normalizeEmail(email), "password"];
const subjectKey = (email: string): string[] => ["email", normalizeEmail(email), "subject"];

/**
 * OpenAuth's default ScryptHasher output shape (provider/password.ts):
 * scrypt(password, salt, 32) with N=16384, r=8, p=1, base64-encoded. We write
 * the exact same shape so the PasswordProvider verifies what we set.
 */
export interface OpenAuthScryptHash {
  hash: string;
  salt: string;
  N: number;
  r: number;
  p: number;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;

export function openAuthHashPassword(password: string): OpenAuthScryptHash {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { hash: derived.toString("base64"), salt: salt.toString("base64"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

export function openAuthVerifyPassword(password: string, stored: OpenAuthScryptHash): boolean {
  const expected = Buffer.from(stored.hash, "base64");
  const derived = scryptSync(password, Buffer.from(stored.salt, "base64"), expected.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Create/overwrite the OpenAuth password credential for an email. */
export async function setOpenAuthPassword(db: Db, email: string, password: string): Promise<void> {
  const storage = createOpenAuthStorage(sqliteAuthKv(db));
  await storage.set(passwordKey(email), openAuthHashPassword(password));
}

export async function hasOpenAuthPassword(db: Db, email: string): Promise<boolean> {
  return (await createOpenAuthStorage(sqliteAuthKv(db)).get(passwordKey(email))) != null;
}

/** Verify a password against the OpenAuth credential store (server-side use). */
export async function verifyOpenAuthPassword(db: Db, email: string, password: string): Promise<boolean> {
  const stored = await createOpenAuthStorage(sqliteAuthKv(db)).get(passwordKey(email));
  if (!stored) return false;
  return openAuthVerifyPassword(password, stored as unknown as OpenAuthScryptHash);
}

/** Remove the email's credential + subject binding (permanent user deletion). */
export async function removeOpenAuthCredential(db: Db, email: string): Promise<void> {
  const storage = createOpenAuthStorage(sqliteAuthKv(db));
  await storage.remove(passwordKey(email));
  await storage.remove(subjectKey(email));
}

/**
 * Revoke every OpenAuth refresh token for a subject
 * (openauth_kv["oauth:refresh"▸subject▸*]). Returns how many were removed.
 */
export async function invalidateSubjectRefreshTokens(db: Db, subject: string): Promise<number> {
  const kv = sqliteAuthKv(db);
  const prefix = joinAuthKey(["oauth:refresh", subject]) + OPENAUTH_KEY_SEPARATOR;
  const rows = await kv.scanPrefix(prefix);
  for (const row of rows) await kv.remove(row.key);
  return rows.length;
}

/**
 * Revoke exactly one refresh token (the one bound to a session at logout).
 * Token format is "<subject>:<id>" (OpenAuth issuer.ts generateTokens).
 */
export async function invalidateRefreshToken(db: Db, refreshToken: string): Promise<void> {
  const idx = refreshToken.lastIndexOf(":");
  if (idx <= 0) return;
  const subject = refreshToken.slice(0, idx);
  const id = refreshToken.slice(idx + 1);
  await sqliteAuthKv(db).remove(joinAuthKey(["oauth:refresh", subject, id]));
}

// ---------------------------------------------------------------------------
// Sessions (subject-linked)
// ---------------------------------------------------------------------------

/**
 * Hard-delete every CRM session for a user and revoke each session's OpenAuth
 * refresh token. Returns the number of sessions removed.
 */
export function endUserSessions(db: Db, userId: string): number {
  const rows = db.select().from(t.sessions).where(eq(t.sessions.userId, userId)).all();
  for (const row of rows) {
    if (row.authRefresh) {
      const idx = row.authRefresh.lastIndexOf(":");
      if (idx > 0) {
        db.delete(t.openauthKv)
          .where(eq(t.openauthKv.key, joinAuthKey(["oauth:refresh", row.authRefresh.slice(0, idx), row.authRefresh.slice(idx + 1)])))
          .run();
      }
    }
  }
  return db.delete(t.sessions).where(eq(t.sessions.userId, userId)).run().changes;
}

// ---------------------------------------------------------------------------
// CRM-issued setup/reset codes
// ---------------------------------------------------------------------------

export type AuthCodePurpose = "setup" | "reset";

/** Unambiguous manual-relay alphabet: no I/L/O/0/1, uppercase only. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

export const AUTH_CODE_TTL_MS: Record<AuthCodePurpose, number> = {
  setup: 7 * 24 * 60 * 60 * 1000, // invited users may redeem later
  reset: 60 * 60 * 1000,
};

/** Fixed-window issue rate limit per email. */
export const AUTH_CODE_ISSUE_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_CODE_ISSUE_MAX = 5;
/** Failed verification attempts before the active code self-invalidates. */
export const AUTH_CODE_MAX_ATTEMPTS = 10;

export function generateAuthCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return raw.replace(/(.{4})(?=.)/g, "$1-");
}

/** Case-insensitive, separator-insensitive comparison form. */
export function normalizeAuthCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface IssuedAuthCode {
  code: string;
  expiresAt: string;
}

/**
 * Issue a fresh single-use code: invalidates every earlier code of that
 * purpose; `reset` also ends the user's sessions and revokes their refresh
 * tokens (docs/issues/0022). Only the SHA-256 of the code is stored — the raw
 * code exists solely in the return value.
 */
export async function issueAuthCode(db: Db, input: { userId: string; purpose: AuthCodePurpose }): Promise<IssuedAuthCode> {
  return issueAuthCodeSync(db, input);
}

/** Synchronous form for sync call sites (bootstrap, CLI). Same semantics. */
export function issueAuthCodeSync(db: Db, input: { userId: string; purpose: AuthCodePurpose }): IssuedAuthCode {
  const user = db.select().from(t.users).where(eq(t.users.id, input.userId)).get();
  if (!user) throw OpError.notFound("user", input.userId);
  const email = normalizeEmail(user.email);
  const now = nowIso();

  const windowStart = new Date(Date.now() - AUTH_CODE_ISSUE_WINDOW_MS).toISOString();
  const issuedInWindow = db
    .select()
    .from(t.authCodes)
    .where(and(eq(t.authCodes.email, email), gt(t.authCodes.createdAt, windowStart)))
    .all().length;
  if (issuedInWindow >= AUTH_CODE_ISSUE_MAX) {
    throw new OpError("conflict", "Too many codes issued for this email — wait a few minutes and try again");
  }

  const code = generateAuthCode();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS[input.purpose]).toISOString();
  atomically(db, () => {
    // Supersede: completing an old code and regenerating cannot both succeed.
    db.update(t.authCodes)
      .set({ usedAt: now })
      .where(and(eq(t.authCodes.userId, input.userId), eq(t.authCodes.purpose, input.purpose), isNull(t.authCodes.usedAt)))
      .run();
    db.insert(t.authCodes)
      .values({
        id: newId(),
        userId: input.userId,
        email,
        purpose: input.purpose,
        codeHash: sha256Hex(normalizeAuthCode(code)),
        attempts: 0,
        createdAt: now,
        expiresAt,
        usedAt: null,
      })
      .run();
    if (input.purpose === "reset") {
      endUserSessions(db, input.userId);
      if (user.authSubject) {
        // Sync counterpart of invalidateSubjectRefreshTokens (stay in this tx).
        const prefix = joinAuthKey(["oauth:refresh", user.authSubject]) + OPENAUTH_KEY_SEPARATOR;
        db.delete(t.openauthKv).where(keyHasPrefix(prefix)).run();
      }
    }
  });
  return { code, expiresAt };
}

export type AuthCodeVerification =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_code" | "expired_code" | "rate_limited" };

/**
 * Verify and CONSUME a code (single-use). Wrong guesses increment the active
 * code's attempt counter; at the cap the code is invalidated.
 */
export async function verifyAndConsumeAuthCode(
  db: Db,
  input: { email: string; purpose: AuthCodePurpose; code: string },
): Promise<AuthCodeVerification> {
  const email = normalizeEmail(input.email);
  const row = db
    .select()
    .from(t.authCodes)
    .where(and(eq(t.authCodes.email, email), eq(t.authCodes.purpose, input.purpose), isNull(t.authCodes.usedAt)))
    .orderBy(desc(t.authCodes.createdAt))
    .get();
  if (!row) return { ok: false, reason: "invalid_code" };
  if (row.expiresAt <= nowIso()) return { ok: false, reason: "expired_code" };
  if (row.attempts >= AUTH_CODE_MAX_ATTEMPTS) return { ok: false, reason: "rate_limited" };
  if (sha256Hex(normalizeAuthCode(input.code)) !== row.codeHash) {
    const attempts = row.attempts + 1;
    db.update(t.authCodes)
      .set(attempts >= AUTH_CODE_MAX_ATTEMPTS ? { attempts, usedAt: nowIso() } : { attempts })
      .where(eq(t.authCodes.id, row.id))
      .run();
    return { ok: false, reason: attempts >= AUTH_CODE_MAX_ATTEMPTS ? "rate_limited" : "invalid_code" };
  }
  db.update(t.authCodes).set({ usedAt: nowIso() }).where(eq(t.authCodes.id, row.id)).run();
  return { ok: true, userId: row.userId };
}

// ---------------------------------------------------------------------------
// Delivery seam
// ---------------------------------------------------------------------------

/** `verify` = OpenAuth's own register/change flow codes routed through the same seam. */
export type AuthDeliveryPurpose = AuthCodePurpose | "verify";

export interface AuthCodeDeliveryResult {
  /** `delivered` — the hosted webhook accepted it; `display` — the caller must surface the code exactly once. */
  mode: "delivered" | "display";
}

/**
 * The code-delivery seam (docs/auth-api.md). With EMCP_AUTH_DELIVERY_URL set
 * (hosted), POST the code there — the SaaS turns it into email; the code is
 * never logged and a non-2xx is a hard failure. Without it (self-host,
 * display mode) the caller surfaces the code to the initiating admin or the
 * terminal exactly once.
 */
export async function deliverAuthCode(input: {
  email: string;
  code: string;
  purpose: AuthDeliveryPurpose;
}): Promise<AuthCodeDeliveryResult> {
  const url = process.env.EMCP_AUTH_DELIVERY_URL?.trim();
  if (!url) return { mode: "display" };
  const key = process.env.EMCP_AUTH_DELIVERY_KEY?.trim();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ email: normalizeEmail(input.email), code: input.code, purpose: input.purpose }),
  });
  if (!res.ok) {
    // Never include the code (or the body we sent) in the error.
    throw new Error(`Auth code delivery failed: POST ${url} answered ${res.status}`);
  }
  return { mode: "delivered" };
}

// ---------------------------------------------------------------------------
// Identity linking (issuer `success` callback → CRM user)
// ---------------------------------------------------------------------------

export type AuthLinkResult =
  | { status: "linked"; userId: string; subject: string }
  | { status: "not_invited" }
  | { status: "disabled" }
  /** Open registration (hosted): verified identity, CRM user not created yet. */
  | { status: "unprovisioned"; subject: string };

/**
 * Resolve a successfully authenticated email to a CRM user and its stable
 * OpenAuth subject (docs/issues/0022): a pending user with this email is
 * ACTIVATED and the subject bound exactly once; later logins resolve by
 * subject. Unknown emails are rejected (`not_invited`) — self-host has no
 * public signup and hosted signup pre-creates the pending owner.
 */
export async function resolveAuthSuccess(
  db: Db,
  email: string,
  opts: { openRegistration?: boolean } = {},
): Promise<AuthLinkResult> {
  const normalized = normalizeEmail(email);
  let result: AuthLinkResult = { status: "not_invited" };
  atomically(db, () => {
    const user = db.select().from(t.users).where(eq(t.users.email, normalized)).get();
    if (!user) {
      if (opts.openRegistration) {
        // Hosted trial-first signup (docs/auth-api.md §Hosted open
        // registration): the workspace is provisioned AFTER verification, so
        // a verified email without a CRM user gets a stable subject and an
        // unprovisioned session instead of not_invited. Reuse a previously
        // minted subject for this email (login-before-provisioning).
        const existingKey = joinAuthKey(subjectKey(normalized));
        const existing = db.select().from(t.openauthKv).where(eq(t.openauthKv.key, existingKey)).get();
        const prior = existing ? (JSON.parse(existing.value) as unknown) : null;
        const subject = typeof prior === "string" && prior.startsWith("acct_") ? prior : `acct_${newId()}`;
        db
          .insert(t.openauthKv)
          .values({ key: existingKey, value: JSON.stringify(subject), expiry: null })
          .onConflictDoUpdate({ target: t.openauthKv.key, set: { value: JSON.stringify(subject), expiry: null } })
          .run();
        result = { status: "unprovisioned", subject };
        return;
      }
      result = { status: "not_invited" };
      return;
    }
    if (user.status === "disabled" || user.disabledAt) {
      result = { status: "disabled" };
      return;
    }
    if (user.authSubject) {
      if (user.status === "pending") {
        // Defensive: a bound subject implies an activated account.
        db.update(t.users).set({ status: "active", updatedAt: nowIso() }).where(eq(t.users.id, user.id)).run();
      }
      result = { status: "linked", userId: user.id, subject: user.authSubject };
      return;
    }
    // First successful auth for this user (pending invite, or a pre-OpenAuth
    // user after an owner-recovery code): bind the subject once + activate.
    const subject = `acct_${newId()}`;
    db.update(t.users).set({ authSubject: subject, status: "active", updatedAt: nowIso() }).where(eq(t.users.id, user.id)).run();
    result = { status: "linked", userId: user.id, subject };
  });
  return result;
}

/**
 * Hosting-control provisioning guard (docs/auth-api.md §Hosted open
 * registration): TRUE iff a completed OpenAuth password credential exists for
 * the email — proof that its holder registered and verified on this
 * deployment. Sync so the hosting-control transaction can consult it.
 */
export function hasPasswordCredentialSync(db: Db, email: string): boolean {
  const row = db
    .select()
    .from(t.openauthKv)
    .where(eq(t.openauthKv.key, joinAuthKey(passwordKey(email))))
    .get();
  return row != null;
}

/**
 * Reverse lookup: the verified email an OpenAuth subject was minted for
 * (docs/auth-api.md §Hosted open registration). Sync for the hosting-control
 * provisioning transaction. Scans the email→subject bindings.
 */
export function emailForAuthSubjectSync(db: Db, subject: string): string | null {
  const suffix = OPENAUTH_KEY_SEPARATOR + "subject";
  const rows = db
    .select()
    .from(t.openauthKv)
    .where(and(like(t.openauthKv.key, "email" + OPENAUTH_KEY_SEPARATOR + "%"), eq(t.openauthKv.value, JSON.stringify(subject))))
    .all();
  for (const row of rows) {
    if (!row.key.endsWith(suffix)) continue;
    const segments = splitAuthKey(row.key);
    if (segments.length === 3 && segments[0] === "email") return segments[1] ?? null;
  }
  return null;
}

/** Session issuance helper: the CRM user a subject resolves to (claims are never authority). */
export function findUserByAuthSubject(db: Db, subject: string): { id: string; status: string; email: string } | null {
  const row = db.select().from(t.users).where(eq(t.users.authSubject, subject)).get();
  return row ? { id: row.id, status: row.status, email: row.email } : null;
}

// ---------------------------------------------------------------------------
// Code redemption (/set-password, /reset-password)
// ---------------------------------------------------------------------------

export type SetPasswordOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_code" | "expired_code" | "rate_limited" };

/**
 * Redeem a CRM-issued code and write the password into OpenAuth storage
 * (docs/auth-api.md POST /api/auth/set-password). The code is consumed even
 * though activation/subject-binding still happens on the first login. A
 * self-chosen password satisfies any forced-change requirement; `reset`
 * additionally ends the user's sessions and revokes their refresh tokens.
 * Password POLICY is the caller's concern (web layer validates length).
 */
export async function redeemAuthCodeAndSetPassword(
  db: Db,
  input: { email: string; purpose: AuthCodePurpose; code: string; password: string },
): Promise<SetPasswordOutcome> {
  const verdict = await verifyAndConsumeAuthCode(db, { email: input.email, purpose: input.purpose, code: input.code });
  if (!verdict.ok) return verdict;
  await setOpenAuthPassword(db, input.email, input.password);
  db.update(t.users).set({ passwordMustChange: 0, updatedAt: nowIso() }).where(eq(t.users.id, verdict.userId)).run();
  if (input.purpose === "reset") {
    endUserSessions(db, verdict.userId);
    const user = db.select().from(t.users).where(eq(t.users.id, verdict.userId)).get();
    if (user?.authSubject) await invalidateSubjectRefreshTokens(db, user.authSubject);
  }
  return { ok: true, userId: verdict.userId };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Run fn atomically on the raw connection. Joins an open transaction via a
 * savepoint (ports.tx may already hold BEGIN), otherwise BEGIN/COMMIT.
 * Synchronous by design (better-sqlite3).
 */
export function atomically(db: Db, fn: () => void): void {
  const sqlite = db.$client;
  const nested = sqlite.inTransaction;
  sqlite.exec(nested ? "SAVEPOINT emcp_auth" : "BEGIN");
  try {
    fn();
    sqlite.exec(nested ? "RELEASE emcp_auth" : "COMMIT");
  } catch (e) {
    sqlite.exec(nested ? "ROLLBACK TO emcp_auth; RELEASE emcp_auth" : "ROLLBACK");
    throw e;
  }
}
