# Security Policy

MCP Suite CRM is self-hosted software that stores your sales data locally and
exposes it to AI agents over MCP. Security reports are taken seriously.

## Reporting a vulnerability

- **Do not open a public issue for exploitable vulnerabilities.**
- Report privately via GitHub Security Advisories ("Report a vulnerability")
  on the repository once it is published, or contact the maintainer directly.
- Include: affected version/commit, reproduction steps, impact assessment,
  and any suggested fix.
- You should get an acknowledgement within 7 days. Coordinated disclosure is
  preferred; credit is given unless you ask otherwise.

## Supported versions

Pre-1.0, only the latest `0.x` release receives security fixes. There is no
backporting during the `0.x` phase.

## Threat model notes for self-hosters

- The web app and MCP HTTP server bind to localhost by default and are meant
  for a single trusted machine or a private network. **Do not expose either
  port to the public internet without a TLS reverse proxy.** Every MCP request
  — HTTP and stdio alike — must carry an emcp API key (`Authorization: Bearer
  <key>` for HTTP, `EMCP_API_KEY` for stdio); there is no anonymous mode.
- MCP API keys are hashed at rest; the plaintext key is shown once at
  creation. Treat keys like passwords and scope them minimally (`read` <
  `write` < `approvals`/`admin`), with conservative trust profiles.
- Risky operations (hard deletes, bulk writes, imports, backups) route
  through the pending-approval gate for agent actors — weakening trust
  profiles or approving blindly defeats that layer.
- The SQLite database (`data/emcp.db`) and its backups (`data/backups/`)
  contain all CRM data unencrypted; protect them with filesystem permissions
  and disk encryption appropriate to your environment.
- Sessions are HttpOnly cookies (30-day expiry); password hashing is scrypt.
