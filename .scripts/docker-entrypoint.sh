#!/bin/sh
# Container entrypoint.
#
# Default (no args): set up the database (first run against an empty volume
# creates the schema and prints the one-time owner setup code), then exec the
# single product process — web UI + operation API + POST /mcp + GET /healthz,
# all on WEB_PORT. `exec` makes the server PID 1, so `docker stop` reaches it
# directly.
#
# With args: exec them instead, skipping database setup — that is how scaled
# deployments run auxiliary entries from this same image, e.g. the standalone
# MCP HTTP process (compose: `command: pnpm mcp:http`; it listens on
# MCP_PORT and serves its own GET /healthz). Database setup stays the default
# (web) service's job so the setup code prints exactly once.
# POSIX sh (dash).
set -eu

: "${DB_PATH:=/data/emcp.db}"
: "${WEB_PORT:=2222}"
export DB_PATH

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

mkdir -p "$(dirname "$DB_PATH")"

# pnpm keeps bins per-package; resolve them explicitly.
echo ">>> emcp: setting up database at $DB_PATH"
packages/db/node_modules/.bin/tsx packages/db/src/scripts/setup.ts

echo ">>> emcp: starting web + MCP on :$WEB_PORT"
cd apps/web
exec node_modules/.bin/srvx serve --prod --dir . \
  --entry dist/server/server.js --static dist/client --port "$WEB_PORT"
