#!/usr/bin/env bash
set -euo pipefail

echo "[r22] ensure JS deps"
make ensure-js-deps

echo "[r22] vet"
make vet

echo "[r22] build"
make build

echo "[r22] make test"
make test

echo "[r22] targeted Go packages"
go test \
  ./pkg/config \
  ./internal/agentrunner/... \
  ./internal/slackagent/... \
  ./internal/meetingagent/... \
  ./internal/meetrunner/... \
  ./internal/integration/...

echo "[r22] raw recursive go test"
go test ./...

echo "[r22] race core runtime packages"
go test -race \
  ./internal/agentrunner/... \
  ./internal/slackagent/... \
  ./internal/meetingagent/... \
  ./internal/meetrunner/... \
  ./internal/integration/...

echo "[r22] diff check"
git diff --check

echo "[r22] OK"
