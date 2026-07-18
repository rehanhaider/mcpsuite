# Self-hosting MCP Suite CRM

This runbook describes the current source checkout. Supported release
installers, npm installation, and prebuilt images will be added only when the
product is ready for its first stable release. The tested host platform is
64-bit Linux; Windows and macOS are not supported release targets.

## Docker Compose

```sh
docker compose up -d
docker compose logs -f
```

Compose builds the image from this checkout, exposes the web app on `:2222`
and MCP HTTP on `:8765`, and persists SQLite under `./data`.

## Run directly on Linux

Install mise, then:

```sh
mise trust
mise exec -- make setup
mise exec -- make build
mise exec -- make autostart
mise exec -- make autostart-status
```

The current autostart target installs systemd **user** services for the web and
MCP processes. It is intended for development and early self-hosting, not yet
the final machine-wide installer.

After pulling source changes:

```sh
mise exec -- make deploy
```

Do not run `make dev` while the `emcp-web` service owns port 2222.

## Put it behind HTTPS

Keep ports 2222 and 8765 private. A reverse proxy should terminate TLS and
forward browser traffic to the web process and `/mcp` to the MCP process. For
example, with Caddy:

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
| `WEB_PORT` | `2222` | Web server port |
| `MCP_PORT` | `8765` | MCP HTTP port |
| `MCP_HOST` | `127.0.0.1` | MCP bind address; Docker sets `0.0.0.0` |
| `EMCP_API_KEY` | none | MCP key used by the stdio launcher |

## Backups

SQLite's online backup command is safe while the database is in WAL mode:

```sh
sqlite3 /path/to/emcp.db "VACUUM INTO '/path/to/backups/emcp-backup.db'"
```

Copy backups off the host and test restoration. To restore, stop both services,
replace the database file, and restart the services.

## Current operational limits

- Owner setup credentials are printed during bootstrap; there is no email
  delivery or self-service password reset yet.
- Backups, monitoring, TLS, log collection, and rate limiting remain the
  operator's responsibility.
- The current production shape uses separate web and MCP HTTP processes.
- Stable upgrade guarantees begin with the first published release.
