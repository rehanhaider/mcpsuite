# Connecting agents over MCP

emcp exposes its whole operation catalog (~120 ops) as MCP tools. Every
connection authenticates with an **emcp API key** created in the web UI. The
fastest path is the one the app gives you: **Admin → Agents → New agent client**
shows the key once, with a paste-ready setup snippet for your client that
already has the key filled in. Copy the block, paste it into your client's
config, done — **no shell environment variables required**.

MCP authentication currently uses API keys; there is **no keyless mode**.
Every key is hashed at rest (SHA-256), scoped, and revocable.

Throughout this guide the placeholder `emcp_YOUR_KEY` marks where your real key
goes (the app inlines the actual key for you). The endpoint is
`http://localhost:8765/mcp` on the machine running emcp; substitute the host if
you're connecting from elsewhere.

## Create an API key

Web UI → **Admin → Agents → New agent client**. An agent client belongs to
the user who creates it and **acts on their behalf**: its role is the
creator's *current* role, evaluated on every request, and its scopes are
capped by what that role can grant (members: `read`/`write`/`approvals`;
admins add `admin`). Demoting or disabling the creator instantly downgrades
or kills the key. Choose:

- **Scopes** — what the key may touch: `read`, `write`, `admin` (workspace
  config ops), `approvals` (follow/act on the approval queue; approving
  requires an admin-owned agent, and never the agent's own pending actions).
- **Trust profile** — what happens when the agent calls a risky op
  (`destructive`/`bulk`/`config`/…):
  - `review_risky_actions` (default) — risky ops return `pending_approval`
    and wait in the Approvals page for a human.
  - `trusted_agent` — bulk/data/config run directly; destructive and admin
    ops still queue for approval.
  - `fully_authorized_agent` — everything within the owner's own permissions
    runs directly.

The key (`emcp_…`) is shown **once**; store it in the agent's config. Keys are
hashed at rest, show last-used time, and can be revoked instantly from the same
page. Rotation = create a new client, revoke the old one.

## Connect your client

Pick your client, drop the key into the snippet, and paste it into the config.
Each block below is complete on its own — nothing to export first.

### Claude Code

One command registers this CRM as an HTTP MCP server:

```sh
claude mcp add --transport http emcp-crm http://localhost:8765/mcp \
  --header "Authorization: Bearer emcp_YOUR_KEY"
```

### Cursor

Add to `.cursor/mcp.json` (project) or the global MCP settings:

```json
{
  "mcpServers": {
    "emcp-crm": {
      "url": "http://localhost:8765/mcp",
      "headers": { "Authorization": "Bearer emcp_YOUR_KEY" }
    }
  }
}
```

### Codex (CLI / IDE / desktop app)

Codex CLI, the IDE extension, and the desktop app all share
`~/.codex/config.toml`. Point it at the HTTP endpoint and pass the key as a
static header — Codex sends `http_headers` with every request, so nothing needs
to be in the environment:

```toml
[mcp_servers.emcp-crm]
url = "http://localhost:8765/mcp"
http_headers = { "Authorization" = "Bearer emcp_YOUR_KEY" }
```

> **Codex cloud / ChatGPT-hosted sessions cannot reach localhost.** Those
> sessions run in an isolated container with no route back to your machine, so
> the settings-UI connector toggle saves but the runtime never connects. Custom
> local MCP only works with Codex running **locally** (CLI / IDE / desktop app).
> To use it from a cloud session you'd have to expose `:8765` over a tunnel
> (e.g. tailscale or cloudflared) and point the connector at that URL instead.

### Claude Desktop / other stdio-only clients

Clients that only speak stdio bridge to the HTTP server with `mcp-remote`. Paste
this into the `mcpServers` block of `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "emcp-crm": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8765/mcp",
        "--allow-http",
        "--header",
        "Authorization: Bearer emcp_YOUR_KEY"
      ]
    }
  }
}
```

### Anything else / debugging

Any HTTP client works. List the tools to confirm the key:

```sh
curl -X POST http://localhost:8765/mcp \
  -H "Authorization: Bearer emcp_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## The HTTP server (`:8765`)

Start it with `make mcp-http` (dev), `make autostart` (systemd), or
`docker compose up -d`. Endpoint: `POST http://localhost:8765/mcp` (streamable
HTTP, stateless — no SSE sessions). It binds `127.0.0.1` by default
(`MCP_HOST=0.0.0.0` in Docker). Health check: `GET /healthz`. Every request
must carry `Authorization: Bearer <key>`; a missing/invalid key returns `401`.

