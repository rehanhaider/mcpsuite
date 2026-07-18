#!/bin/sh
# Container entrypoint: migrate the database, then supervise the two
# long-running processes (web UI + MCP HTTP server). SIGTERM/SIGINT are
# forwarded so `docker stop` shuts both down cleanly. POSIX sh (dash).
set -eu

: "${DB_PATH:=/data/emcp.db}"
: "${WEB_PORT:=2222}"
: "${MCP_PORT:=8765}"
export DB_PATH MCP_PORT

mkdir -p "$(dirname "$DB_PATH")"

# pnpm keeps bins per-package; resolve them explicitly.
TSX_DB=packages/db/node_modules/.bin/tsx
TSX_MCP=apps/mcp/node_modules/.bin/tsx

echo ">>> emcp: migrating database at $DB_PATH"
"$TSX_DB" packages/db/src/scripts/migrate.ts

echo ">>> emcp: starting MCP server on :$MCP_PORT"
"$TSX_MCP" apps/mcp/src/http.ts &
mcp_pid=$!

echo ">>> emcp: starting web UI on :$WEB_PORT"
(cd apps/web && exec node_modules/.bin/srvx serve --prod --dir . \
  --entry dist/server/server.js --static dist/client --port "$WEB_PORT") &
web_pid=$!

stopping=0
shutdown() {
  stopping=1
  kill -TERM "$web_pid" "$mcp_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# POSIX-portable supervision: if either process exits, stop the other and
# leave; the orchestrator's restart policy takes it from there.
while kill -0 "$web_pid" 2>/dev/null && kill -0 "$mcp_pid" 2>/dev/null; do
  sleep 2 &
  wait $! || true
  [ "$stopping" = 1 ] && break
done

shutdown
wait "$web_pid" 2>/dev/null || true
wait "$mcp_pid" 2>/dev/null || true

if [ "$stopping" = 1 ]; then
  echo ">>> emcp: stopped"
  exit 0
fi
echo ">>> emcp: a service exited unexpectedly" >&2
exit 1
