# MCP Suite CRM

An open-source CRM built for humans and AI agents to operate together. The web
application and every MCP client use the same typed operation catalog, with
role checks, scoped agent keys, approval gates for risky agent actions, and a
shared audit trail.

> **Pre-release:** the source is public, but the supported installer, npm
> package, container image, and stable release are not published yet.

## What is included

| Path | Purpose |
| --- | --- |
| `apps/web` | Login, the authenticated CRM under `/app/*`, and the HTTP operation API |
| `apps/mcp` | MCP over stdio and HTTP |
| `packages/core` | Domain types, authorization policy, and operation catalog |
| `packages/db` | SQLite persistence, migrations, authentication, and bootstrap |

The CRM covers companies, people, leads, deals, activities, tasks, pipelines,
tags, contact lists, custom fields, saved views, offerings, approvals, users,
agents, and audit events. The public marketing site, signup, billing, and
managed-hosting controls are deliberately not part of this repository.

## Run from source

The supported development platform is 64-bit Linux. Install
[mise](https://mise.jdx.dev); the repository pins Node 22 and pnpm 10.

```sh
mise trust
mise exec -- make setup
mise exec -- make dev
```

Open <http://localhost:2222>. `/` redirects to `/login`. The first setup creates
the SQLite database at `data/emcp.db` and prints the initial owner credentials;
change the password after signing in.

## Run with Docker

```sh
docker compose up -d
```

The web app listens on `:2222`, MCP HTTP on `:8765`, and persistent state lives
in `./data`. The compose file builds the image locally until official images
are released.

## Connect an agent

In the CRM, open **Admin → Agents**, create an agent client, and copy the key
shown once. The UI provides a ready-to-paste configuration. The full transport,
scope, and trust-profile guide is in [docs/mcp.md](docs/mcp.md).

Example for Claude Code:

```sh
claude mcp add --transport http mcpsuite-crm http://localhost:8765/mcp \
  --header "Authorization: Bearer emcp_YOUR_KEY"
```

## Development checks

```sh
mise exec -- make typecheck
mise exec -- make test
mise exec -- make build
mise exec -- make smoke
```

See [AGENTS.md](AGENTS.md) for the code architecture and conventions,
[PRODUCTION.md](PRODUCTION.md) for the current self-hosting runbook, and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
