#!/usr/bin/env bash
# launcher.sh — curl | bash shim for the MCP Suite CRM installer.
#
#   curl -fsSL https://raw.githubusercontent.com/rehanhaider/mcpsuite/main/.scripts/installer/launcher.sh | sudo bash
#
# When a script is piped into bash, stdin is the pipe — an installer that
# prompts would read its own script text instead of the keyboard. So this shim
# never runs installer logic itself: it downloads the real installer to a temp
# file, then executes it with the terminal attached (stdin re-pointed at
# /dev/tty when we are being piped). All arguments are passed through, e.g.:
#
#   curl -fsSL .../launcher.sh | sudo bash -s -- --version 0.2.0 --port 8080
set -euo pipefail

REPO="${EMCP_REPO:-rehanhaider/mcpsuite}"
INSTALL_SH_URL="${EMCP_INSTALL_SH_URL:-https://raw.githubusercontent.com/${REPO}/main/.scripts/installer/install.sh}"

tmpdir="$(mktemp -d -t emcp-install.XXXXXX)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT INT TERM

echo "[emcp] downloading installer: $INSTALL_SH_URL"
curl -fsSL --retry 3 -o "$tmpdir/install.sh" "$INSTALL_SH_URL"
chmod 0755 "$tmpdir/install.sh"

if [ -t 0 ]; then
  # stdin is already a terminal (script was downloaded and run normally).
  bash "$tmpdir/install.sh" "$@"
elif (exec < /dev/tty) 2>/dev/null; then
  # Piped (curl | bash) with a controlling terminal: re-attach it so the
  # installer can prompt. (A plain -r test is not enough — opening /dev/tty
  # fails without a controlling terminal even when the node is readable.)
  bash "$tmpdir/install.sh" "$@" < /dev/tty
else
  # No terminal at all (CI). The installer itself stays non-interactive.
  echo "[emcp] no terminal available; running installer non-interactively" >&2
  bash "$tmpdir/install.sh" "$@" < /dev/null
fi
