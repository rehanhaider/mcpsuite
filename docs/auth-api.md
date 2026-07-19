# Authentication API — `/api/auth/*`

_Contract for the OpenAuth 0.4.3 issuer mounted inside the CRM web app, the
CRM's first-party auth endpoints, and the auth-code delivery seam. This is the
surface the private SaaS builds signup/account flows against (docs/issues/0022,
DECISIONS.md § Auth). Derived from the actual `@openauthjs/openauth@0.4.3`
issuer + `PasswordProvider` implementation, not from its docs._

## Topology

- One OpenAuth **issuer** runs inside the CRM web process, mounted at
  **`/api/auth`** on the product origin (a TanStack catch-all route adapts the
  issuer's Fetch handler). There is no separate auth service or hostname.
- Storage is the CRM database: table **`openauth_kv`** (SQLite now; the
  adapter is dialect-agnostic behind a small KV port so the PostgreSQL
  deployment mirrors it). OpenAuth owns everything in that table: password
  hashes, signing/encryption keys, authorization codes, refresh tokens,
  email→subject bindings. **The CRM never stores login passwords itself.**
- Exactly one provider is configured: **`password`** with custom UI (the
  provider's screens are HTTP redirects to CRM pages, never OpenAuth-rendered
  HTML).
- Token claims are **never authority**. After any successful flow the CRM
  issues its own `emcp_session` cookie whose row links to the OpenAuth
  subject; every request re-resolves current user/workspace/role/enabled
  state from the database.

## Subjects and tokens

- Subject type: `account`, properties `{ email: string }`.
- `sub` claim: a stable opaque id (`acct_…`) minted by the CRM on the first
  successful authentication for a user and stored in `users.auth_subject`
  (UNIQUE). Subsequent logins match by subject, not email.
- Access token: JWT (RS512-family key from `openauth_kv`), default TTL 30 d.
  `iss` is the request **origin only** (e.g. `https://host`) — OpenAuth
  computes it without the `/api/auth` mount prefix. Anyone verifying JWTs must
  expect that; the CRM itself does not consume JWTs for per-request authority.
- Refresh token: `"<subject>:<uuid>"`, stored under
  `openauth_kv["oauth:refresh"▸<subject>▸<uuid>]`, default TTL 1 y.

## OAuth 2.0 endpoints (OpenAuth core)

All paths below are relative to the origin; the mount prefix is part of the
path.

### `GET /api/auth/authorize`

Starts a flow. Query parameters:

| param | required | notes |
| --- | --- | --- |
| `client_id` | yes | free-form string; see *Client allow-list* below |
| `redirect_uri` | yes | absolute URL; validated by the allow rule |
| `response_type` | yes | `code` (use this) or `token` |
| `provider` | no | `password` (only provider; auto-selected anyway) |
| `state` | recommended | echoed back on the redirect |
| `code_challenge`, `code_challenge_method=S256` | no | PKCE for public clients |
| `audience` | no | forwarded into the auth state |

Behavior: stores the authorization state in an **encrypted, HttpOnly cookie**
named `authorization` (Path=/, 24 h; `Secure; SameSite=None` when the request
URL is https) and 302-redirects to `/api/auth/password/authorize`.

**Client allow-list** (OpenAuth default `allow`): the `redirect_uri` host must
be `localhost`/`127.0.0.1` or same-site with the request host
(`x-forwarded-host` respected). Same-origin SaaS pages therefore work without
registration; there is no client secret.

### `POST /api/auth/token`

`application/x-www-form-urlencoded`. Three grants:

1. `grant_type=authorization_code` with `code`, `redirect_uri`, `client_id`,
   optional `code_verifier`. Success `200`:
   `{ "access_token": "<jwt>", "refresh_token": "<subject>:<uuid>", "expires_in": <s> }`.
   Errors `400/403`: `{ "error": "invalid_grant" | "invalid_redirect_uri" | "unauthorized_client", "error_description": … }`.
   Codes are single-use with a 60 s TTL.
2. `grant_type=refresh_token` with `refresh_token`. Same success shape;
   rotation with a 60 s reuse window; reuse past the window revokes the whole
   subject's refresh tokens.
3. `grant_type=client_credentials` — **not supported** (the password provider
   has no client credentials handler; returns 400).

### Discovery

- `GET /api/auth/.well-known/oauth-authorization-server` and
  `GET /api/auth/.well-known/jwks.json` are served (CORS `*`).
- **Caveat:** the metadata document advertises `authorization_endpoint`/
  `token_endpoint`/`jwks_uri` on the origin **without** the `/api/auth`
  prefix (upstream computes them from the origin). Do not follow those URLs.
  First-party code uses issuer base `origin + "/api/auth"` and builds
  `${issuer}/authorize` / `${issuer}/token` directly — exactly what
  `createClient` from `@openauthjs/openauth/client` does for `authorize()` and
  `exchange()`; do not rely on `client.verify()` (it checks `iss` against the
  prefixed issuer string and will fail — by design we never verify authority
  from tokens).

## Password provider endpoints

The provider is mounted at `/api/auth/password/*`. All POSTs are
`application/x-www-form-urlencoded` (a plain `<form>` works). UI callbacks are
implemented as 302 redirects to CRM/SaaS pages carrying flow state in query
parameters — see *UI redirect contract*.

### `GET /api/auth/password/authorize`

Requires the `authorization` cookie from `GET /api/auth/authorize` (else the
flow errors with `UnknownStateError` → redirect to `/login?error=expired_flow`).
Responds with the login UI redirect: `302 /login?flow=1`.

### `POST /api/auth/password/authorize`

Form fields: `email`, `password`. On success OpenAuth stores
`email → subject`, mints a single-use authorization code and 302-redirects to
`<redirect_uri>?code=…&state=…`. On failure re-invokes the login UI:
`302 /login?flow=1&error=invalid_password|invalid_email&email=…`.

The CRM's `success` callback runs **before** the redirect and enforces
identity linking:

- pending CRM user with this (verified) email → activated, subject bound once;
- known subject → resolves to its user;
- active user without a subject (e.g. after an owner recovery code) → subject
  bound on this first login;
- **unknown email → flow rejected**: `302 /login?error=not_invited` (self-host
  has no public signup; hosted signup pre-creates the pending owner through
  provisioning);
- disabled user → `302 /login?error=account_disabled`.

### `GET|POST /api/auth/password/register`

Two-step state machine (state lives in an encrypted `provider` cookie, 24 h):

1. state `start` — POST `action=register`, `email`, `password`, `repeat` →
   password policy check (min 10 chars), duplicate-credential check
   (`email_taken`), then OpenAuth generates a 6-digit verification code and
   calls the delivery seam (purpose `verify`); state advances to `code`.
2. state `code` — POST `action=verify`, `code` → on match the credential is
   stored and the flow completes through the same `success` linking above.
   POST `action=register` in state `code` re-sends a fresh code.

Errors: `invalid_email`, `invalid_password`, `password_mismatch`,
`email_taken`, `invalid_code`, `validation_error` (+`message`).

Register must be entered **inside an authorize flow** (it completes via the
`authorization` cookie). It is UI-gated, not existence-gated: without
`EMCP_AUTH_SIGNUP_URL` the register UI redirects to
`/login?error=signup_disabled`; completing a register for an email with no
pending CRM user still dead-ends at `not_invited`. Hosted signup (the SaaS
stream) sets `EMCP_AUTH_SIGNUP_URL` and builds its screens on this state
machine.

### `GET|POST /api/auth/password/change`

Self-contained email-code → new-password flow (no authorize state needed).
`GET /api/auth/password/change?redirect_uri=<abs-url>` starts it.

1. POST `action=code`, `email` → OpenAuth generates a 6-digit code → delivery
   seam (purpose `reset`); state `code`.
2. POST `action=verify`, `code` → state `update`.
3. POST `action=update`, `password`, `repeat` → stores the new hash, revokes
   all refresh tokens for the subject, `302 redirect_uri`.

This flow only works for **existing** credentials. The CRM's own reset path
(admin-issued codes, below) is the primary self-host mechanism; this flow is
what hosted self-service reset builds on.

## UI redirect contract (custom provider UI)

The provider UI callbacks are pure redirects; pages re-enter the flow by
POSTing back to the provider endpoints above.

| screen | redirect target |
| --- | --- |
| login | `/login?flow=1[&error=invalid_password\|invalid_email][&email=…]` |
| register | `${EMCP_AUTH_SIGNUP_URL}?state=start\|code[&error=…][&message=…][&email=…]` — unset ⇒ `/login?error=signup_disabled` |
| change | `/reset-password?flow=change&state=start\|code\|update[&error=…][&message=…][&email=…]` |
| flow-state loss | `/login?error=expired_flow` |
| success-callback rejections | `/login?error=not_invited\|account_disabled` |

## CRM first-party endpoints (inside the same catch-all)

These are not OpenAuth routes; they are the JSON/browser conveniences the CRM
UI uses and the SaaS may reuse. They run the full OAuth code flow **in-process**
against the issuer (no self-HTTP), so behavior is identical to the browser
dance.

### `POST /api/auth/login`

`application/json` or form body: `{ "email": …, "password": … }`.

- `200 {"ok":true,"mustChangePassword":false}` + `Set-Cookie: emcp_session=…`
- `200 {"ok":true,"mustChangePassword":true}` — client must send the user to
  `/set-password` (every catalog operation is refused with
  `password_change_required` until the password is changed).
- `401 {"ok":false,"error":{"code":"invalid_credentials"|"not_invited"|"account_disabled"|"expired_flow","message":…}}`

### `GET /api/auth/callback?code=…&state=…`

Redirect target for the browser code flow with `client_id=crm-web`
(`redirect_uri` must be `<origin>/api/auth/callback`). Exchanges the code,
resolves the subject to the CRM user, creates the session row (linked to the
subject + refresh token), sets `emcp_session`, then `302 /app` — or
`302 /set-password` when `password_must_change` is set. On failure
`302 /login?error=…`.

### `POST /api/auth/set-password`

Redeem a **CRM-issued** setup/reset code and set the password directly in
OpenAuth storage (same scrypt shape as the provider: N=16384, r=8, p=1,
32-byte key, base64). JSON body:

```json
{ "email": "…", "code": "XXXX-XXXX-XXXX", "purpose": "setup" | "reset", "password": "…" }
```

- `200 {"ok":true}` — code consumed (single-use). `reset` additionally ends
  all of the user's sessions and revokes their OpenAuth refresh tokens.
  Activation/subject-binding still happens on the first login, not here.
- `400/401/429 {"ok":false,"error":{"code":"invalid_code"|"expired_code"|"rate_limited"|"weak_password"|"validation","message":…}}`

There is **no public activate endpoint**; a code is required and codes only
come from admin/owner action (or bootstrap).

### `POST /api/auth/logout`

Deletes the session row, revokes the session's OpenAuth refresh token, clears
the cookie. `200 {"ok":true}`. (The TanStack `logout` server fn does the same
for the app UI.)

## Session cookie

`emcp_session=<opaque token>` — HttpOnly; SameSite=Lax; Path=/; host-only (no
`Domain`); `Max-Age=2592000` (30 d, matches the DB row); `Secure` iff the
effective protocol is https (`x-forwarded-proto` wins over the socket). Only
the SHA-256 of the token is stored. The session row carries `user_id`,
`auth_subject`, and the refresh token for logout-time revocation; per-request
resolution loads the current user (must be `status='active'`), membership,
role, and `password_must_change` — never token claims.

`GET /api/me` (unchanged) is the cross-app introspection endpoint for
first-party pages (e.g. the hosted `/account`): same cookie, returns
`{ userId, email, name, role, workspaceId, accessMode, accessExpiresAt }`.

## CRM setup/reset codes and the delivery seam

CRM-issued codes (distinct from OpenAuth's 6-digit flow-internal codes):

- Format `XXXX-XXXX-XXXX` from an unambiguous A–Z/2–9 alphabet (no
  I/L/O/0/1); comparison is case-insensitive and separator-insensitive.
- Stored as SHA-256 only; single-use; expiring (setup 7 d, reset 60 min);
  regenerating invalidates all earlier codes of that purpose; issuing a
  `reset` code ends the user's sessions immediately.
- Rate-limited per email (fixed window: max 5 issues / 15 min) and max 10
  failed verification attempts per code.
- Issued only via `ports.credentials.issueCode(userId, "setup"|"reset")`
  (operation catalog: `user.create`, `user.regenerateSetupCode`,
  `user.resetPassword`), via first-run bootstrap (pending owner), and via the
  server-side owner recovery CLI (`pnpm --filter @emcp/db reset-owner`).

**Delivery seam** — `deliverAuthCode({ email, code, purpose })`, purposes
`"setup" | "reset" | "verify"` (`verify` = OpenAuth's own register/change
codes; both code kinds flow through the same seam):

- If `EMCP_AUTH_DELIVERY_URL` is set (hosted): `POST` that URL with JSON
  `{ "email": …, "code": …, "purpose": … }` and
  `Authorization: Bearer $EMCP_AUTH_DELIVERY_KEY` (when set). Any 2xx is
  delivered; anything else is a hard failure (the code is never logged and
  never shown in a response). The SaaS owns turning this webhook into email.
- Otherwise (self-host, "display" mode): the code is surfaced exactly once to
  the initiator — the op result for admin-issued codes, stdout for
  bootstrap/CLI, the server terminal for OpenAuth flow codes.

## First run and recovery

- Bootstrap (empty SQLite DB) creates a **pending owner** and prints a
  one-time setup code and the `/set-password` URL — never a password.
  `EMCP_OWNER_PASSWORD` is removed and ignored.
- `pnpm --filter @emcp/db reset-owner` prints a fresh one-time code for the
  owner (setup code while the owner is still pending, reset code once
  active). Server-side access only.

## Environment variables

| var | effect |
| --- | --- |
| `EMCP_AUTH_DELIVERY_URL` | hosted code delivery webhook (else display mode) |
| `EMCP_AUTH_DELIVERY_KEY` | bearer key for the delivery webhook |
| `EMCP_AUTH_SIGNUP_URL` | base URL of the hosted signup UI (register screens); unset ⇒ signup disabled |
| `EMCP_BASE_URL` | absolute origin used in printed setup URLs (default `http://localhost:2222`) |

## Hosted open registration (trial-first signup)

Setting `EMCP_AUTH_SIGNUP_URL` switches the deployment into open registration:

- The register flow accepts NEW emails (self-host keeps `signup_disabled`).
- Register/verify success for an email with **no CRM user yet** mints a stable
  subject and completes the OAuth flow into an **unprovisioned session**: the
  `emcp_session` cookie is set with `user_id = NULL` and the verified email as
  the adoption key. The browser callback 302s to
  `${EMCP_AUTH_SIGNUP_URL}?state=registered` instead of `/app`.
- `GET /api/me` reports the state as
  `{ userId: null, subject, email, workspaceId: null, …, provisioned: false }`
  — the signup page reads it to drive provisioning.
- Hosting-control provisioning (`POST /api/v1/workspaces`) checks
  `hasPasswordCredentialSync(email)`: with a completed credential (proof the
  holder registered + verified here) the owner is created **active** with no
  setup code; without one the pending-owner + setup-code path applies
  unchanged. Nobody can provision an email they did not verify.
- On the next request after provisioning, the session resolver **adopts** the
  user by email: binds the session's subject to the user (bind-once; a
  different pre-bound subject kills the session), upgrades the session row,
  and `/api/me` flips to `provisioned: true`. No second password entry.
- Login (`POST /api/auth/login` and the authorize flow) with a registered but
  unprovisioned identity also yields the unprovisioned session in open mode
  (`provisioned: false` in the JSON response); in closed mode it stays
  `not_invited`.
