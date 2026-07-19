/**
 * The OpenAuth issuer mounted at /api/auth/* (docs/auth-api.md) plus the
 * CRM's first-party auth endpoints (login, callback, set-password, logout).
 *
 * Custom-UI PasswordProvider: every provider screen is a 302 redirect to a
 * CRM page (/login, /reset-password, or the hosted signup URL) — the issuer
 * never renders HTML. Identity linking happens in the `success` callback via
 * @emcp/db's resolveAuthSuccess; token claims are never authority — after any
 * successful flow the CRM issues its own emcp_session cookie linked to the
 * OpenAuth subject.
 */
import { issuer } from "@openauthjs/openauth";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";
import {
  createOpenAuthStorage,
  createSession,
  deliverAuthCode,
  destroySession,
  findUserByAuthSubject,
  joinAuthKey,
  normalizeEmail,
  redeemAuthCodeAndSetPassword,
  resolveAuthSuccess,
  resolveSession,
  sqliteAuthKv,
  userMustChangePassword,
  type Db,
} from "@emcp/db";

/**
 * Internal origin for the in-process login dance. Never leaves the process:
 * requests are dispatched straight into the issuer's fetch handler.
 */
const INTERNAL_ORIGIN = "http://emcp.internal";
const CLIENT_ID = "crm-web";
const MOUNT = "/api/auth";

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

// ---------------------------------------------------------------------------
// Subjects (hand-rolled standard-schema — no extra validator dependency)
// ---------------------------------------------------------------------------

interface AccountProperties {
  email: string;
}

