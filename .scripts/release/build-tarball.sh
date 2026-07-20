#!/usr/bin/env bash
# build-tarball.sh — assemble a fully self-contained Linux release tarball.
#
#   dist-release/mcpsuite-crm-<version>-linux-<arch>.tar.gz      (+ .sha256)
#
# The tarball needs NO JavaScript runtime, compiler, npm/pnpm, or source
# checkout on the target machine. It contains:
#   node/                     official Node 22 runtime for the target arch
#                             (downloaded from nodejs.org, SHASUMS256-verified)
#   apps/web/                 built web app (dist/server + dist/client) —
#                             one process serves the UI, POST /mcp, GET /healthz
#   packages/core, packages/db  source for the runtime maintenance scripts
#                             (setup / reset-owner, run via bundled tsx)
#   node_modules/ (+ per-pkg) production dependencies installed with pnpm
#                             (better-sqlite3 is a NATIVE module -> per-arch)
#   bin/emcp-run              production entrypoint (systemd ExecStart)
#   bin/emcp-tsx              maintenance-script runner (bundled node + tsx)
#   installer/                install.sh, launcher.sh, emcp CLI, emcp.service
#   VERSION                   shell-sourceable build metadata
#
# Usage:  .scripts/release/build-tarball.sh [--arch x86_64|arm64] [--skip-build]
# Env:    NODE_VERSION (default pinned below), OUT_DIR (default dist-release),
#         EMCP_BUILD_DIR (staging dir override; default mktemp -d)
#
# Cross-arch note: better-sqlite3 (and tsx's esbuild) ship native binaries, so
# a release for another CPU needs that CPU's node_modules. Building for an
# arch other than the build host is therefore NOT supported yet (see TODO
# printed on mismatch) — build arm64 releases on an arm64 host.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.21.1}"
REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-release}"
CACHE_DIR="$OUT_DIR/.cache"

log()  { printf '\033[36m[build]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments
host_arch_raw="$(uname -m)"
case "$host_arch_raw" in
  x86_64)          HOST_ARCH="x86_64" ;;
  aarch64 | arm64) HOST_ARCH="arm64" ;;
  *) die "unsupported build host architecture: $host_arch_raw (x86_64/arm64 only)" ;;
esac

