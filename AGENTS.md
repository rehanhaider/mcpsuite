# MCP Suite CRM — contributor guide

MCP Suite CRM treats AI agents as first-class operators. Humans using the web
UI and agents using MCP call the same operation catalog. Risky agent actions
can wait for human approval.

## Stack and layout

This is a pnpm workspace managed by mise (Node 22 and pnpm 10).

- `packages/core` contains dependency-free domain types, zod schemas, policy,
  persistence ports, the operation catalog, and business operations. Browser
  code may import `@emcp/core/domain` and `@emcp/core/policy`; the root barrel
  is server-only.
- `packages/db` is the only package that touches SQLite. It owns Drizzle
  schema, versioned migrations, repository implementations, bootstrap, auth,
  sessions, MCP keys, and the runtime composition.
- `apps/web` is the TanStack Start application. `/` redirects to `/login`; the
  authenticated product lives under `/app/*`; `POST /api/ops/:name` exposes
  the catalog to scripts and future clients. Server functions are in
  `src/server/fns.ts`, and the client data layer is in `src/lib/api.ts`.
- `apps/mcp` turns catalog operations marked `mcpExpose` into MCP tools. It
  supports authenticated stdio and HTTP transports.
- `data/emcp.db` is the SQLite WAL database created and migrated on first run.

## Commands

Run commands through mise so every process receives the same `DB_PATH`.

```text
make setup            install dependencies, migrate, and bootstrap
make dev              web development server on :2222
make build / start    build and serve the production web app
make mcp / mcp-http   MCP stdio / MCP HTTP on :8765
make migrate          apply migrations and bootstrap idempotently
make test / typecheck run the automated checks
make smoke            exercise every catalog operation and clean up
docker compose up -d  run web and MCP with ./data persisted
```

## Operation catalog

Every query and mutation goes through `runOperation` in
`packages/core/src/catalog.ts`: authorize, validate, apply the agent-risk gate,
execute, and write audit events in the same transaction. Operations declare a
minimum role, scope, and optional risk category. Human actors execute permitted
operations directly. Agent behavior depends on the client's trust profile.

Adding product behavior normally means adding or extending an operation,
implementing any new persistence port in `packages/db`, and then presenting the
same behavior through the web UI. Do not put separate business rules in the UI,
HTTP adapter, or MCP adapter.

## Domain and isolation

All CRM records are workspace-scoped and use UUIDv7 IDs plus per-type display
IDs. The model includes companies, people, leads, deals, activities/tasks,
pipelines/stages, tags, contact lists, custom fields, saved views, offerings,
pending approvals, audit events, users, sessions, and MCP clients.

Mutable entities use optimistic concurrency through `version` and
`expectedVersion`. Soft deletion uses `archivedAt`; hard deletion is a
destructive-risk operation.

## Conventions

- Data flow is UI or MCP → operation catalog → ports → Drizzle. Routes and
  components never import `@emcp/db`; only the server composition layer does.
- React Query keys are `["op", name, input]`. Mutations use the invalidation
  graph in `apps/web/src/lib/api.ts`. Zustand stores client-only UI state.
- Use semantic theme variables and the existing Base UI primitives. Do not add
  DaisyUI or gradients. Stage and tag colors use the semantic mappings in
  `apps/web/src/lib/colors.ts`.
- Append schema changes to `MIGRATIONS` and mirror them in `schema.ts`. Never
  edit an applied migration or modify a live database by hand.
- Model status-like values as workspace data when users need to customize
  them. Money is integer minor units plus ISO currency; dates are ISO strings.

## Authentication

The web currently uses email/password with scrypt and an HttpOnly session
cookie. Roles are owner, admin, member, and viewer. MCP uses revocable API keys
created in **Admin → Agents**. Keys are hashed at rest, carry scopes and a trust
profile, and act with the creator's current role. Disabling or demoting the
creator immediately affects their agents. There is no keyless MCP mode.

## Gotchas

- Keep the SQLite database on a Linux filesystem.
- Do not start a development process on a port already owned by a systemd user
  service.
- `srvx` requires the existing `--dir . --static dist/client` flags.
- MCP HTTP is stateless and creates a fresh transport per request.
- Web and MCP packages currently pass test commands with no local tests; core
  and database packages contain the active suites.
