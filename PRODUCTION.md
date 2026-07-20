# Self-hosting MCP Suite CRM

This runbook describes the current source checkout. Supported release
installers, npm installation, and prebuilt images will be added only when the
product is ready for its first stable release. The tested host platform is
64-bit Linux; Windows and macOS are not supported release targets.

## One process, one port

The installed product is a single application process. It serves, on one port
(`WEB_PORT`, default `2222`):

- the browser application and operation API (`/`, `/api/...`),
- the stateless MCP HTTP endpoint for agents (`POST /mcp`, Bearer API key
  from **Admin → Agents** required),
- a cheap liveness probe (`GET /healthz`).

MCP over stdio is launched on demand by agent clients (`pnpm mcp:stdio`) and
is not a service. A separate MCP HTTP process (`pnpm mcp:http`, port
`MCP_PORT`) still exists for deployments that need to scale MCP traffic
independently — it shares the same per-request handling and auth as the
in-process endpoint — but the default install does not run it.

## Docker Compose

```sh
docker compose up -d
docker compose logs -f
```

Compose builds the `mcpsuite/crm` image from this checkout, exposes
everything on `:2222`, and persists SQLite under `./data`. The first run
against an empty `./data` prints a one-time owner setup code in the logs —
redeem it at `/set-password`. The container healthcheck probes
`GET /healthz`.

To scale MCP separately, run a second container from the same image with a
command override (skip publishing `:8765` unless agents connect from outside
the host):

```yaml
  emcp-mcp:
    image: mcpsuite/crm
    command: pnpm mcp:http
    ports:
      - "8765:8765"
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8765/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
    restart: unless-stopped
```

The override skips database setup — that stays the web service's job, so
the setup code prints exactly once.

## Run directly on Linux

Install mise, then:

```sh
mise trust
mise exec -- make setup
mise exec -- make build
mise exec -- make autostart
mise exec -- make autostart-status
```

The current autostart target installs systemd **user** services. It is
intended for development and early self-hosting, not yet the final
machine-wide installer. The web service alone is a complete install (it
serves `/mcp` itself); the separate MCP HTTP service is only needed if you
want MCP on its own port (`make autostart SVC=web` installs just the web
service).

After pulling source changes:

```sh
mise exec -- make deploy
```

Do not run `make dev` while the `emcp-web` service owns port 2222.

## Put it behind HTTPS

Keep port 2222 private. A reverse proxy should terminate TLS and forward all
traffic — browser, API and `/mcp` — to the one web process. For example,
with Caddy:

```caddyfile
crm.example.com {
    reverse_proxy localhost:2222
}
```

If you run the standalone MCP process, route `/mcp` to it instead:

```caddyfile
crm.example.com {
    reverse_proxy /mcp* localhost:8765
    reverse_proxy localhost:2222
}
```

Every MCP request must still carry a per-agent key from **Admin → Agents**.
Never expose an unauthenticated MCP endpoint; this application has no keyless
mode.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_PATH` | `data/emcp.db` through mise | SQLite database path |
| `WEB_PORT` | `2222` | The product port: web app + API + `/mcp` + `/healthz` |
| `MCP_PORT` | `8765` | Standalone MCP HTTP process only |
| `MCP_HOST` | `127.0.0.1` | Standalone MCP bind address; Docker sets `0.0.0.0` |
| `EMCP_API_KEY` | none | MCP key used by the stdio launcher |

## Backups

SQLite's online backup command is safe while the database is in WAL mode:

```sh
sqlite3 /path/to/emcp.db "VACUUM INTO '/path/to/backups/emcp-backup.db'"
```

Copy backups off the host and test restoration. To restore, stop the
service, replace the database file, and restart it.

## Current operational limits

- Owner setup credentials are printed during bootstrap; there is no email
  delivery or self-service password reset yet.
- Backups, monitoring, TLS, log collection, and rate limiting remain the
  operator's responsibility.
- Stable upgrade guarantees begin with the first published release.
