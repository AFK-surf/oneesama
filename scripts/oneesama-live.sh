#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/oneesama-live.sh [options] [slack-agent|meeting-agent]

Options:
  --env <path>          Source an env file with allexport enabled. Repeatable.
                        Defaults to ONEESAMA_LIVE_ENV_FILES, or:
                        /private/tmp/oneesama-r24-a-window/live-env.sh
                        /tmp/oneesama-live-env-from-proc.sh
                        /tmp/oneesama-workspace-triage-policy.sh
  --bin <path>          oneesama binary path. Default: ./oneesama
  --preflight-only      Load env and validate required exported tokens, then exit.
  --check-pid <pid>     Verify the already-started process still has required env.
  -h, --help            Show this help.

This wrapper exists for live restarts. Every env file is sourced under `set -a`
so values from later files are exported to the oneesama child process even when
an earlier env file runs `set +a`.
USAGE
}

die() {
  echo "oneesama-live: $*" >&2
  exit 1
}

log() {
  echo "oneesama-live: $*" >&2
}

env_files=()
oneesama_bin="${ONEESAMA_LIVE_BIN:-./oneesama}"
mode="run"
check_pid=""
subcommand="${ONEESAMA_LIVE_SUBCOMMAND:-slack-agent}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || die "--env requires a path"
      env_files+=("$2")
      shift 2
      ;;
    --bin)
      [[ $# -ge 2 ]] || die "--bin requires a path"
      oneesama_bin="$2"
      shift 2
      ;;
    --preflight-only)
      mode="preflight"
      shift
      ;;
    --check-pid)
      [[ $# -ge 2 ]] || die "--check-pid requires a pid"
      mode="check-pid"
      check_pid="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option $1"
      ;;
    *)
      subcommand="$1"
      shift
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  subcommand="$1"
fi

if [[ ${#env_files[@]} -eq 0 ]]; then
  if [[ -n "${ONEESAMA_LIVE_ENV_FILES:-}" ]]; then
    # shellcheck disable=SC2206
    env_files=(${ONEESAMA_LIVE_ENV_FILES})
  else
    default_env_dir="${ONEESAMA_LIVE_DEFAULT_ENV_DIR:-/tmp}"
    env_files=(
      "${default_env_dir}/oneesama-r24-a-window/live-env.sh"
      "${default_env_dir}/oneesama-live-env-from-proc.sh"
      "${default_env_dir}/oneesama-workspace-triage-policy.sh"
    )
  fi
fi

source_exported() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    log "skip missing env file: $path"
    return 0
  fi
  log "source env file with allexport: $path"
  set -a
  # shellcheck source=/dev/null
  . "$path"
  set +a
}

first_env_value() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s' "${!name}"
      return 0
    fi
  done
  return 1
}

first_env_name_with_value() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s' "$name"
      return 0
    fi
  done
  return 1
}

check_env_alias_conflict() {
  local label="$1"
  shift
  local first_name="" first_value="" seen=0
  local name value
  for name in "$@"; do
    value="${!name:-}"
    [[ -z "$value" ]] && continue
    if [[ "$seen" -eq 0 ]]; then
      first_name="$name"
      first_value="$value"
    elif [[ "$value" != "$first_value" ]]; then
      die "$label has conflicting env aliases: $first_name and $name differ; remove the stale value or make aliases identical"
    fi
    seen=$((seen + 1))
  done
  if [[ "$seen" -gt 1 ]]; then
    log "ok: $label aliases agree across $seen env vars"
  fi
}

check_live_env_conflicts() {
  if [[ "$subcommand" == "slack-agent" ]]; then
    check_env_alias_conflict "Slack bot token" ONEESAMA_SLACK_BOT_TOKEN SLACK_BOT_TOKEN MAB_SLACK_BOT_TOKEN
    check_env_alias_conflict "Slack app token" ONEESAMA_SLACK_APP_TOKEN SLACK_APP_TOKEN MAB_SLACK_APP_TOKEN
    check_env_alias_conflict "Slack bot user ID" ONEESAMA_SLACK_BOT_USER_ID SLACK_BOT_USER_ID MAB_SLACK_BOT_USER_ID
    check_env_alias_conflict "Slack workspace dir" ONEESAMA_SLACK_WORKSPACE_DIR MAB_SLACK_WORKSPACE_DIR
    check_env_alias_conflict "triage foreground chain" ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN MAB_SLACK_TRIAGE_FOREGROUND_CHAIN
    check_env_alias_conflict "workspace triage policy" ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY MAB_SLACK_TRIAGE_WORKSPACE_POLICY
    check_env_alias_conflict "persona runtime provider" ONEESAMA_PERSONA_RUNTIME MAB_PERSONA_RUNTIME
    check_env_alias_conflict "persona runtime mode" ONEESAMA_PERSONA_RUNTIME_MODE MAB_PERSONA_RUNTIME_MODE
    check_env_alias_conflict "persona runtime base URL" ONEESAMA_PERSONA_RUNTIME_BASE_URL MAB_PERSONA_RUNTIME_BASE_URL
    check_env_alias_conflict "persona runtime shadow-only" ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY MAB_PERSONA_RUNTIME_SHADOW_ONLY
  fi
  check_env_alias_conflict "agent runner provider" ONEESAMA_AGENT_RUNNER MAB_AGENT_RUNNER
  check_env_alias_conflict "agent runner dry-run" ONEESAMA_DRY_RUN_AGENT MAB_DRY_RUN_AGENT MAB_DRY_RUN_CODEX
  check_env_alias_conflict "Codex model" ONEESAMA_CODEX_MODEL MAB_CODEX_MODEL
  check_env_alias_conflict "Codex model provider" ONEESAMA_CODEX_MODEL_PROVIDER MAB_CODEX_MODEL_PROVIDER
  check_env_alias_conflict "Codex base URL" ONEESAMA_CODEX_BASE_URL MAB_CODEX_BASE_URL
  check_env_alias_conflict "Codex env key" ONEESAMA_CODEX_ENV_KEY MAB_CODEX_ENV_KEY
  check_env_alias_conflict "Codex wire API" ONEESAMA_CODEX_WIRE_API MAB_CODEX_WIRE_API
  check_env_alias_conflict "state provider" ONEESAMA_STATE_PROVIDER ONEESAMA_PERSISTENCE_PROVIDER MAB_STATE_PROVIDER
  check_env_alias_conflict "state SQLite path" ONEESAMA_STATE_SQLITE_PATH ONEESAMA_PERSISTENCE_SQLITE_PATH MAB_STATE_SQLITE_PATH
}

normalize_bool() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

normalize_provider() {
  printf '%s' "$1" | tr '[:upper:]_ ' '[:lower:]--'
}

is_true() {
  case "$(normalize_bool "$1")" in
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

check_no_socket_mode_competitors() {
  if [[ "$subcommand" != "slack-agent" ]]; then
    return 0
  fi
  if is_true "${ONEESAMA_ALLOW_SOCKET_MODE_COMPETITORS:-0}"; then
    log "warn: skipping Slack Socket Mode competitor guard because ONEESAMA_ALLOW_SOCKET_MODE_COMPETITORS is enabled"
    return 0
  fi
  if ! command -v launchctl >/dev/null 2>&1; then
    return 0
  fi

  local domain label
  domain="gui/$(id -u)"
  while IFS= read -r label; do
    if launchctl print "${domain}/${label}" >/dev/null 2>&1 && socket_mode_competitor_conflicts "$label"; then
      die "Slack Socket Mode app conflict: ${label} is running with app_id=$(socket_mode_competitor_app_id "$label"), matching Oneesama app_id=$(slack_app_id_from_app_token "${SLACK_APP_TOKEN:-}"); bootout/disable it or set ONEESAMA_ALLOW_SOCKET_MODE_COMPETITORS=1"
    fi
  done < <(socket_mode_competitor_labels)
}

codex_required_env_key() {
  local provider dry_run base_url env_key
  provider="$(first_env_value ONEESAMA_AGENT_RUNNER MAB_AGENT_RUNNER || true)"
  provider="$(normalize_provider "${provider:-dry-run}")"
  dry_run="$(first_env_value ONEESAMA_DRY_RUN_AGENT MAB_DRY_RUN_AGENT MAB_DRY_RUN_CODEX || true)"
  if [[ -n "$dry_run" ]] && is_true "$dry_run"; then
    return 0
  fi
  if [[ "$provider" != "codex" ]]; then
    return 0
  fi

  env_key="$(first_env_value ONEESAMA_CODEX_ENV_KEY MAB_CODEX_ENV_KEY || true)"
  if [[ -n "$env_key" ]]; then
    printf '%s' "$env_key"
    return 0
  fi

  base_url="$(first_env_value ONEESAMA_CODEX_BASE_URL MAB_CODEX_BASE_URL || true)"
  base_url="$(printf '%s' "$base_url" | sed 's:/*$::')"
  if [[ -z "$base_url" ]]; then
    return 0
  fi
  case "$(printf '%s' "$base_url" | tr '[:upper:]' '[:lower:]')" in
    *openrouter.ai*) printf '%s' "OPENROUTER_API_KEY" ;;
    *) printf '%s' "OPENAI_API_KEY" ;;
  esac
}

