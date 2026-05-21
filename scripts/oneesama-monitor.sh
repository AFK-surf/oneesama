#!/usr/bin/env bash
set -euo pipefail

slack_url="${ONEESAMA_MONITOR_SLACK_URL:-http://127.0.0.1:8780}"
meeting_url="${ONEESAMA_MONITOR_MEETING_URL:-http://127.0.0.1:8781}"
audit_window="${ONEESAMA_MONITOR_AUDIT_WINDOW:-3h}"

# When ONEESAMA_STATUS_OUTPUT_DIR is set, a structured summary is written to
# "<dir>/monitor-result.json" so the unified status report wrapper can merge
# this script's findings with sibling scripts. Task #295.
status_output_dir="${ONEESAMA_STATUS_OUTPUT_DIR:-}"

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

echo "oneesama-monitor: checking realtime harness config ${meeting_url}/realtime/config"
curl -fsS "${meeting_url}/realtime/config" >"${tmpdir}/realtime-config.json"

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
harness_summary="$(
  {
    jq -r '
      .audit.harness as $h
      | [
          "pi_stable_prompt_hash=\($h.piStablePromptHash // "unknown")",
          "harness_drift=dynamic_context_issue:\($h.dynamicContextIssueCount // 0),delegate_no_visible_action:\($h.delegateNoVisibleActionCount // 0),handled_by_other_no_action:\($h.handledByOtherNoActionCount // 0)",
          "harness_budget=max_total_tokens:\($h.maxContextBudgetTokens // 0),max_stable_tokens:\($h.maxStablePromptTokens // 0),max_dynamic_tokens:\($h.maxDynamicContextTokens // 0),max_worker_result_tokens:\($h.maxWorkerResultTokens // 0),max_memory_evidence_tokens:\($h.maxMemoryEvidenceTokens // 0)"
        ]
      | .[]
    ' <"${tmpdir}/triage-audit.json"
    jq -r '
      .contextBudget as $b
      | "realtime_budget=total_tokens:\($b.totalTokens // 0),stable_tokens:\($b.stableTokens // 0),tool_schema_tokens:\($b.toolSchemaTokens // 0),dynamic_tokens:\($b.dynamicTokens // 0)"
    ' <"${tmpdir}/realtime-config.json"
  } | sed '/^$/d'
)"

write_status_summary() {
  local status="$1"
  if [[ -z "$status_output_dir" ]]; then
    return 0
  fi
  mkdir -p "$status_output_dir"
  jq -n \
    --arg script "oneesama-monitor" \
    --arg status "$status" \
    --arg window "$audit_window" \
    --arg slack_url "$slack_url" \
    --arg meeting_url "$meeting_url" \
    --arg persona_provider "$persona_provider" \
    --arg persona_mode "$persona_mode" \
    --arg red_flags "$red_flags" \
    --arg persona_summary "$persona_quality_summary" \
    --arg harness_summary "$harness_summary" \
    --rawfile triage_audit "${tmpdir}/triage-audit.json" \
    --rawfile realtime_config "${tmpdir}/realtime-config.json" \
    '{
      script: $script,
      status: $status,
      window: $window,
      checks: {
        slack_url: $slack_url,
        meeting_url: $meeting_url,
        persona_provider: $persona_provider,
        persona_mode: $persona_mode
      },
      red_flags: ($red_flags | split("\n") | map(select(. != ""))),
      persona_foreground_context: ($persona_summary | split("\n") | map(select(. != ""))),
      harness_context: ($harness_summary | split("\n") | map(select(. != ""))),
      meeting_realtime_config: ($realtime_config | fromjson),
      triage_audit: ($triage_audit | fromjson)
    }' >"${status_output_dir}/monitor-result.json"
}

if [[ -n "$red_flags" ]]; then
  echo "oneesama-monitor: red triage audit flags:" >&2
  echo "$red_flags" >&2
  echo "oneesama-monitor: persona foreground context:" >&2
  echo "$persona_quality_summary" >&2
  echo "oneesama-monitor: harness context:" >&2
  echo "$harness_summary" >&2
  write_status_summary "red"
  exit 1
fi

write_status_summary "ok"
echo "oneesama-monitor: harness context:"
echo "$harness_summary"
echo "oneesama-monitor: ok"
