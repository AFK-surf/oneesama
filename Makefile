GO ?= go
NPM ?= npm
BINARY := oneesama
PKG := ./cmd/oneesama
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS := -ldflags "-X github.com/AFK-surf/oneesama/pkg/version.Version=$(VERSION) -X github.com/AFK-surf/oneesama/pkg/version.GitCommit=$(GIT_COMMIT)"
NODE_DEPS_SENTINEL := node_modules/typescript/package.json
GO_PACKAGES := $(shell $(GO) list ./... | grep -v '/node_modules/')

.PHONY: build vet tidy test ensure-js-deps js-build

build: js-build
	$(GO) build $(LDFLAGS) -o $(BINARY) $(PKG)

js-build: ensure-js-deps
	$(NPM) run typecheck
	$(NPM) run bundle:realtime-agents-sdk

vet:
	$(GO) vet $(GO_PACKAGES)

tidy:
	$(GO) mod tidy

ensure-js-deps: $(NODE_DEPS_SENTINEL)

$(NODE_DEPS_SENTINEL): package.json package-lock.json
	@command -v $(NPM) >/dev/null 2>&1 || { echo "npm is required to install meet-runner test dependencies"; exit 1; }
	$(NPM) install --silent

test: ensure-js-deps
	$(GO) test $(GO_PACKAGES)
