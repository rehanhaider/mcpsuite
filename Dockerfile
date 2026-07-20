# =============================================================================
# MCP Suite CRM — one container, ONE process: the web application serves the
# browser UI, the operation API, POST /mcp for agents, and GET /healthz, all
# on :2222 (WEB_PORT). SQLite state lives entirely in the /data volume.
#
#   docker build -t mcpsuite/crm .
#   docker run -d -p 2222:2222 -v emcp-data:/data mcpsuite/crm
#
# Scaled deployments can run a SEPARATE stateless MCP HTTP process from this
# same image with a command override (it listens on MCP_PORT=8765 and serves
# its own GET /healthz; database setup stays the web service's job):
#
#   docker run -d -p 8765:8765 -v emcp-data:/data mcpsuite/crm pnpm mcp:http
#   # compose:  command: pnpm mcp:http    (+ override the healthcheck to
#   #           probe http://127.0.0.1:8765/healthz)
# =============================================================================

FROM node:22-bookworm-slim AS base
# COREPACK_HOME: one shared, world-readable cache so the pnpm version pinned
# by package.json#packageManager is baked into the runtime image — containers
# must never download pnpm on start (`pnpm mcp:http` override included).
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/pnpm/.corepack \
    CI=true
RUN corepack enable pnpm

# ---- build-base: toolchain for native modules -------------------------------
# better-sqlite3 normally installs a prebuilt binding, but when that download
# fails (offline builds, GitHub rate limits) pnpm falls back to node-gyp,
# which needs python3/make/g++ — absent from the slim image. Install stages
# get the toolchain; the runtime stage stays slim.
FROM base AS build-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- build: full install (dev deps included), build the web app -------------
FROM build-base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @emcp/web build

# ---- prod-deps: clean install of runtime dependencies only ------------------
FROM build-base AS prod-deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/hosting-control/package.json ./packages/hosting-control/
COPY apps/web/package.json ./apps/web/
COPY apps/mcp/package.json ./apps/mcp/
RUN pnpm install --frozen-lockfile --prod

# ---- runtime -----------------------------------------------------------------
FROM base AS runtime
LABEL org.opencontainers.image.title="MCP Suite CRM" \
      org.opencontainers.image.description="Agent-native open-source CRM (web UI + MCP server)" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/rehanhaider/mcpsuite"

# MCP_PORT/MCP_HOST only matter to the `pnpm mcp:http` command override.
# MCP_HOST=0.0.0.0: on a laptop the standalone MCP server deliberately binds
# loopback, but in a container it must listen on the bridge interface or the
# published port (-p 8765:8765) would connect to nothing. Auth still applies
# (see apps/mcp/src/http.ts) — don't publish any port to the internet without
# a reverse proxy + agent API keys.
ENV NODE_ENV=production \
    DB_PATH=/data/emcp.db \
    WEB_PORT=2222 \
    MCP_PORT=8765 \
    MCP_HOST=0.0.0.0

WORKDIR /repo

# Workspace layout with production node_modules…
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /repo/packages/hosting-control/node_modules ./packages/hosting-control/node_modules
COPY --from=prod-deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /repo/apps/mcp/node_modules ./apps/mcp/node_modules
# …source for the tsx-run processes (mcp, db setup) and package manifests…
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
# Bake the pinned pnpm (package.json#packageManager) into the corepack cache.
# Retried once: this fetches from the npm registry and a transient network
# failure here should not fail an otherwise fully-cached build.
RUN corepack install || corepack install
COPY packages/core ./packages/core
COPY packages/db ./packages/db
# hosting-control runs ONLY under an explicit command override (hosted
# deployments: `pnpm --filter @emcp/hosting-control start`); it binds
# 127.0.0.1 unless HC_HOST is set and is never started by the entrypoint.
COPY packages/hosting-control ./packages/hosting-control
COPY apps/mcp ./apps/mcp
COPY apps/web/package.json ./apps/web/package.json
# …and the built web app (server bundle + static client assets).
COPY --from=build /repo/apps/web/dist ./apps/web/dist

COPY .scripts/docker-entrypoint.sh /usr/local/bin/emcp-entrypoint
RUN chmod +x /usr/local/bin/emcp-entrypoint \
    && mkdir -p /data \
    && chown -R node:node /data /repo /pnpm

USER node
VOLUME /data
# 2222 = the product (web + API + /mcp + /healthz); 8765 only serves under
# the `pnpm mcp:http` command override.
EXPOSE 2222 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||2222)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["emcp-entrypoint"]
