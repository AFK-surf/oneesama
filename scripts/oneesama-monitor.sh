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

is_true() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

socket_mode_competitor_labels() {
  local labels="${ONEESAMA_SOCKET_MODE_COMPETITOR_LABELS:-com.openclaw.twitter-reply-bot.live}"
  printf '%s\n' "$labels" | tr ', ' '\n' | sed '/^$/d'
}

socket_mode_competitor_env_entries() {
  local entries="${ONEESAMA_SOCKET_MODE_COMPETITOR_ENV_FILES:-com.openclaw.twitter-reply-bot.live=/Users/pengx17/.openclaw/twitter-bot/.env}"
  printf '%s\n' "$entries" | tr ', ' '\n' | sed '/^$/d'
}

env_file_value() {
  local file="$1"
  local key="$2"
  [[ -r "$file" ]] || return 1
  awk -v key="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (index(line, key "=") == 1) {
        sub(/^[^=]*=/, "", line)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
            (substr(line, 1, 1) == "'"'"'" && substr(line, length(line), 1) == "'"'"'")) {
          line = substr(line, 2, length(line) - 2)
        }
        print line
      }
    }
  ' "$file" | tail -n 1
}

slack_app_id_from_app_token() {
  local token="$1"
  if [[ "$token" =~ ^xapp-[^-]+-([A-Z0-9]+)- ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

socket_mode_competitor_env_file() {
  local label="$1"
  local entry entry_label entry_path
  while IFS= read -r entry; do
    entry_label="${entry%%=*}"
    entry_path="${entry#*=}"
    if [[ "$entry_label" == "$label" && "$entry_path" != "$entry" ]]; then
      printf '%s\n' "$entry_path"
      return 0
    fi
  done < <(socket_mode_competitor_env_entries)
  return 1
}

socket_mode_competitor_app_id() {
  local label="$1"
  local entry entry_label entry_app_id env_file app_token
  local app_ids="${ONEESAMA_SOCKET_MODE_COMPETITOR_APP_IDS:-}"
  if [[ -n "$app_ids" ]]; then
    while IFS= read -r entry; do
      entry_label="${entry%%=*}"
      entry_app_id="${entry#*=}"
      if [[ "$entry_label" == "$label" && "$entry_app_id" != "$entry" ]]; then
        printf '%s\n' "$entry_app_id"
        return 0
      fi
    done < <(printf '%s\n' "$app_ids" | tr ', ' '\n' | sed '/^$/d')
  fi
  if env_file="$(socket_mode_competitor_env_file "$label")"; then
    app_token="$(env_file_value "$env_file" SLACK_APP_TOKEN || true)"
    slack_app_id_from_app_token "$app_token"
  fi
}

socket_mode_competitor_conflicts() {
  local label="$1"
  local own_app_id competitor_app_id
  own_app_id="$(slack_app_id_from_app_token "${SLACK_APP_TOKEN:-}" || true)"
  competitor_app_id="$(socket_mode_competitor_app_id "$label" || true)"
  [[ -n "$own_app_id" && -n "$competitor_app_id" && "$own_app_id" == "$competitor_app_id" ]]
}

socket_mode_competitor_red_flags() {
  if is_true "${ONEESAMA_ALLOW_SOCKET_MODE_COMPETITORS:-0}"; then
    return 0
  fi
  if ! command -v launchctl >/dev/null 2>&1; then
    return 0
  fi

  local domain label
  domain="gui/$(id -u)"
  while IFS= read -r label; do
    if launchctl print "${domain}/${label}" >/dev/null 2>&1 && socket_mode_competitor_conflicts "$label"; then
      printf 'socket_mode_competitor: Slack Socket Mode app conflict: %s app_id=%s matches Oneesama app_id=%s\n' \
        "$label" "$(socket_mode_competitor_app_id "$label")" "$(slack_app_id_from_app_token "${SLACK_APP_TOKEN:-}")"
    fi
  done < <(socket_mode_competitor_labels)
}

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
socket_mode_red_flags="$(socket_mode_competitor_red_flags || true)"
red_flags="$(
  {
    printf '%s\n' "$red_flags"
    printf '%s\n' "$socket_mode_red_flags"
  } | sed '/^$/d'
)"
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
