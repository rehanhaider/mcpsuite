#!/usr/bin/env bash
# Launcher for the emcp-crm MCP stdio server.
# Used by Claude Code (.mcp.json) and the Claude Desktop app (via wsl.exe).
# cd's to the repo root regardless of where it is invoked from, and uses mise's
# absolute path so it does not depend on a login shell having mise on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
# The stdio server authenticates with EMCP_API_KEY (create a key in Admin ->
# Agents). If it isn't already in the environment, source it from an optional
# gitignored data/mcp.env (format: EMCP_API_KEY=...). Proceeding without it is
# fine — the server itself prints a clear error and exits non-zero.
if [ -z "${EMCP_API_KEY:-}" ] && [ -f data/mcp.env ]; then
  set -a
  # shellcheck disable=SC1091
  . data/mcp.env
  set +a
fi
exec /home/rehan/.local/bin/mise exec -- pnpm -s mcp:stdio
