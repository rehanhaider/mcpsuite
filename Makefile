# =============================================================================
# emcp — agent-native CRM (pnpm workspace: apps/web, apps/mcp, packages/*)
# =============================================================================
# Local automation. Run from a mise-activated shell (node 22 + pnpm 10) so
# DB_PATH and the toolchain resolve. Run `make` or `make help` to list targets.
# =============================================================================

.DEFAULT_GOAL := help

# Autostart targets act on these systemd --user services. Override SVC to limit
# to one, e.g. `make autostart SVC=web` or `make autostart-off SVC=mcp`.
SVC ?= web mcp
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
_units := $(SVC:web=emcp-web.service)
_units := $(_units:mcp=emcp-mcp-http.service)

.PHONY: help setup db-setup dev build start mcp mcp-http \
        test typecheck smoke clean deploy \
        autostart autostart-off autostart-status

help: ## Show this help message
	@echo "emcp — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

setup: ## Install dependencies + create the database (run this first)
	@echo ">>> Installing workspace dependencies..."
	pnpm install
	$(MAKE) db-setup

db-setup: ## Create the DB schema when absent + bootstrap workspace/owner (idempotent)
	pnpm -s db:setup

dev: ## Start the web UI dev server (http://localhost:2222)
	pnpm -s dev

build: ## Production build of the web app (apps/web/dist)
	pnpm -s build

start: ## Serve the production web build on :2222 (requires `make build`)
	pnpm -s start

mcp: ## Run the MCP server over stdio (Claude Code; auto-launched via .mcp.json)
	pnpm -s mcp:stdio

mcp-http: ## Run the MCP server over HTTP on :8765 (Claude Desktop / remote agents)
	pnpm -s mcp:http

test: ## Run every package's test suite
	pnpm -s test

typecheck: ## Typecheck every package
	pnpm -s typecheck

smoke: ## Exercise every catalog operation against the live DB (safe, self-cleaning)
	pnpm --filter @emcp/db smoke

deploy: ## Build the web app and restart the systemd services
	$(MAKE) build
	systemctl --user restart $(_units)
	@echo ">>> Deployed.  web -> http://localhost:2222   mcp -> http://localhost:8765/mcp"

clean: ## Remove build artifacts
	rm -rf apps/web/dist
	@echo ">>> Clean completed"

autostart: ## Enable + start web UI & MCP on boot (SVC=web|mcp to limit)
	@mkdir -p "$(SYSTEMD_USER_DIR)"
	@loginctl enable-linger "$$USER" >/dev/null 2>&1 || true
	@for u in $(_units); do \
		echo ">>> installing $$u"; \
		sed "s|@REPO@|$(PWD)|g" ".scripts/systemd/$$u" > "$(SYSTEMD_USER_DIR)/$$u"; \
		chmod 0644 "$(SYSTEMD_USER_DIR)/$$u"; \
	done
	systemctl --user daemon-reload
	systemctl --user enable --now $(_units)
	@echo ">>> Autostart ON ($(SVC)).  web -> http://localhost:2222   mcp -> http://localhost:8765/mcp"

autostart-off: ## Disable + stop web UI & MCP autostart (SVC=web|mcp to limit)
	systemctl --user disable --now $(_units)
	@echo ">>> Autostart OFF ($(SVC)): stopped; will not start on boot."

autostart-status: ## Show enabled/active state of the web UI & MCP services
	@for u in emcp-web.service emcp-mcp-http.service; do \
		printf "  %-22s enabled=%-9s active=%s\n" "$$u" \
			"$$(systemctl --user is-enabled $$u 2>/dev/null || echo absent)" \
			"$$(systemctl --user is-active  $$u 2>/dev/null || echo inactive)"; \
	done

# -----------------------------------------------------------------------------
# Release tarball + machine-wide installer (.scripts/release, .scripts/installer)
# Docs: INSTALL.md
# -----------------------------------------------------------------------------

RELEASE_SCRIPTS := .scripts/release/build-tarball.sh \
                   .scripts/release/payload/emcp-run \
                   .scripts/release/payload/emcp-tsx \
                   .scripts/installer/install.sh \
                   .scripts/installer/launcher.sh \
                   .scripts/installer/emcp

.PHONY: release-tarball release-check

release-tarball: ## Build a self-contained release tarball into dist-release/ (ARCH=x86_64|arm64)
	bash .scripts/release/build-tarball.sh $(if $(ARCH),--arch $(ARCH))

release-check: ## Syntax-check installer + release scripts (shellcheck when available)
	@for f in $(RELEASE_SCRIPTS); do \
		bash -n "$$f" || exit 1; \
		echo "  bash -n OK   $$f"; \
	done
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck $(RELEASE_SCRIPTS) && echo "  shellcheck OK"; \
	else \
		echo "  (shellcheck not installed — skipped)"; \
	fi
