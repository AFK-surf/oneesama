#!/usr/bin/env bash
set -euo pipefail

version="${GOLANGCI_LINT_VERSION:-v2.12.2}"

if command -v golangci-lint >/dev/null 2>&1; then
  exec golangci-lint "$@"
fi

exec go run "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${version}" "$@"