require_env_any() {
  local label="$1"
  shift
  local found
  found="$(first_env_name_with_value "$@" || true)"
  if [[ -z "$found" ]]; then
    die "$label is required; expected one of: $*"
  fi
  log "ok: $label exported via $found"
}

require_env_name() {
	local name="$1"
	local value="${!name:-}"
	if [[ -z "$value" ]]; then
		die "$name is required but not exported"
	fi
	log "ok: $name exported (length ${#value})"
}

preflight_env() {
  if [[ "$subcommand" == "slack-agent" ]]; then
    require_env_any "Slack bot token" ONEESAMA_SLACK_BOT_TOKEN SLACK_BOT_TOKEN MAB_SLACK_BOT_TOKEN
    require_env_any "Slack app token" ONEESAMA_SLACK_APP_TOKEN SLACK_APP_TOKEN MAB_SLACK_APP_TOKEN
    if [[ -n "${ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN:-}" ]]; then
      log "ok: triage foreground chain = ${ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN}"
    else
      log "warn: ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN not exported; default config will apply"
    fi
    if [[ -n "${ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY:-}" ]]; then
      log "ok: workspace triage policy exported (length ${#ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY})"
    else
      log "warn: ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY not exported"
    fi
    check_no_socket_mode_competitors
    local persona_provider
    persona_provider="$(first_env_value ONEESAMA_PERSONA_RUNTIME MAB_PERSONA_RUNTIME || true)"
    persona_provider="$(normalize_provider "${persona_provider:-legacy}")"
    if [[ "$persona_provider" == "oneesama-pi" ]]; then
      require_env_any "Oneesama Pi API key" ONEESAMA_PI_API_KEY PI_API_KEY OPENROUTER_API_KEY
      log "ok: Oneesama Pi runtime provider selected"
      if [[ -n "${ONEESAMA_PI_MODEL:-${PI_MODEL_ID:-}}" ]]; then
        log "ok: Oneesama Pi model = ${ONEESAMA_PI_MODEL:-${PI_MODEL_ID:-}}"
      fi
    fi
  fi
	local required_codex_env
	required_codex_env="$(codex_required_env_key || true)"
  if [[ -n "$required_codex_env" ]]; then
    require_env_name "$required_codex_env"
  else
    log "ok: no extra Codex provider env required by current runner config"
  fi
}

