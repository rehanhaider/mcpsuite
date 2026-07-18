#!/usr/bin/env bash
# Launcher for the emcp-crm MCP HTTP (Streamable HTTP) server.
# Runs as an always-on systemd user service; the Claude Desktop app connects to
# it over WSL's localhost forwarding (http://localhost:8765/mcp).
# Uses mise's absolute path so it does not need a login shell.
set -euo pipefail
cd "$(dirname "$0")/.."
exec /home/rehan/.local/bin/mise exec -- pnpm -s mcp:http