TARGET_ARCH="$HOST_ARCH"
SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      [[ $# -ge 2 ]] || die "--arch needs a value (x86_64|arm64)"
      TARGET_ARCH="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$TARGET_ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  arm64)  NODE_ARCH="arm64" ;;
  *) die "unsupported --arch: $TARGET_ARCH (x86_64|arm64)" ;;
esac

if [[ "$TARGET_ARCH" != "$HOST_ARCH" ]]; then
  cat >&2 <<EOF
[build] ERROR: cross-architecture build requested ($HOST_ARCH host -> $TARGET_ARCH target).

  better-sqlite3 is a native Node module (and tsx pulls in esbuild's native
  binary), so the release payload's node_modules must be installed on a
  $TARGET_ARCH machine. Shipping the host's binaries would produce a tarball
  that crashes at startup on $TARGET_ARCH, so this script refuses.

  TODO(release): support cross-arch assembly, e.g. by
    - running this script on a $TARGET_ARCH host / CI runner (works today), or
    - a QEMU/binfmt container (linux/$TARGET_ARCH) running this same script, or
    - teaching the staging install to fetch prebuilt $TARGET_ARCH binaries
      (npm_config_arch + esbuild @esbuild/linux-$NODE_ARCH) with script
      execution disabled — needs validation before shipping.

  Until then: build arm64 releases on arm64 (e.g. a Graviton or Pi 5 runner).
EOF
  exit 2
fi

# ---------------------------------------------------------------- prechecks
for tool in pnpm curl tar sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool (run under 'mise exec --')"
done

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO_ROOT/package.json")"
[[ -n "$VERSION" ]] || die "could not read version from package.json"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
NAME="mcpsuite-crm-${VERSION}-linux-${TARGET_ARCH}"

log "version $VERSION ($GIT_SHA), target linux/$TARGET_ARCH, node v$NODE_VERSION"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

# ---------------------------------------------------------------- 1. build web
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  log "skipping web build (--skip-build)"
else
  log "building web app (pnpm --filter @emcp/web build)"
  (cd "$REPO_ROOT" && pnpm --filter @emcp/web build)
fi
[[ -f "$REPO_ROOT/apps/web/dist/server/server.js" ]] || die "apps/web/dist/server/server.js missing — build failed?"
[[ -d "$REPO_ROOT/apps/web/dist/client" ]] || die "apps/web/dist/client missing — build failed?"

# ------------------------------------------------- 2. fetch + verify Node 22
NODE_TAR="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

if [[ ! -f "$CACHE_DIR/$NODE_TAR" ]]; then
  log "downloading $NODE_URL"
  curl -fsSL --retry 3 -o "$CACHE_DIR/$NODE_TAR.part" "$NODE_URL"
  mv "$CACHE_DIR/$NODE_TAR.part" "$CACHE_DIR/$NODE_TAR"
else
  log "using cached $NODE_TAR"
fi
log "verifying Node runtime against published SHASUMS256.txt"
curl -fsSL --retry 3 -o "$CACHE_DIR/SHASUMS256-v${NODE_VERSION}.txt" "$SHASUMS_URL"
(
  cd "$CACHE_DIR"
  grep " ${NODE_TAR}\$" "SHASUMS256-v${NODE_VERSION}.txt" | sha256sum -c - >/dev/null
) || die "SHA256 verification of $NODE_TAR FAILED"
log "node runtime checksum OK"

# ---------------------------------------------------------------- 3. staging
if [[ -n "${EMCP_BUILD_DIR:-}" ]]; then
  STAGE="$EMCP_BUILD_DIR/stage"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
else
  STAGE="$(mktemp -d -t emcp-release.XXXXXX)"
  trap 'rm -rf "$STAGE"' EXIT
fi
log "staging in $STAGE"

# Workspace skeleton: enough for `pnpm install --prod --frozen-lockfile`.
# packages/hosting-control ships as a package.json-only skeleton so the
# lockfile importer set matches; the filtered install below never materialises
# its node_modules. apps/mcp ships with src: the ONE web process serves /mcp
# and depends on @emcp/mcp (workspace TS source).
mkdir -p "$STAGE/apps/web" "$STAGE/apps/mcp" \
  "$STAGE/packages/core" "$STAGE/packages/db" "$STAGE/packages/hosting-control" \
  "$STAGE/bin"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-workspace.yaml" "$REPO_ROOT/pnpm-lock.yaml" "$STAGE/"
cp "$REPO_ROOT/LICENSE" "$STAGE/" 2>/dev/null || true
cp "$REPO_ROOT/apps/web/package.json" "$STAGE/apps/web/"
cp "$REPO_ROOT/apps/mcp/package.json" "$STAGE/apps/mcp/"
cp "$REPO_ROOT/packages/hosting-control/package.json" "$STAGE/packages/hosting-control/"
cp "$REPO_ROOT/packages/core/package.json" "$STAGE/packages/core/"
cp "$REPO_ROOT/packages/db/package.json" "$STAGE/packages/db/"
cp -R "$REPO_ROOT/packages/core/src" "$STAGE/packages/core/src"
cp -R "$REPO_ROOT/packages/db/src" "$STAGE/packages/db/src"
cp -R "$REPO_ROOT/apps/mcp/src" "$STAGE/apps/mcp/src"
cp -R "$REPO_ROOT/apps/web/dist" "$STAGE/apps/web/dist"

# ------------------------------------- 4. production node_modules (per-arch)
log "installing production dependencies (pnpm install --prod, web+db subtree)"
(
  cd "$STAGE"
  CI=1 pnpm install --prod --frozen-lockfile \
    --filter "@emcp/web..." --filter "@emcp/db..." \
    >/dev/null
)
[[ -e "$STAGE/apps/web/node_modules/srvx" ]] || die "srvx missing from staged node_modules"
[[ -e "$STAGE/packages/db/node_modules/better-sqlite3" ]] || die "better-sqlite3 missing from staged node_modules"
[[ -f "$STAGE/packages/db/node_modules/tsx/dist/cli.mjs" ]] || die "tsx missing from staged node_modules"

# ---------------------------------------------------------------- 5. runtime
log "unpacking bundled Node runtime"
mkdir -p "$STAGE/node"
tar -xJf "$CACHE_DIR/$NODE_TAR" -C "$STAGE/node" --strip-components=1
[[ -x "$STAGE/node/bin/node" ]] || die "bundled node binary missing after unpack"

# Slim the runtime: the target machine only ever runs `node` — npm/corepack,
# C headers, and docs are ~150MB of dead weight in every release.
rm -rf "$STAGE/node/lib/node_modules" "$STAGE/node/include" "$STAGE/node/share"
rm -f "$STAGE/node/bin/npm" "$STAGE/node/bin/npx" "$STAGE/node/bin/corepack" \
  "$STAGE/node/README.md" "$STAGE/node/CHANGELOG.md"

if [[ "$TARGET_ARCH" == "$HOST_ARCH" ]]; then
  log "smoke-testing bundled node + native better-sqlite3"
  (cd "$STAGE/packages/db" && "$STAGE/node/bin/node" -e '
    const v = process.version;
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES (?)").run(1);
    if (db.prepare("SELECT count(*) c FROM t").get().c !== 1) process.exit(1);
    db.close();
    console.log(`[build]   bundled ${v} + better-sqlite3: OK`);
  ')
fi

# ------------------------------------------------------- 6. wrappers + meta
cp "$REPO_ROOT/.scripts/release/payload/emcp-run" "$STAGE/bin/emcp-run"
cp "$REPO_ROOT/.scripts/release/payload/emcp-tsx" "$STAGE/bin/emcp-tsx"
chmod 0755 "$STAGE/bin/emcp-run" "$STAGE/bin/emcp-tsx"

mkdir -p "$STAGE/installer"
cp "$REPO_ROOT/.scripts/installer/install.sh" \
   "$REPO_ROOT/.scripts/installer/launcher.sh" \
   "$REPO_ROOT/.scripts/installer/emcp" \
   "$REPO_ROOT/.scripts/installer/emcp.service" \
   "$STAGE/installer/"
chmod 0755 "$STAGE/installer/install.sh" "$STAGE/installer/launcher.sh" "$STAGE/installer/emcp"

cat > "$STAGE/VERSION" <<EOF
EMCP_VERSION=$VERSION
EMCP_ARCH=$TARGET_ARCH
EMCP_NODE=v$NODE_VERSION
EMCP_GIT=$GIT_SHA
EMCP_BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# ---------------------------------------------------------------- 7. package
log "packing $NAME.tar.gz"
tar -C "$STAGE" -czf "$OUT_DIR/$NAME.tar.gz.part" .
mv "$OUT_DIR/$NAME.tar.gz.part" "$OUT_DIR/$NAME.tar.gz"
(
  cd "$OUT_DIR"
  sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
  # Aggregate checksums file for the GitHub release page.
  sha256sum -- *.tar.gz > checksums.txt
)

size="$(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1)"
log "done: $OUT_DIR/$NAME.tar.gz ($size)"
log "      $OUT_DIR/$NAME.tar.gz.sha256"
log "release assets to upload: $NAME.tar.gz, $NAME.tar.gz.sha256 (and/or checksums.txt)"
