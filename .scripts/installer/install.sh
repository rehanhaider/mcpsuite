#!/usr/bin/env bash
# install.sh — machine-wide installer for MCP Suite CRM (Linux + systemd).
#
# Layout it creates:
#   /opt/emcp/releases/<version>   self-contained release (bundled Node 22)
#   /opt/emcp/current              symlink to the active release
#   /etc/emcp/emcp.env             configuration (preserved on reinstall)
#   /var/lib/emcp                  mutable data: emcp.db + backups/ (user emcp)
#   /usr/local/bin/emcp            admin CLI
#   /etc/systemd/system/emcp.service
#
# Usage (as root):
#   install.sh --tarball /path/to/mcpsuite-crm-<v>-linux-<arch>.tar.gz
#   install.sh [--version 0.2.0]       # download from GitHub Releases
#   install.sh --port 8080 --base-url https://crm.example.com
#
# Options:
#   --tarball PATH   install from a local release tarball
#   --version X      pin a release version (default: latest GitHub release)
#   --port N         WEB_PORT written to a NEW /etc/emcp/emcp.env (default 2222)
#   --base-url URL   EMCP_BASE_URL written to a NEW env file (default http://localhost:PORT)
#
# Secrets: this script never asks for, reads, or logs credentials. First run
# creates a pending owner; the one-time setup code printed by database setup
# is surfaced exactly once on your terminal and stored nowhere else.
#
# Testing: set EMCP_INSTALL_ROOT=/some/dir to install into that prefix without
# root, users, or systemd (layout + files only; used by the repo's dry-run).
set -euo pipefail

REPO="${EMCP_REPO:-rehanhaider/mcpsuite}"
PREFIX="${EMCP_INSTALL_ROOT:-}"
TEST_MODE=0
[[ -n "$PREFIX" ]] && TEST_MODE=1

OPT_DIR="$PREFIX/opt/emcp"
ETC_DIR="$PREFIX/etc/emcp"
ENV_FILE="$ETC_DIR/emcp.env"
VAR_DIR="$PREFIX/var/lib/emcp"
BIN_DIR="$PREFIX/usr/local/bin"
UNIT_DIR="$PREFIX/etc/systemd/system"
SERVICE="emcp"