process_has_env_name() {
  local pid="$1"
  local name="$2"
  if [[ -r "/proc/$pid/environ" ]]; then
    tr '\0' '\n' <"/proc/$pid/environ" | grep -Fqx "${name}=${!name}"
    return $?
  fi
  ps eww -p "$pid" 2>/dev/null | grep -Fq "${name}=${!name}"
}

check_process_env() {
  local pid="$1"
  [[ -n "$pid" ]] || die "--check-pid requires a pid"
  kill -0 "$pid" 2>/dev/null || die "process $pid is not running"

  local names=()
  local slack_bot slack_app required_codex_env
  slack_bot="$(first_env_name_with_value ONEESAMA_SLACK_BOT_TOKEN SLACK_BOT_TOKEN MAB_SLACK_BOT_TOKEN || true)"
  slack_app="$(first_env_name_with_value ONEESAMA_SLACK_APP_TOKEN SLACK_APP_TOKEN MAB_SLACK_APP_TOKEN || true)"
  [[ -n "$slack_bot" ]] && names+=("$slack_bot")
  [[ -n "$slack_app" ]] && names+=("$slack_app")
  required_codex_env="$(codex_required_env_key || true)"
  [[ -n "$required_codex_env" ]] && names+=("$required_codex_env")

  local name
  for name in "${names[@]}"; do
    if ! process_has_env_name "$pid" "$name"; then
      die "process $pid does not expose required env $name"
    fi
    log "ok: process $pid exposes $name"
  done
}

for env_file in "${env_files[@]}"; do
  source_exported "$env_file"
done

check_live_env_conflicts
preflight_env

case "$mode" in
  preflight)
    log "preflight passed"
    exit 0
    ;;
  check-pid)
    check_process_env "$check_pid"
    log "pid env check passed"
    exit 0
    ;;
  run)
    [[ -x "$oneesama_bin" ]] || die "oneesama binary is not executable: $oneesama_bin"
    log "exec: $oneesama_bin $subcommand"
    exec "$oneesama_bin" "$subcommand"
    ;;
  *)
    die "unknown mode $mode"
    ;;
esac
