# CometTrail — local development
#
# `make dev` runs the dashboard locally against a LOCAL D1 (Miniflare) seeded
# with deterministic demo crawl data. Nothing here touches your remote
# Cloudflare database. See README.md for deploy/setup.

.DEFAULT_GOAL := help
.PHONY: help dev seed install worker tail clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

dev: install ## Run the dashboard locally with seeded test data (local D1 + live reload)
	npm -w dashboard run dev:local

seed: ## Regenerate the local demo dataset (override rows with COUNT=, RNG with SEED=)
	node scripts/seed-demo.mjs $(COUNT)

install: ## Install workspace dependencies
	@[ -d node_modules ] || npm install

worker: ## Run the collector worker (NOTE: --remote, hits live D1)
	npm -w worker run dev

tail: ## Stream live worker logs
	npm -w worker run tail

clean: ## Remove the generated local seed SQL artifact
	rm -f dashboard/seed.local.sql