const subjects = {
  account: {
    "~standard": {
      version: 1,
      vendor: "emcp",
      validate(value: unknown) {
        const email = (value as { email?: unknown } | null)?.email;
        if (typeof email === "string" && email.length > 0) {
          return { value: { email } satisfies AccountProperties };
        }
        return { issues: [{ message: "email is required" }] };
      },
      /** Phantom type carrier required by standard-schema's InferOutput. */
      types: undefined as unknown as { input: AccountProperties; output: AccountProperties },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Provider UI redirects (docs/auth-api.md "UI redirect contract")
// ---------------------------------------------------------------------------

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const q = search.toString();
  return q ? `${base}${base.includes("?") ? "&" : "?"}${q}` : base;
}

async function loginUi(_req: Request, form?: FormData, error?: { type: string }): Promise<Response> {
  return redirect(
    withParams("/login", { flow: "1", error: error?.type, email: form?.get("email")?.toString() }),
  );
}

async function registerUi(
  _req: Request,
  state: { type: string; email?: string },
  form?: FormData,
  error?: { type: string; message?: string },
): Promise<Response> {
  const signupUrl = process.env.EMCP_AUTH_SIGNUP_URL?.trim();
  if (!signupUrl) return redirect("/login?error=signup_disabled");
  return redirect(
    withParams(signupUrl, {
      state: state.type,
      email: state.type === "code" ? state.email : form?.get("email")?.toString(),
      error: error?.type,
      message: error && "message" in error ? error.message : undefined,
    }),
  );
}

async function changeUi(
  _req: Request,
  state: { type: string; email?: string },
  form?: FormData,
  error?: { type: string; message?: string },
): Promise<Response> {
  return redirect(
    withParams("/reset-password", {
      flow: "change",
      state: state.type,
      email: state.email ?? form?.get("email")?.toString(),
      error: error?.type,
      message: error && "message" in error ? error.message : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// Issuer assembly (one per process/db)
// ---------------------------------------------------------------------------

type FetchApp = { fetch: (request: Request) => Response | Promise<Response> };

let cached: { db: Db; app: FetchApp } | null = null;

export function getAuthApp(db: Db): FetchApp {
  if (cached && cached.db === db) return cached.app;
  const storage = createOpenAuthStorage(sqliteAuthKv(db)) as StorageAdapter;
  const app = issuer({
    storage,
    subjects,
    providers: {
      password: PasswordProvider({
        login: loginUi,
        register: registerUi,
        change: changeUi,
        validatePassword: (password) =>
          password.length < MIN_PASSWORD
            ? `Password must be at least ${MIN_PASSWORD} characters`
            : password.length > MAX_PASSWORD
              ? `Password must be at most ${MAX_PASSWORD} characters`
              : undefined,
        async sendCode(email, code) {
          // OpenAuth's own register/change verification codes go through the
          // same delivery seam as CRM-issued codes (docs/auth-api.md).
          const delivery = await deliverAuthCode({ email, code, purpose: "verify" });
          if (delivery.mode === "display") {
            // Display mode (self-host): the terminal IS the delivery channel.
            console.log(`[emcp] verification code for ${email}: ${code}`);
          }
        },
      }),
    },
    async success(ctx, value) {
      const linked = await resolveAuthSuccess(db, value.email, {
        // Hosted open registration: a configured signup URL means verified
        // identities may exist before their CRM user does (trial-first).
        openRegistration: Boolean(process.env.EMCP_AUTH_SIGNUP_URL?.trim()),
      });
      if (linked.status === "not_invited") return redirect("/login?error=not_invited");
      if (linked.status === "disabled") return redirect("/login?error=account_disabled");
      const response = await ctx.subject("account", { email: normalizeEmail(value.email) }, { subject: linked.subject });
      // The provider's own invalidate hook stores a hash-derived subject under
      // ["email", …, "subject"]; overwrite it with the real bound subject so
      // the change-flow's refresh-token invalidation targets the right one.
      await storage.set(["email", normalizeEmail(value.email), "subject"], linked.subject);
      return response;
    },
    async error() {
      // Lost/expired flow cookies (UnknownStateError): restart at the login page.
      return redirect("/login?error=expired_flow");
    },
  });
  cached = { db, app };
  return app;
}

/** Dispatch a mount-stripped request straight into the issuer (no network). */
function issuerFetch(db: Db, path: string, init?: RequestInit & { cookies?: string[] }): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.cookies?.length) headers.set("cookie", init.cookies.join("; "));
  const request = new Request(`${INTERNAL_ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
  return Promise.resolve(getAuthApp(db).fetch(request));
}

/** First name=value pair of each Set-Cookie header (enough to replay a flow). */
function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";", 1)[0]!).filter(Boolean);
}

/** Decode a JWT payload WITHOUT verification — only for tokens we just
 * received from the in-process issuer (authentic by provenance). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process password login (POST /api/auth/login and the login server fn)
// ---------------------------------------------------------------------------

export type LoginErrorCode = "invalid_credentials" | "not_invited" | "account_disabled" | "expired_flow";

export type PasswordLoginResult =
  | { ok: true; sessionToken: string; expiresAt: string; userId: string; mustChangePassword: boolean; unprovisioned?: false }
  | {
      /** Hosted open registration: verified identity, CRM user pending provisioning. */
      ok: true;
      sessionToken: string;
      expiresAt: string;
      unprovisioned: true;
      mustChangePassword: false;
    }
  | { ok: false; error: LoginErrorCode };

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  invalid_credentials: "Invalid email or password",
  not_invited: "This email has no account here — ask an administrator to invite you",
  account_disabled: "This account is disabled",
  expired_flow: "The sign-in flow expired — try again",
};

/**
 * Run the complete OAuth code flow against the in-process issuer and mint an
 * emcp_session row for the resolved user. Pure function of (db, credentials)
 * — the HTTP layers only translate the result.
 */
export async function performPasswordLogin(
  db: Db,
  input: { email: string; password: string },
): Promise<PasswordLoginResult> {
  const redirectUri = `${INTERNAL_ORIGIN}${MOUNT}/callback`;
  // 1. Start the flow: stores the encrypted authorization state cookie.
  const start = await issuerFetch(
    db,
    withParams("/authorize", {
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      provider: "password",
    }),
  );
  const flowCookies = cookiePairs(start);
  if (!flowCookies.length) return { ok: false, error: "expired_flow" };

  // 2. Present the credentials to the password provider.
  const form = new URLSearchParams({ email: normalizeEmail(input.email), password: input.password });
  const attempt = await issuerFetch(db, "/password/authorize", {
    method: "POST",
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: flowCookies,
  });
  const location = attempt.headers.get("location") ?? "";
  if (!location.startsWith(redirectUri)) {
    // Failure redirects re-render our login UI with ?error=…
    const err = new URL(location, INTERNAL_ORIGIN).searchParams.get("error");
    if (err === "not_invited" || err === "account_disabled") return { ok: false, error: err };
    if (err === "expired_flow") return { ok: false, error: "expired_flow" };
    return { ok: false, error: "invalid_credentials" };
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) return { ok: false, error: "expired_flow" };

  // 3. Exchange the single-use code for tokens.
  const tokens = await exchangeCode(db, code, redirectUri);
  if (!tokens) return { ok: false, error: "expired_flow" };

  // 4. Resolve the subject to the CURRENT user and mint the CRM session.
  return sessionFromTokens(db, tokens);
}

async function exchangeCode(
  db: Db,
  code: string,
  redirectUri: string,
): Promise<{ access: string; refresh: string } | null> {
  const res = await issuerFetch(db, "/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
    }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!json.access_token || !json.refresh_token) return null;
  return { access: json.access_token, refresh: json.refresh_token };
}

function sessionFromTokens(db: Db, tokens: { access: string; refresh: string }): PasswordLoginResult {
  const payload = decodeJwtPayload(tokens.access);
  const subject = typeof payload?.sub === "string" ? payload.sub : null;
  if (!subject) return { ok: false, error: "expired_flow" };
  const user = findUserByAuthSubject(db, subject);
  if (!user) {
    // Hosted open registration (docs/auth-api.md): a verified identity whose
    // CRM user is not provisioned yet holds an UNPROVISIONED session — the
    // resolver adopts the user once hosting-control creates it. The email
    // travels in the subject properties of the access token.
    const props = (payload as { properties?: { email?: unknown } } | null)?.properties;
    const email = typeof props?.email === "string" ? props.email : null;
    if (process.env.EMCP_AUTH_SIGNUP_URL?.trim() && email) {
      const { token, expiresAt } = createSession(db, null, {
        authSubject: subject,
        authRefresh: tokens.refresh,
        email,
      });
      return { ok: true, unprovisioned: true, sessionToken: token, expiresAt, mustChangePassword: false };
    }
    return { ok: false, error: "not_invited" };
  }
  // The success callback binds/activates before tokens are issued, so an
  // unknown-but-bound subject state means the user changed in between.
  if (user.status !== "active") return { ok: false, error: "account_disabled" };
  const { token, expiresAt } = createSession(db, user.id, { authSubject: subject, authRefresh: tokens.refresh });
  return {
    ok: true,
    sessionToken: token,
    expiresAt,
    userId: user.id,
    mustChangePassword: userMustChangePassword(db, user.id),
  };
}

// ---------------------------------------------------------------------------
// /api/auth/* request handling (the catch-all route delegates here)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "emcp_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds — matches the DB row TTL

function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return new URL(request.url).protocol === "https:";
}

/** emcp_session cookie: HttpOnly; SameSite=Lax; Path=/; host-only; Secure per X-Forwarded-Proto. */
export function sessionCookie(token: string, request: Request): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    ...(requestIsSecure(request) ? ["Secure"] : []),
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
  ].join("; ");
}

export function clearedSessionCookie(request: Request): string {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    ...(requestIsSecure(request) ? ["Secure"] : []),
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** The deployment origin as the browser sees it (proxy headers win). */
function externalOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = requestIsSecure(request) ? "https" : "http";
  return `${proto}://${host}`;
}

/** Issuer-internal redirect targets that must be re-prefixed with /api/auth. */
function rewriteIssuerLocation(location: string): string {
  const path = location.split("?", 1)[0]!;
  const internal =
    path === "/authorize" || path === "/token" || path === "/password" || path.startsWith("/password/") || path.startsWith("/.well-known/");
  return internal ? `${MOUNT}${location}` : location;
}

async function parseBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const json = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v ?? "")]));
    }
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, v.toString()]));
  } catch {
    return {};
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/**
 * Handle any /api/auth/* request: first-party endpoints first, then the
 * OpenAuth issuer with the mount prefix stripped (issuer-internal redirect
 * Locations re-prefixed on the way out).
 */
export async function handleAuthRequest(db: Db, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice(MOUNT.length) || "/";
  const method = request.method.toUpperCase();

  // --- CRM first-party endpoints (docs/auth-api.md) ---

  if (sub === "/login" && method === "POST") {
    const body = await parseBody(request);
    if (!body.email || !body.password) {
      return json({ ok: false, error: { code: "validation", message: "email and password are required" } }, 400);
    }
    const result = await performPasswordLogin(db, { email: body.email, password: body.password });
    if (!result.ok) {
      return json({ ok: false, error: { code: result.error, message: LOGIN_ERROR_MESSAGES[result.error] } }, 401);
    }
    return json(
      { ok: true, mustChangePassword: result.mustChangePassword, provisioned: !result.unprovisioned },
      200,
      { "set-cookie": sessionCookie(result.sessionToken, request) },
    );
  }

  if (sub === "/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) return redirect(withParams("/login", { error: url.searchParams.get("error") ?? "expired_flow" }));
    // The browser flow must have started with this exact redirect_uri.
    const tokens = await exchangeCode(db, code, `${externalOrigin(request)}${MOUNT}/callback`);
    if (!tokens) return redirect("/login?error=expired_flow");
    const result = sessionFromTokens(db, tokens);
    if (!result.ok) return redirect(`/login?error=${result.error}`);
    const signupUrl = process.env.EMCP_AUTH_SIGNUP_URL?.trim();
    const location = result.unprovisioned
      ? withParams(signupUrl ?? "/login", { state: "registered" })
      : result.mustChangePassword
        ? "/set-password"
        : "/app";
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": sessionCookie(result.sessionToken, request),
      },
    });
  }

  if (sub === "/set-password" && method === "POST") {
    const body = await parseBody(request);
    const purpose = body.purpose === "reset" ? "reset" : body.purpose === "setup" ? "setup" : null;
    if (!body.email || !body.code || !body.password || !purpose) {
      return json(
        { ok: false, error: { code: "validation", message: "email, code, purpose and password are required" } },
        400,
      );
    }
    if (body.password.length < MIN_PASSWORD || body.password.length > MAX_PASSWORD) {
      return json(
        {
          ok: false,
          error: { code: "weak_password", message: `Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters` },
        },
        400,
      );
    }
    const outcome = await redeemAuthCodeAndSetPassword(db, {
      email: body.email,
      purpose,
      code: body.code,
      password: body.password,
    });
    if (!outcome.ok) {
      const status = outcome.reason === "rate_limited" ? 429 : 401;
      const message =
        outcome.reason === "expired_code"
          ? "This code has expired — ask for a new one"
          : outcome.reason === "rate_limited"
            ? "Too many attempts — ask for a new code"
            : "Invalid email or code";
      return json({ ok: false, error: { code: outcome.reason, message } }, status);
    }
    return json({ ok: true });
  }

  if (sub === "/logout" && method === "POST") {
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    if (token) destroySession(db, token); // also revokes the OpenAuth refresh token
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(request) });
  }

  // --- Everything else: the OpenAuth issuer, mount prefix stripped ---

  const stripped = new URL(request.url);
  stripped.pathname = sub;
  const response = await getAuthApp(db).fetch(
    new Request(stripped.toString(), {
      method: request.method,
      headers: request.headers,
      body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    }),
  );
  const location = response.headers.get("location");
  if (location?.startsWith("/")) {
    const rewritten = rewriteIssuerLocation(location);
    if (rewritten !== location) {
      const headers = new Headers(response.headers);
      headers.set("location", rewritten);
      return new Response(response.body, { status: response.status, headers });
    }
  }
  return response;
}

/** For tests: the session a request's cookie resolves to. */
export function sessionFromRequest(db: Db, request: Request) {
  return resolveSession(db, cookieValue(request.headers.get("cookie"), SESSION_COOKIE));
}

/** Test seam: reset the per-process issuer cache (fresh DB per test). */
export function resetAuthAppCache(): void {
  cached = null;
}

/** For login pages: expose the joined refresh-token storage key prefix (tests assert revocation). */
export function refreshKeyPrefix(subject: string): string {
  return joinAuthKey(["oauth:refresh", subject]);
}
