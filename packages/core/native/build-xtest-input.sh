#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

cc cueboard-xtest-input.c \
  -Wall \
  -Wextra \
  -O2 \
  -o cueboard-xtest-input \
  -lX11 \
  -lXtst
