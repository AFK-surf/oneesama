#!/usr/bin/env bash
set -euo pipefail

mode="${1:-full}"
if [[ "$#" -gt 0 ]]; then
  shift
fi

root="$(pwd)"
packages=()
while IFS= read -r dir; do
  rel=".${dir#"$root"}"
  case "$rel" in
    ./node_modules/* | ./runtime/* | ./dist/* | ./coverage/* | ./downloads/* | ./output/* | ./reports/* | ./tmp/* | ./snake-mobile-app/*)
      ;;
    *)
      packages+=("$rel")
      ;;
  esac
done < <(go list -f '{{.Dir}}' ./...)

args=(run --timeout=5m)
case "$mode" in
  full)
    ;;
  new)
    args+=(--new-from-rev="${GOLANGCI_NEW_FROM_REV:-HEAD}")
    ;;
  *)
    echo "usage: scripts/lint-go.sh [full|new] [golangci-lint flags...]" >&2
    exit 2
    ;;
esac

exec ./scripts/run-golangci-lint.sh "${args[@]}" "$@" "${packages[@]}"
