
# Thin wrapper over the bun scripts in package.json. Bun stays the source of truth;
# this file only gives one entry point per common task.

BUN ?= bun
CONFIG ?= ./subagent-router.json
UI_PORT ?= 8788
ARGS ?=

.DEFAULT_GOAL := help
.PHONY: help install build test typecheck check poc-demo poc-serve ui clean

help: ## Show this list
	@grep -hE '^[a-z][a-z-]*:.*## ' $(MAKEFILE_LIST) | sort | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	$(BUN) install --frozen-lockfile

build: ## Build dist/ (bundles, declarations, capability profiles)
	$(BUN) run build

test: ## Run the test suite
	$(BUN) test $(ARGS)

typecheck: ## Type-check without emitting
	$(BUN) run typecheck

check: typecheck test ## Type-check, then test

poc-demo: ## Run the PoC demo against the local test gateway
	$(BUN) run poc:demo

poc-serve: ## Run the PoC server; pass flags with ARGS="--config ... --profile ..."
	$(BUN) run poc:serve $(ARGS)

ui: build ## Build, then serve the read-only web console on UI_PORT
	$(BUN) dist/cli.js ui --config $(CONFIG) --port $(UI_PORT)

clean: ## Remove build output and rotated build history
	rm -rf dist .build-history coverage
