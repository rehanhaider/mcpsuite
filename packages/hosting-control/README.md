# @emcp/hosting-control

The private-network **hosting control API** from
`docs/architecture/hosting-control-api.md`: the narrow HTTP boundary a hosting
company's private SaaS uses to provision, lock/unlock, inspect, and permanently
delete CRM workspaces. Normal self-hosted installations never start this
process, and it must never be routed from the public domain.

```text
private SaaS -> private HTTPS -> hosting control API -> CRM database transaction
```

## Run

```bash
HC_SERVICE_KEY=<at least 32 random chars> pnpm --filter @emcp/hosting-control start
```

| Env | Default | Meaning |
| --- | --- | --- |
| `HC_SERVICE_KEY` | — (required) | Bearer service key; boot refuses without it. No keyless mode. |
| `HC_SERVICE_KEY_SECONDARY` | — | Optional second key so rotation can overlap. |
| `HC_HOST` | `127.0.0.1` | Bind address. Keep it on the private network. |
| `HC_PORT` | `8787` | Listen port. |
| `DB_PATH` | `./data/emcp.db` | The shared CRM SQLite file (mise sets it). |

Every non-health request needs `Authorization: Bearer <key>` (SHA-256 +
`timingSafeEqual` verification). Health is intentionally keyless so a load
balancer can probe it; it returns no workspace, user, credential, or CRM data.

## Endpoints (base `/api/v1`)

| Method | Path | Semantics |
| --- | --- | --- |
| `GET` | `/healthz`, `/api/v1/health` | Readiness + product/schema versions. |
| `GET` | `/api/v1/workspaces/:id` | Limited control state: `{ workspaceId, accessMode, accessExpiresAt, ownerUserId, version }`. Deleted and never-existed answer the same `not_found`. |
| `POST` | `/api/v1/workspaces` | Provision workspace + owner + memberships + default pipelines/stages in one transaction. Body: `{ organizationName, ownerEmail, ownerName?, ownerPassword?, accessMode?, accessExpiresAt?, defaultCurrency?, timezone? }`. `201` with `{ workspaceId, ownerUserId, accessMode, accessExpiresAt, version }`. An already-bound identity is a stable `identity_unavailable` conflict. |
| `PUT` | `/api/v1/workspaces/:id/access` | Set generic access state. Body: `{ accessMode: "active"\|"locked", accessExpiresAt?: ISO\|null, expectedVersion?, reason? }` (`state`/`expiresAt` accepted as aliases). Same-state repeat succeeds with no duplicate effect; `expectedVersion` mismatch is `version_conflict` with `currentVersion`. |
| `DELETE` | `/api/v1/workspaces/:id` | Idempotent permanent delete. Removes every workspace-scoped row (tables discovered by their `workspace_id` column), users whose only membership was this workspace, and their sessions. Absent target still returns `204`. |

Common contract: mutations require an `Idempotency-Key` header. Same key +
same canonical body replays the original response; same key + different
request is `idempotency_conflict`; a concurrent claim answers
`request_in_progress` (retryable). Success envelope `{ data, requestId }`,
errors `{ error: { code, message, retryable }, requestId }`; the
`X-Request-Id` header always carries the effective request id.

## Own tables (created by this package on open)

This package creates its own SQLite tables at startup — it never touches
`packages/db/src/migrations.ts`:

- `hc_idempotency_receipts` — one row per idempotency key: action, canonical
  request hash, state, safe stored response, timestamps. Mutations and their
  receipt completion commit in the same transaction.
- `hc_workspace_access` — `workspace_id (PK), access_mode ('active'|'locked'),
  access_expires_at (ISO or NULL), version, created_at, updated_at`.
- `hc_service_audit` — permanent service-action audit: request/idempotency
  ids, action, method/path, workspace id + one-way `target_hash`, reason,
  service identity, result code, HTTP status, product version, timestamps.
  Permanent deletion scrubs the raw workspace id from earlier rows; only the
  hash-bearing receipt remains. Authorization headers and raw keys are never
  stored.

## The read contract: how the CRM enforces access state

Enforcement inside the CRM (web, operation API, MCP) is deliberately **not**
implemented by this package. The contract is implemented as
`resolveWorkspaceAccess(db, workspaceId, now?) → { mode, expiresAt }` — it
lives in `@emcp/db` (so CRM surfaces consult it through their existing
dependency) and is re-exported here as part of the contract this package
owns. The CRM consults it in the web server functions (`op`, `whoami`,
`changePassword`), `POST /api/ops/:name`, `GET /api/me`, and per tool call /
resource read on both MCP transports. The contract:

```sql
SELECT access_mode, access_expires_at
FROM hc_workspace_access
WHERE workspace_id = ?;
```

- **No row → treat as `active`.** Self-hosted databases never get a row, so
  self-hosting is unaffected.
- Effectively locked when `access_mode = 'locked'` **or**
  `access_expires_at` is non-NULL and `<= now` (ISO strings compare
  lexicographically). An `active` workspace therefore locks itself when its
  expiry arrives, without another hosting request.
- While locked: login, a locked notice, and `GET /api/me` stay available;
  CRM records, catalog operations, `/api/ops/*`, exports, and MCP must refuse.
- The check belongs where the request context is resolved (session / MCP key
  resolution), so every surface inherits it. If the schema later moves to
  Postgres, this table's successor keeps the same three-column read shape.

## Deltas vs `docs/architecture/hosting-control-api.md`

Implemented for the current single-node SQLite product; known deviations:

- **Identity**: the doc provisions from a *verified OpenAuth subject*. OpenAuth
  does not exist in this product yet, so `ownerEmail` is the identity and an
  optional `ownerPassword` (>= 10 chars) may be set for the current
  password-auth login; omitted → the owner has no password until one is set.
  Responses never contain password material.
- **Not implemented (out of scope for this slice)**: owner transfer
  (`PUT …/owner`), owner recovery (`POST …/owner/recovery`), key storage with
  hashed rotation/revocation records (keys come from env; two overlapping env
  keys supported), rate limiting (`429`), `503 dependency_unavailable`
  mapping, and the OpenAPI document + fixtures. Locked-mode enforcement and
  its tests now live on the CRM side (see the read contract above).
- Provision keeps counters lazy (like `bootstrap()`), and the provision
  replay-after-deletion returns the original id-only response (the doc leaves
  this open; no customer content is stored in the receipt).
