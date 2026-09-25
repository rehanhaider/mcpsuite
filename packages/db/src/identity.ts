/**
 * The identity adapter interface: sign-in, sessions, setup/reset codes,
 * identity linking, MCP API keys, and the two request gates (forced password
 * change, hosted workspace lock).
 *
 * Business data already goes through the core `Ports`; this is the matching
 * seam for everything that decides WHO is calling. The web and MCP apps talk
 * to it through `runtime.identity` and never touch a database handle. Each
 * database adapter implements it: SQLite (./sqlite-identity.ts, the default)
 * and PostgreSQL (./pg/identity.ts).
 *
 * Transactions: `withTransaction(fn)` commits only after fn fully resolves and
 * rolls back when it rejects. Nested calls from the same request join the
 * open transaction, including calls through `ports.tx` and through the other
 * methods here; other requests wait. Inside a transaction, await only
 * database work — anything with network I/O runs after commit.
 */
import type { AuthKvStore, AuthLinkResult, AuthCodePurpose, AuthCodeVerification, SetPasswordOutcome } from "./openauth.ts";
import type { ResolvedMcpClient, SessionLink, SessionUser, UnprovisionedSession } from "./auth.ts";
import type { WorkspaceAccess } from "./hosting-access.ts";

/** A CRM user as the sign-in flow needs it (never authority on its own). */
export interface IdentityUserRef {
  id: string;
  status: string;
  email: string;
  workspaceId: string;
}

export interface IdentityStore {
  /** Run fn atomically; nested calls from the same request join. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  // --- sessions -------------------------------------------------------------

  /**
   * Mint a session. `userId: null` creates an unprovisioned session for a
   * verified identity whose CRM user does not exist yet; `link.email` is then
   * required and is the adoption key.
   */
  createSession(userId: string | null, link?: SessionLink): Promise<{ token: string; expiresAt: string }>;
  /**
   * Resolve a session token to the CURRENT user state. A user-less session is
   * adopted when an active user with its email now exists (the subject is
   * bound once and the session row upgraded); a session whose email user
   * bound a different subject is deleted. Otherwise it surfaces as
   * unprovisioned.
   */
  resolveSessionAny(token: string | null | undefined): Promise<SessionUser | UnprovisionedSession | null>;
  /** Like resolveSessionAny, but "no CRM user" means not signed in. */
  resolveSession(token: string | null | undefined): Promise<SessionUser | null>;
  /** Logout: delete the session and revoke the refresh token it was minted with. */
  destroySession(token: string): Promise<void>;
  /** Delete every session of a user and revoke their refresh tokens; returns the count. */
  endUserSessions(workspaceId: string, userId: string): Promise<number>;

  // --- login storage (the OpenAuth issuer's storage) -------------------------

  /** Key/value storage the OpenAuth issuer runs on. */
  readonly authKv: AuthKvStore;
  /** Create or overwrite the password credential for an email. */
  setPassword(email: string, password: string): Promise<void>;
  /** Verify a password against the stored credential. */
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** True iff a completed password credential exists for the email. */
  hasPasswordCredential(email: string): Promise<boolean>;

  // --- setup/reset codes -------------------------------------------------------

  /**
   * Issue a single-use code for a user in `workspaceId`. Supersedes earlier
   * codes of that purpose; `reset` also ends the user's sessions and revokes
   * their refresh tokens. Only the hash is stored; the raw code is returned once.
   */
  issueCode(workspaceId: string, userId: string, purpose: AuthCodePurpose): Promise<{ code: string; expiresAt: string }>;
  /** Verify and consume a code. Wrong guesses count against the active code. */
  verifyAndConsumeCode(input: { email: string; purpose: AuthCodePurpose; code: string }): Promise<AuthCodeVerification>;
  /**
   * Redeem a code and set the password, atomically: consume the code, write
   * the credential, clear the forced-change flag, and for `reset` end the
   * user's sessions and refresh tokens. A failure part-way leaves everything
   * unchanged, including the code.
   */
  redeemCodeAndSetPassword(input: {
    email: string;
    purpose: AuthCodePurpose;
    code: string;
    password: string;
  }): Promise<SetPasswordOutcome>;

  // --- identity linking --------------------------------------------------------

  /**
   * The issuer's success step: resolve an authenticated email to a CRM user,
   * activating a pending user and binding its subject exactly once, and
   * record the email → subject binding. Atomic.
   */
  resolveAuthSuccess(email: string, opts?: { openRegistration?: boolean }): Promise<AuthLinkResult>;
  /** The CRM user an OpenAuth subject is bound to (any status). */
  findUserByAuthSubject(subject: string): Promise<IdentityUserRef | null>;
  /** The verified email an OpenAuth subject was minted for. */
  emailForAuthSubject(subject: string): Promise<string | null>;

  // --- MCP API keys ------------------------------------------------------------

  /**
   * Resolve a bearer API key. Authority mirrors the creating user's CURRENT
   * role; a revoked key, or a creator who is gone, disabled, pending, or no
   * longer a member, resolves to null.
   */
  resolveMcpToken(bearerToken: string | null | undefined): Promise<ResolvedMcpClient | null>;

  // --- request gates -------------------------------------------------------------

  /** Hosted access state for a workspace (self-host resolves active). */
  workspaceAccess(workspaceId: string): Promise<WorkspaceAccess>;
  /** True while the user must set a new password before anything else. */
  passwordMustChange(workspaceId: string, userId: string): Promise<boolean>;
}

/**
 * Test-only fault seams. Each hook runs inside the atomic flow it names, at the
 * point a crash would be most damaging; throwing from it proves the flow rolls
 * back. Never set in production code.
 */
export interface IdentityTestHooks {
  /** Redemption: after the code is consumed, before the password is written. */
  afterCodeConsumed?(): void | Promise<void>;
  /** Identity linking: after the user row is bound, before the email → subject record. */
  afterSubjectBound?(): void | Promise<void>;
}
