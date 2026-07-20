# @emcp/hosting-control

The private-network **hosting control API** from
`docs/architecture/hosting-control-api.md`: the narrow HTTP boundary a hosting
company's private SaaS uses to provision, lock/unlock, inspect, transfer or
recover ownership of, and permanently delete CRM workspaces. Normal
self-hosted installations never start this process, and it must never be
routed from the public domain.

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
| `EMCP_AUTH_DELIVERY_URL` | — | **Hosted mode** when set: one-time setup/reset codes are POSTed here as `{ email, code, purpose }` and never appear in any response, log, or stored row. Unset = **display mode** (self-host/dev): the response may carry the code exactly once. |
| `EMCP_AUTH_DELIVERY_KEY` | — | Optional bearer key sent as `Authorization: Bearer …` with each delivery POST. |

Every non-health request needs `Authorization: Bearer <key>` (SHA-256 +
`timingSafeEqual` verification). Health is intentionally keyless so a load
balancer can probe it; it returns no workspace, user, credential, or CRM data.

## Endpoints (base `/api/v1`)

| Method | Path | Semantics |
| --- | --- | --- |
| `GET` | `/healthz`, `/api/v1/health` | Readiness + product/schema versions. |
| `GET` | `/api/v1/workspaces/:id` | Limited control state: `{ workspaceId, accessMode, accessExpiresAt, ownerUserId, version }`. Deleted and never-existed answer the same `not_found`. |
| `POST` | `/api/v1/workspaces` | Provision workspace + **pending** owner + memberships + default pipelines/stages in one transaction, then route a single-use **setup code** through the delivery seam. Body: `{ organizationName, ownerEmail, ownerName?, accessMode?, accessExpiresAt?, defaultCurrency?, timezone? }` — **no password field**; a supplied `ownerPassword` is a `validation_error`. `201` with `{ workspaceId, ownerUserId, ownerStatus: "pending", accessMode, accessExpiresAt, version, setupDelivery: "queued"\|"display", setupCode? }`. `setupCode` exists in **display mode only**, in the live response only. An already-bound identity is a stable `identity_unavailable` conflict. |
| `PUT` | `/api/v1/workspaces/:id/access` | Set generic access state. Body: `{ accessMode: "active"\|"locked", accessExpiresAt?: ISO\|null, expectedVersion?, reason? }` (`state`/`expiresAt` accepted as aliases). Same-state repeat succeeds with no duplicate effect; `expectedVersion` mismatch is `version_conflict` with `currentVersion`. |
| `PUT` | `/api/v1/workspaces/:id/owner` | Bounded hosting-superuser owner transfer. Body: exactly one of `targetUserId`/`targetEmail`, plus mandatory `reason` and optional `expectedVersion`. The target must be an existing **active** user of this workspace — pending, disabled, unknown, and other-workspace targets all answer the same `409 target_not_eligible` (never creates users, never moves them between workspaces). One transaction demotes the previous owner to `admin`, promotes the target, keeps exactly one owner, bumps the control-state `version`, and writes both audits. `200` with `{ workspaceId, ownerUserId, previousOwnerUserId, version }`; repeating a completed transfer to the same target succeeds as a no-op. |
| `POST` | `/api/v1/workspaces/:id/owner/recovery` | Initiate credential recovery for the **current** owner (mandatory `reason`). Issues a one-time code — purpose `setup` while the owner is still pending, `reset` once active — and routes it through the delivery seam. `202` with `{ workspaceId, recovery: "initiated", purpose, delivery: "queued"\|"display", code? }`; `code` exists in display mode only, in the live response only. A disabled or absent owner is `409 owner_not_available` (recovery never picks a different person — that is what owner transfer is for). One idempotency key queues at most one recovery event. |
| `DELETE` | `/api/v1/workspaces/:id` | Idempotent permanent delete. Removes every workspace-scoped row (tables discovered by their `workspace_id` column), users whose only membership was this workspace, their sessions, and the workspace's queued deliveries. Absent target still returns `204`. |

Common contract: mutations require an `Idempotency-Key` header. Same key +
same canonical body replays the original response; same key + different
request is `idempotency_conflict`; a concurrent claim answers
`request_in_progress` (retryable). Success envelope `{ data, requestId }`,
errors `{ error: { code, message, retryable }, requestId }`; the
`X-Request-Id` header always carries the effective request id.

