# --- flexcalendar ------------------------------------------------------------------
#
# One entry point for the monorepo (D-09). Today it owns the local stack of
# E02-R03 and the verification gates of E02-R04. Component epics register
# their checks without changing the top-level verification recipe.
#
# The stack runs with **rootless Podman** — `podman compose` hands the compose
# file to the docker-compose binary over the user's Podman socket. There is no
# Docker daemon anywhere, nothing needs root, and nothing changes a sysctl
# (`docs/02-technology-choices.md` § Runtime layout). HTTPS is served on
# CALFLEX_HTTPS_PORT (8443 by default), never on 443: rootless containers cannot
# bind below 1024 without a sysctl change.

SHELL := /bin/sh

# Overridable, so a machine with a differently named provider still works.
PODMAN ?= podman
PODMAN_COMPOSE ?= $(PODMAN) compose
COMPOSE_FILE ?= infra/dev/compose.yaml
COMPOSE ?= $(PODMAN_COMPOSE) --file $(COMPOSE_FILE)

# One project name for `dev`, `seed` and the volumes they share.
COMPOSE_PROJECT_NAME ?= flexcalendar-dev
export COMPOSE_PROJECT_NAME

.DEFAULT_GOAL := help

.PHONY: help dev dev-build dev-down dev-logs dev-reset seed check-stack test-seed

help: ## List the available targets
	@printf 'flexcalendar targets:\n'
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_-]*:.*## ' $(MAKEFILE_LIST) \
		| sort -u \
		| awk 'BEGIN {FS = ":.*## "}; {printf "  %-13s %s\n", $$1, $$2}'

dev: ## Start the local stack and wait until it is healthy
	$(COMPOSE) up --detach --wait

dev-build: ## Rebuild the CalDAV and API images, then start the stack
	$(COMPOSE) build
	$(COMPOSE) up --detach --wait

dev-down: ## Stop the local stack, keeping its volumes
	$(COMPOSE) down --remove-orphans

dev-logs: ## Follow the local stack's logs
	$(COMPOSE) logs --follow --tail 50

dev-reset: ## Stop the local stack and delete its volumes (all local data)
	$(COMPOSE) down --volumes --remove-orphans

seed: dev ## Load infra/dev/seed/ into the stack (idempotent)
	$(COMPOSE) --profile seed run --rm seed
	$(COMPOSE) --profile seed build zitadel-config
	$(COMPOSE) --profile seed run --rm -T zitadel-config apply

check-stack: ## Check the local stack definition without a container runtime
	node infra/dev/check-stack.mjs

test-seed: ## Run the seed program against a stub Zitadel, no containers
	node --test 'infra/dev/seed/*.test.mjs'

.PHONY: verify verify-invariants verify-corpus

verify: ## Run every package gate, stack checks and registered suites (9 minute budget)
	timeout --kill-after=5s 540s node infra/scripts/verify.mjs all

verify-invariants: ## Run registered invariant checks against the local stack
	node infra/scripts/verify.mjs invariants

verify-corpus: ## Run registered corpus checks against the local stack
	node infra/scripts/verify.mjs corpus

# Discover packages at execution time. New packages need their four scripts;
# suites use JSON registrations, neither requires changing the verify recipe.
verify-%:
	node infra/scripts/verify.mjs $*

.PHONY: host-tools

# `make verify` and `make gen` need PHP, Composer, Flutter and Dart on PATH, and the
# dev host has none. Pass ARGS='--bin-dir <dir>' or ARGS=--skip-flutter to adjust.
host-tools: ## Install the pinned PHP, Composer, Flutter and Dart as shims in ~/.local/bin (no root)
	@test -d agent-team/node_modules || (cd agent-team && npm ci --no-audit --no-fund)
	cd agent-team && npm run --silent host-tools -- $(ARGS)

.PHONY: next-ready

# Advisory: it reads git, not the working tree. Pass ARGS='--all', '--json', '--next',
# '--explain <ID>', '--max-stack <n>' or '--max-parallel <n>'; see infra/scripts/next-ready.mjs.
next-ready: ## Rank the queued requirements that are ready to start (reads git; see the orchestrate skill)
	@node infra/scripts/next-ready.mjs $(ARGS)

.PHONY: token zitadel-plan test-zitadel

token: export CALFLEX_TOKEN_USER = $(USER)

token: ## Print a seeded user's verified JWT: make token USER=alice
	@test '$(origin USER)' = 'command line' || { printf 'use make token USER=<seeded user>\n' >&2; exit 1; }
	@$(COMPOSE) --profile seed run --rm -T zitadel-config token

zitadel-plan: ## Containerized OpenTofu plan (exit 0 means no changes; 2 means drift)
	$(COMPOSE) --profile seed run --rm -T zitadel-config plan

test-zitadel: ## Unit-test the configuration runner and token helper without containers
	node --test 'infra/zitadel/*.test.mjs'

.PHONY: gen gen-check

gen: ## Regenerate TS and Dart API clients using the pinned tools
	corepack pnpm --filter @flexcalendar/api-client run gen
	rm -rf apps/mobile/lib/api
	cd apps/mobile && flutter pub get && dart run swagger_parser && dart run build_runner build && dart format lib/api

gen-check: ## Fail on stale, missing or untracked generated API files
	node infra/scripts/gen-check.mjs

.PHONY: migrate migrate-down

migrate: ## Apply pending migrations (starts only Postgres; idempotent)
	$(COMPOSE) up --detach --wait postgres
	$(COMPOSE) --profile migrate run --build --rm -T migrate

migrate-down: ## Destructive dev-only rollback of ONE migration
	$(COMPOSE) up --detach --wait postgres
	$(COMPOSE) --profile migrate run --build --rm -T migrate node node_modules/node-pg-migrate/bin/node-pg-migrate.js down 1 --database-url-var CALFLEX_MIGRATE_DATABASE_URL -f migrate.config.json

.PHONY: test-caldav test-api-caldav

test-api-caldav: migrate ## Test the API's CalDAV adapter against the internal listener (E05-R02)
	$(COMPOSE) --profile test run --build --rm -T api-test

test-caldav: migrate ## Test internal CalDAV protocol/auth and check redacted logs
	@status=0; $(COMPOSE) --profile test run --build --rm -T caldav-test || status=$$?; \
	logs=$$(mktemp); \
	if ! $(COMPOSE) logs caldav >"$$logs" 2>&1; then rm -f "$$logs"; exit 1; fi; \
	if grep -qE 'CALFLEX_(REJECTED_HEADER|REJECTED_BODY|EVENT_CONTENT)_CANARY|CALFLEX_GUARD_MARKER' "$$logs"; then \
		printf 'CalDAV logs leaked test canary data\n' >&2; status=1; \
	fi; rm -f "$$logs"; exit $$status