## Troubleshooting

"Enabled but no tools show up" — work down this list:

- **Cloud vs local.** Codex cloud / ChatGPT web can't reach localhost (see
  above). Run the client locally, or expose `:8765` over a tunnel.
- **Key actually in the config.** The snippets above put the key directly in the
  client's config file / command. Make sure you replaced `emcp_YOUR_KEY` with
  the real key and that the client reloaded its config.
- **Curl the endpoint** to isolate server vs client — a `200` with a tool list
  means the key and server are fine and the problem is the client's config:

  ```sh
  curl -X POST http://localhost:8765/mcp \
    -H "Authorization: Bearer emcp_YOUR_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

  `401` = missing/invalid key; connection refused = server isn't running on
  `:8765`.
- **Env-var setups only:** if you're using one of the advanced env-var flows
  below, confirm `EMCP_API_KEY` is present in the *shell that launches the
  client* — GUI apps often don't inherit interactive-shell exports.

## What the agent gets

- **Tools**: every catalog op with `mcpExpose` — `company.create` becomes
  `company_create`, etc. Authorization (role floor + scope), zod validation,
  risk gating, and audit logging are identical to the web UI: same catalog,
  same rules.
- **Resources**: `emcp://catalog`, `emcp://pipelines`, `emcp://views`,
  `emcp://approvals/pending`, `emcp://context/{type}/{id}`.
- Rejected approvals carry the human's note back to the agent; pending ones
  execute with the stored input when approved.

## Advanced: env-var setups (developing in this repo)

The key-in-config snippets above are the recommended path. If you're hacking on
emcp itself, the repo also ships env-var-driven wiring that reads the key from
`EMCP_API_KEY` (exported in the shell, or persisted to a gitignored
`data/mcp.env` file as `EMCP_API_KEY=emcp_…`). These keep the key out of your
committed config but require the variable to be present in the environment that
launches the agent.

### Bundled stdio launcher (Claude Code in this repo)

The repo's `.mcp.json` already wires Claude Code — it runs the stdio launcher
and passes the key straight through from the environment:

```json
{
  "mcpServers": {
    "emcp-crm": {
      "command": "bash",
      "args": [".scripts/mcp-stdio.sh"],
      "env": { "EMCP_API_KEY": "${EMCP_API_KEY}" }
    }
  }
}
```

- Export `EMCP_API_KEY` in the shell, or drop it into `data/mcp.env` —
  `.scripts/mcp-stdio.sh` sources that file when the var isn't already set. No
  key → the server prints a clear error and exits non-zero.
- Scopes and trust profile come from the client record, exactly like HTTP.
- The launcher cd's to the repo and runs through mise, so `DB_PATH` always
  points at `data/emcp.db`.

### Codex with an env-var token

Instead of the static `http_headers` above, Codex can read the bearer token
from an environment variable:

```toml
[mcp_servers.emcp-crm]
url = "http://localhost:8765/mcp"
bearer_token_env_var = "EMCP_API_KEY"
```

`EMCP_API_KEY` must be set in the environment that launches Codex. The CLI can
write the entry for you:

```sh
codex mcp add emcp-crm --url http://localhost:8765/mcp \
  --bearer-token-env-var EMCP_API_KEY
# verify: codex mcp list  /  codex mcp get emcp-crm
```

Older Codex versions silently ignore `url` servers unless the RMCP client is
enabled — add `[features] rmcp_client = true` (the legacy name is
`experimental_use_rmcp_client = true`) to `config.toml`.

Codex can also launch the bundled stdio launcher, with the key inline in the
config file (a config paste, not a shell export):

```toml
[mcp_servers.emcp-crm]
command = "bash"
args = ["/path/to/emcp-crm/.scripts/mcp-stdio.sh"]
[mcp_servers.emcp-crm.env]
EMCP_API_KEY = "emcp_YOUR_KEY"
```
