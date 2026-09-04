# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, Unikraft GmbH.

# Release channel to generate against (maps to a branch of the openapi repo).
CHANNEL           ?= prod-staging
SPEC_BASE         ?= https://raw.githubusercontent.com/unikraft-cloud/openapi/refs/heads/$(CHANNEL)
PLATFORM_SPEC     ?= $(SPEC_BASE)/platform.json
CONTROLPLANE_SPEC ?= $(SPEC_BASE)/controlplane.json
SANDBOX_SPEC      ?= $(SPEC_BASE)/plugins/sandbox.json

# The openapi-gen code generator. While the TypeScript template functions are
# unreleased, build it from a local checkout and point OPENAPI_GEN at the
# binary (this repository is not a Go module, so `go run <path>` won't work,
# and `go -C` would break the relative -t/-o paths below):
#   (cd ../x/tools/openapi-gen && go build -o /tmp/openapi-gen .)
#   make generate OPENAPI_GEN=/tmp/openapi-gen
GO            ?= go
NPM           ?= npm
NPX           ?= npx
OPENAPI_GEN   ?= $(GO) run unikraft.com/x/tools/openapi-gen@latest

TEMPLATES     ?= ./templates
OUTPUT        ?= ./src/api

.PHONY: all
all: generate build

.PHONY: generate
generate: ## Regenerate every plumbing client from the OpenAPI specs.
	$(OPENAPI_GEN) \
		-i $(PLATFORM_SPEC) \
		-o $(OUTPUT)/platform \
		-t $(TEMPLATES) \
		-v package=api
	$(OPENAPI_GEN) \
		-i $(CONTROLPLANE_SPEC) \
		-o $(OUTPUT)/controlplane \
		-t $(TEMPLATES) \
		-v package=api
	$(OPENAPI_GEN) \
		-i $(SANDBOX_SPEC) \
		-o $(OUTPUT)/plugins/sandbox \
		-t $(TEMPLATES) \
		-v package=api \
		-v clientImport=../../../core/http.js
	$(MAKE) fmt

.PHONY: fmt
fmt: ## Format the generated (and all) sources.
	$(NPX) @biomejs/biome format --write $(OUTPUT)

.PHONY: build
build: ## Build the dual ESM + CJS distribution.
	$(NPM) run build

.PHONY: typecheck
typecheck: ## Type-check the whole project without emitting.
	$(NPM) run typecheck

.PHONY: lint
lint: ## Lint and format-check with Biome.
	$(NPM) run lint

.PHONY: test
test: ## Run the test suite.
	$(NPM) run test

.PHONY: clean
clean: ## Remove build output.
	$(NPM) run clean

.PHONY: help
help: ## Show this help.
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
