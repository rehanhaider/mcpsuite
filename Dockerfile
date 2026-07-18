# =============================================================================
# emcp — single-container image: web UI (:2222) + MCP server (:8765) + SQLite.
#
#   docker build -t emcp .
#   docker run -d -p 2222:2222 -p 8765:8765 -v emcp-data:/data emcp
#
# State lives entirely in the /data volume (one SQLite file, WAL mode).
# =============================================================================

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable pnpm

# ---- build: full install (dev deps included), build the web app -------------
FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @emcp/web build

# ---- prod-deps: clean install of runtime dependencies only ------------------
FROM base AS prod-deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY apps/web/package.json ./apps/web/
COPY apps/mcp/package.json ./apps/mcp/
RUN pnpm install --frozen-lockfile --prod

# ---- runtime -----------------------------------------------------------------
FROM base AS runtime
LABEL org.opencontainers.image.title="MCP Suite CRM" \
      org.opencontainers.image.description="Agent-native open-source CRM (web UI + MCP server)" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/rehanhaider/mcpsuite"

# MCP_HOST=0.0.0.0: on a laptop the MCP server deliberately binds loopback,
# but in a container it must listen on the bridge interface or the published
# port (-p 8765:8765) would connect to nothing. Auth still applies (see
# apps/mcp/src/http.ts) — don't publish the port to the internet without a
# reverse proxy + agent API keys.
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
COPY --from=prod-deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /repo/apps/mcp/node_modules ./apps/mcp/node_modules
# …source for the tsx-run processes (mcp, migrations) and package manifests…
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY apps/mcp ./apps/mcp
COPY apps/web/package.json ./apps/web/package.json
# …and the built web app (server bundle + static client assets).
COPY --from=build /repo/apps/web/dist ./apps/web/dist

COPY .scripts/docker-entrypoint.sh /usr/local/bin/emcp-entrypoint
RUN chmod +x /usr/local/bin/emcp-entrypoint \
    && mkdir -p /data \
    && chown -R node:node /data /repo

USER node
VOLUME /data
EXPOSE 2222 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||2222)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["emcp-entrypoint"]