log()  { printf '\033[36m[emcp-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[emcp-install] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[emcp-install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments
TARBALL=""
WANT_VERSION=""
PORT=""
BASE_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)  [[ $# -ge 2 ]] || die "--tarball needs a path";   TARBALL="$2"; shift 2 ;;
    --version)  [[ $# -ge 2 ]] || die "--version needs a value";  WANT_VERSION="${2#v}"; shift 2 ;;
    --port)     [[ $# -ge 2 ]] || die "--port needs a value";     PORT="$2"; shift 2 ;;
    --base-url) [[ $# -ge 2 ]] || die "--base-url needs a value"; BASE_URL="$2"; shift 2 ;;
    -h | --help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -z "$PORT" || "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"

# ---------------------------------------------------------------- prechecks
[[ "$(uname -s)" == "Linux" ]] || die "Linux only (found $(uname -s))"

case "$(uname -m)" in
  x86_64)          ARCH="x86_64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) die "unsupported CPU: $(uname -m). Supported: x86_64, arm64 (64-bit only — on Raspberry Pi use a 64-bit OS)" ;;
esac

if [[ "$TEST_MODE" -eq 0 ]]; then
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root (use sudo)"
  [[ -d /run/systemd/system ]] || die "systemd is required (no /run/systemd/system)"
fi

libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
if [[ "$libc" =~ ^glibc[[:space:]]+([0-9.]+) ]]; then
  glibc_ver="${BASH_REMATCH[1]}"
  min_glibc="2.28"
  lowest="$(printf '%s\n%s\n' "$min_glibc" "$glibc_ver" | sort -V | head -1)"
  [[ "$lowest" == "$min_glibc" ]] || die "glibc >= $min_glibc required (found $glibc_ver)"
else
  if ldd --version 2>&1 | head -1 | grep -qi musl; then
    die "musl-based systems (e.g. Alpine) are not supported — glibc >= 2.28 required"
  fi
  warn "could not determine glibc version; continuing (need glibc >= 2.28)"
fi

kernel="$(uname -r | grep -oE '^[0-9]+\.[0-9]+' || true)"
if [[ -n "$kernel" ]]; then
  min_kernel="4.18"
  lowest="$(printf '%s\n%s\n' "$min_kernel" "$kernel" | sort -V | head -1)"
  [[ "$lowest" == "$min_kernel" ]] || die "kernel >= $min_kernel required (found $(uname -r))"
fi

for tool in tar gzip; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
if [[ -z "$TARBALL" ]]; then
  command -v curl >/dev/null 2>&1 || die "curl is required to download releases"
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required to verify releases"
fi

# ------------------------------------------------------------ obtain release
WORK="$(mktemp -d -t emcp-install.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

if [[ -z "$TARBALL" ]]; then
  if [[ -z "$WANT_VERSION" ]]; then
    log "resolving latest release of $REPO"
    tag="$(curl -fsSL --retry 3 "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[^"]*"([^"]+)".*/\1/')" \
      || die "could not query GitHub releases for $REPO"
    [[ -n "$tag" ]] || die "no releases found for $REPO"
    WANT_VERSION="${tag#v}"
  fi
  name="mcpsuite-crm-${WANT_VERSION}-linux-${ARCH}.tar.gz"
  base="https://github.com/$REPO/releases/download/v${WANT_VERSION}"
  log "downloading $base/$name"
  curl -fsSL --retry 3 -o "$WORK/$name" "$base/$name" \
    || die "download failed: $base/$name"
  curl -fsSL --retry 3 -o "$WORK/$name.sha256" "$base/$name.sha256" \
    || die "download failed: $base/$name.sha256 (release must ship a checksum)"
  log "verifying sha256"
  (cd "$WORK" && sha256sum -c "$name.sha256" >/dev/null) || die "sha256 verification FAILED for $name"
  TARBALL="$WORK/$name"
  log "checksum OK"
else
  [[ -f "$TARBALL" ]] || die "tarball not found: $TARBALL"
  # Verify against a sibling .sha256 when present (build-tarball.sh emits one).
  if [[ -f "$TARBALL.sha256" ]] && command -v sha256sum >/dev/null 2>&1; then
    log "verifying sha256 ($TARBALL.sha256)"
    (cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256" >/dev/null) \
      || die "sha256 verification FAILED for $TARBALL"
    log "checksum OK"
  else
    warn "no $TARBALL.sha256 found next to the tarball — skipping checksum verification"
  fi
fi

# ------------------------------------------------------------------ extract
log "extracting release"
mkdir -p "$WORK/release"
tar -xzf "$TARBALL" -C "$WORK/release"
[[ -f "$WORK/release/VERSION" ]] || die "invalid release: VERSION file missing"
# shellcheck disable=SC1091
VERSION="$(. "$WORK/release/VERSION" && echo "${EMCP_VERSION:-}")"
REL_ARCH="$(. "$WORK/release/VERSION" && echo "${EMCP_ARCH:-}")"
[[ -n "$VERSION" ]] || die "invalid release: EMCP_VERSION missing from VERSION"
[[ "$REL_ARCH" == "$ARCH" ]] || die "release is for $REL_ARCH but this machine is $ARCH"
[[ -x "$WORK/release/bin/emcp-run" && -x "$WORK/release/node/bin/node" ]] \
  || die "invalid release: bin/emcp-run or bundled node missing"
log "release: mcpsuite-crm $VERSION (linux/$ARCH)"

# ------------------------------------------------------------- user + dirs
if [[ "$TEST_MODE" -eq 0 ]]; then
  if ! id -u "$SERVICE" >/dev/null 2>&1; then
    log "creating system user '$SERVICE'"
    nologin="/usr/sbin/nologin"; [[ -x "$nologin" ]] || nologin="/sbin/nologin"; [[ -x "$nologin" ]] || nologin="/bin/false"
    useradd --system --user-group --home-dir /var/lib/emcp --no-create-home --shell "$nologin" "$SERVICE"
  fi
fi

install -d -m 0755 "$OPT_DIR" "$OPT_DIR/releases" "$ETC_DIR" "$BIN_DIR" "$UNIT_DIR"
install -d -m 0750 "$VAR_DIR" "$VAR_DIR/backups"
if [[ "$TEST_MODE" -eq 0 ]]; then
  chown "$SERVICE:$SERVICE" "$VAR_DIR" "$VAR_DIR/backups"
fi

# ------------------------------------------------------------ place release
REL_DIR="$OPT_DIR/releases/$VERSION"
if [[ -e "$REL_DIR" ]]; then
  warn "release $VERSION already installed — replacing it"
  if [[ "$TEST_MODE" -eq 0 ]] && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    log "stopping running $SERVICE service"
    systemctl stop "$SERVICE"
  fi
  rm -rf "$REL_DIR"
fi
mv "$WORK/release" "$REL_DIR"

# Atomic-ish symlink swap: create then rename over.
ln -s "releases/$VERSION" "$OPT_DIR/.current.tmp.$$"
mv -T "$OPT_DIR/.current.tmp.$$" "$OPT_DIR/current"
log "installed to $REL_DIR (current -> releases/$VERSION)"

# ------------------------------------------------------------------- config
if [[ -f "$ENV_FILE" ]]; then
  log "keeping existing $ENV_FILE"
  [[ -n "$PORT" || -n "$BASE_URL" ]] && warn "--port/--base-url ignored: $ENV_FILE already exists (edit it instead)"
else
  port="${PORT:-2222}"
  base_url="${BASE_URL:-http://localhost:$port}"
  log "writing $ENV_FILE (WEB_PORT=$port)"
  cat > "$ENV_FILE" <<EOF
# emcp configuration — read by systemd (EnvironmentFile=) and the emcp CLI.
# After editing: sudo systemctl restart emcp
WEB_PORT=$port
EMCP_BASE_URL=$base_url
DB_PATH=/var/lib/emcp/emcp.db
EOF
  chmod 0640 "$ENV_FILE"
  [[ "$TEST_MODE" -eq 0 ]] && chown "root:$SERVICE" "$ENV_FILE"
fi
# shellcheck disable=SC1090
WEB_PORT="$(. "$ENV_FILE" && echo "${WEB_PORT:-2222}")"
# shellcheck disable=SC1090
EMCP_BASE_URL="$(. "$ENV_FILE" && echo "${EMCP_BASE_URL:-http://localhost:$WEB_PORT}")"
# shellcheck disable=SC1090
DB_PATH="$(. "$ENV_FILE" && echo "${DB_PATH:-/var/lib/emcp/emcp.db}")"
[[ "$TEST_MODE" -eq 1 && "$DB_PATH" == /var/lib/emcp/* ]] && DB_PATH="$PREFIX$DB_PATH"

# ------------------------------------------------------------- CLI + unit
install -m 0755 "$REL_DIR/installer/emcp" "$BIN_DIR/emcp"
install -m 0644 "$REL_DIR/installer/emcp.service" "$UNIT_DIR/$SERVICE.service"
log "installed CLI ($BIN_DIR/emcp) and unit ($UNIT_DIR/$SERVICE.service)"

# ------------------------------------------------- db setup (first-run setup)
# Runs as the unprivileged service user with the release's bundled runtime.
# Its stdout may contain the ONE-TIME owner setup code: capture to memory and
# print exactly once below — never into a file or log.
log "setting up the database (as user $SERVICE)"
setup_cmd=("$OPT_DIR/current/bin/emcp-tsx" "packages/db/src/scripts/setup.ts")
if [[ "$TEST_MODE" -eq 0 ]]; then
  setup_out="$(runuser -u "$SERVICE" -- env \
    HOME=/var/lib/emcp DB_PATH="$DB_PATH" EMCP_BASE_URL="$EMCP_BASE_URL" \
    "${setup_cmd[@]}" 2>&1)" || die "database setup failed:
$setup_out"
else
  setup_out="$(env HOME="$VAR_DIR" DB_PATH="$DB_PATH" EMCP_BASE_URL="$EMCP_BASE_URL" \
    "${setup_cmd[@]}" 2>&1)" || die "database setup failed:
$setup_out"
fi

# ------------------------------------------------------------ enable + start
HEALTH_NOTE=""
if [[ "$TEST_MODE" -eq 0 ]]; then
  log "enabling and starting $SERVICE.service"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE" >/dev/null 2>&1 || systemctl enable --now "$SERVICE"
  log "waiting for http://127.0.0.1:$WEB_PORT/healthz"
  healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/healthz" 2>/dev/null; then healthy=1; break; fi
    sleep 1
  done
  if [[ "$healthy" -eq 1 ]]; then
    HEALTH_NOTE="service is up (GET /healthz -> 200)"
  else
    HEALTH_NOTE="service did NOT answer /healthz within 30s — check: journalctl -u $SERVICE -n 50"
    warn "$HEALTH_NOTE"
  fi
else
  log "[test mode] skipping systemd enable/start and health check"
  HEALTH_NOTE="test mode: service not started"
fi

# ------------------------------------------------------------------ summary
cat <<EOF

==============================================================
 MCP Suite CRM $VERSION installed
==============================================================
  URL        : $EMCP_BASE_URL
  Service    : $SERVICE.service ($HEALTH_NOTE)
  Config     : $ENV_FILE
  Data       : $VAR_DIR (SQLite: $DB_PATH)
  CLI        : emcp status | logs | update | setup-code | uninstall

--- first-run owner setup (shown once, stored nowhere) -------
$setup_out
--------------------------------------------------------------
If a one-time setup code is shown above, open the printed URL
and use it now. Lost it? Run: sudo emcp setup-code
==============================================================
EOF
