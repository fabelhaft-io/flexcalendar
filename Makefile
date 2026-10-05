# --- calendar-flex ------------------------------------------------------------------
#
# One entry point for the monorepo (D-09). Today it owns the local stack of
# E02-R03; E02-R04 adds `make verify` on top, and the component epics add their
# own targets.
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

check-stack: ## Check the local stack definition without a container runtime
	node infra/dev/check-stack.mjs

test-seed: ## Run the seed program against a stub Zitadel, no containers
	node --test 'infra/dev/seed/*.test.mjs'