### One-time codes and the delivery seam

Setup/reset codes are issued through the CRM's single-use code store
(`issueAuthCodeSync` from `@emcp/db` — hash at rest, redeemable by the login
flow, superseding earlier codes of the same purpose; `reset` also ends the
owner's sessions) inside the same transaction as the mutation, then routed
through the product delivery seam (`deliverAuthCode`). The raw code never
enters storage or logs:

- **Hosted mode** (`EMCP_AUTH_DELIVERY_URL` set): the code is POSTed to the
  delivery endpoint as `{ email, code, purpose }` (bearer-authenticated with
  `EMCP_AUTH_DELIVERY_KEY` when set) and the HTTP response only confirms
  initiation (`"queued"`) — it **never** contains the code.
- **Display mode** (no URL — self-host/dev): nothing is sent anywhere; the
  live response carries the code exactly once so the operator can hand it
  over.
- Replays under the same idempotency key return the stored confirmation
  **without** the code in both modes (the receipt is redacted before storage).
- Hosted delivery is crash-safe: the transaction commits an
  `hc_auth_delivery_outbox` row (user reference + purpose — no email, no
  code) before the `201`/`202` returns; the immediate send is best-effort and
  a failure leaves the row pending. `listen()` sweeps pending rows on every
  start (also exported as `retryPendingAuthDeliveries(db)`), issuing a FRESH
  superseding code at send time — which is why codes never need to be stored.
- openauth's per-identity issue window (5 codes / 15 min) surfaces as
  `429 rate_limited` (retryable); the initiation rolls back and the
  idempotency key is released for a later retry.

## Own tables (created by this package on open)

This package creates its own SQLite tables at startup — it never touches
`packages/db/src/schema-sql.ts`:

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
- `hc_auth_delivery_outbox` — committed intent to deliver a setup/reset code
  in hosted mode: `workspace_id, user_id, purpose, state
  ('pending'|'sent'|'abandoned'), attempts, last_error, timestamps`. Holds no
  email address and no code (the sweep re-resolves the user and issues a
  fresh code). Deleted with its workspace.

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

- **Identity fields**: the doc provisions from a verified OpenAuth
  `authSubject` and transfers by `targetAuthSubject`. Until the OpenAuth
  binding is live end-to-end, `ownerEmail` is the provisioning identity and
  transfer targets resolve by `targetUserId` or `targetEmail` (resolution
  only — an email is never authority; the target must already be an active
  member). Requests carry no password or verification assertion, matching the
  doc's shape.
- **Owner setup/recovery codes**: the doc has OpenAuth run its own recovery
  flow and hosted email deliver it. Here the redeemable code comes from the
  CRM code store (`issueAuthCodeSync`) and travels through the
  `EMCP_AUTH_DELIVERY_URL` seam; in display mode (self-host/dev, no URL) the
  live response may carry the one-time code — a documented convenience the
  doc does not have. Replays never repeat a code, and hosted responses never
  contain one. The recovery outbox commits with the acknowledgement per the
  doc's outbox rule, and pending rows are re-sent (fresh superseding code) by
  the boot sweep.
- **Transfer version semantics**: the doc's inspect endpoint exposes one
  `version`; this implementation treats it as the control-state version —
  owner transfer checks `expectedVersion` against it and bumps it, exactly
  like access changes. A same-target repeat with a *stale explicit*
  `expectedVersion` is a `version_conflict` (reconcile by reading current
  state); without `expectedVersion` it is the doc's no-op success.
- **Not implemented (out of scope for this slice)**: key storage with hashed
  rotation/revocation records (keys come from env; two overlapping env keys
  supported), per-service-client request rate limiting (the code-issue window
  does map to `429 rate_limited`), `503 dependency_unavailable` mapping, and
  the OpenAPI document + fixtures. Locked-mode enforcement and its tests live
  on the CRM side (see the read contract above).
- Provision keeps counters lazy (like `bootstrap()`), and the provision
  replay-after-deletion returns the original id-only response (the doc leaves
  this open; no customer content is stored in the receipt).
