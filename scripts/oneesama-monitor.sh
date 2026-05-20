#!/usr/bin/env bash
set -euo pipefail

slack_url="${ONEESAMA_MONITOR_SLACK_URL:-http://127.0.0.1:8780}"
meeting_url="${ONEESAMA_MONITOR_MEETING_URL:-http://127.0.0.1:8781}"
audit_window="${ONEESAMA_MONITOR_AUDIT_WINDOW:-3h}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "oneesama-monitor: missing required command: $1" >&2
    exit 2
  }
}

need curl
need jq

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "oneesama-monitor: checking slack-agent ${slack_url}/healthz"
curl -fsS "${slack_url}/healthz" >"${tmpdir}/slack-health.json"
jq -e '.ok == true' <"${tmpdir}/slack-health.json" >/dev/null

echo "oneesama-monitor: checking meeting-agent ${meeting_url}/healthz"
curl -fsS "${meeting_url}/healthz" >"${tmpdir}/meeting-health.json"
jq -e '.ok == true' <"${tmpdir}/meeting-health.json" >/dev/null

echo "oneesama-monitor: checking slack status ${slack_url}/slack/status"
curl -fsS "${slack_url}/slack/status" >"${tmpdir}/slack-status.json"
persona_provider="$(jq -r '.persona_runtime.provider // ""' <"${tmpdir}/slack-status.json")"
persona_mode="$(jq -r '.persona_runtime.mode // ""' <"${tmpdir}/slack-status.json")"
persona_shadow_only="$(jq -r '.persona_runtime.shadow_only // false' <"${tmpdir}/slack-status.json")"
persona_base_url="$(jq -r '.persona_runtime.base_url // ""' <"${tmpdir}/slack-status.json")"
if [[ "${persona_provider}" == "oneesama-pi" ]]; then
  echo "oneesama-monitor: checking Oneesama Pi runtime via slack status"
  jq -e '.persona_runtime.ready == true and .persona_runtime.healthy == true and .persona_runtime.shadow_only == false' <"${tmpdir}/slack-status.json" >/dev/null
elif [[ "${persona_provider}" == "legacy" || "${persona_mode}" == "shadow" || "${persona_shadow_only}" == "true" ]]; then
  echo "oneesama-monitor: persona foreground disabled provider=${persona_provider:-unknown} mode=${persona_mode:-unknown}; skipping sidecar check"
else
  persona_url="${ONEESAMA_MONITOR_PERSONA_URL:-${persona_base_url:-http://127.0.0.1:8799}}"
  echo "oneesama-monitor: checking persona sidecar ${persona_url}/persona/status"
  curl -fsS "${persona_url}/persona/status" >"${tmpdir}/persona-status.json"
  jq -e '.ready == true and .healthy == true and .shadow_only == false' <"${tmpdir}/persona-status.json" >/dev/null
fi

echo "oneesama-monitor: checking triage audit window=${audit_window}"
curl -fsS "${slack_url}/slack/triage/audit?window=${audit_window}" >"${tmpdir}/triage-audit.json"
persona_quality_summary="$(
  jq -r '
    .audit.personaQuality as $q
    | [
        "latest_run=\($q.latestRunId // "none") at \($q.latestAt // "unknown") decision=\($q.latestDecision // "unknown")",
        "latest_auth_failure=\($q.latestAuthFailureRunId // "none") at \($q.latestAuthFailureAt // "none")",
        "stale_queued=\($q.foregroundStaleQueuedRuns // 0)"
      ]
    | .[]
  ' <"${tmpdir}/triage-audit.json"
)"
red_flags="$(jq -r '.audit.flags[]? | select(.level == "red") | "\(.code): \(.message)"' <"${tmpdir}/triage-audit.json")"
if [[ -n "$red_flags" ]]; then
  echo "oneesama-monitor: red triage audit flags:" >&2
  echo "$red_flags" >&2
  echo "oneesama-monitor: persona foreground context:" >&2
  echo "$persona_quality_summary" >&2
  exit 1
fi

echo "oneesama-monitor: ok"
