#!/bin/sh
set -eu

if [ "${MAB_ENABLE_XVFB:-1}" != "0" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 "${MAB_XVFB_SCREEN:-1920x1080x24}" -nolisten tcp &
  xvfb_pid="$!"
  trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT INT TERM
  sleep "${MAB_XVFB_STARTUP_SLEEP:-0.4}"
  if command -v openbox >/dev/null 2>&1; then
    openbox >/tmp/oneesama-openbox.log 2>&1 &
  fi
fi

exec "$@"
