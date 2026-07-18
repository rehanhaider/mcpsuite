#!/usr/bin/env bash
# Launcher for the emcp web app (TanStack Start, production build via srvx).
# Runs as an always-on systemd user service; reachable from Windows over WSL's
# localhost forwarding at http://localhost:2222.
# Builds on first run if the production bundle is missing. Uses mise's absolute
# path so it does not depend on a login shell having mise on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f apps/web/dist/server/server.js ]; then
  echo "[emcp-web] no production build found — building..."
  /home/rehan/.local/bin/mise exec -- pnpm -s build
fi
exec /home/rehan/.local/bin/mise exec -- pnpm -s start
