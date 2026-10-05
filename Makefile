# --- calendar-flex ------------------------------------------------------------------
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
COMPOSE_PROJECT_NAME ?= calendar-flex-dev
export COMPOSE_PROJECT_NAME

.DEFAULT_GOAL := help

.PHONY: help dev dev-build dev-down dev-logs dev-reset seed check-stack test-seed

help: ## List the available targets
	@printf 'calendar-flex targets:\n'
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
	$(COMPOSE) --profile seed run --build --rm -T zitadel-config apply

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

.PHONY: token zitadel-plan test-zitadel

token: export CALFLEX_TOKEN_USER = $(USER)

token: ## Print a seeded user's verified JWT: make token USER=alice
	@test '$(origin USER)' = 'command line' || { printf 'use make token USER=<seeded user>\n' >&2; exit 1; }
	@$(COMPOSE) --profile seed run --rm -T zitadel-config token

zitadel-plan: ## Containerized OpenTofu plan (exit 0 means no changes; 2 means drift)
	$(COMPOSE) --profile seed run --rm -T zitadel-config plan

test-zitadel: ## Unit-test the configuration runner and token helper without containers
	node --test 'infra/zitadel/*.test.mjs'
