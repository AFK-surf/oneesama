#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/oneesama-live.sh [options] [slack-agent|meeting-agent]

Options:
  --env <path>          Source an env file with allexport enabled. Repeatable.
                        Defaults to ONEESAMA_LIVE_ENV_FILES, or:
                        ${XDG_CONFIG_HOME:-$HOME/.config}/oneesama/live-env/oneesama-r24-a-window/live-env.sh
                        ${XDG_CONFIG_HOME:-$HOME/.config}/oneesama/live-env/oneesama-live-env-from-proc.sh
                        meeting-agent: oneesama-openai-live.sh, oneesama-app-control-live.sh
                        slack-agent: oneesama-workspace-triage-policy.sh, oneesama-slack-env.sh
  --bin <path>          oneesama binary path. Default: ./oneesama
  --preflight-only      Load env and validate required exported tokens, then exit.
  --check-pid <pid>     Verify the already-started process still has required env.
  --allow-legacy-slack  Allow slack-agent to boot without the live Pi foreground
                        posture. Intended only for local/dev smoke tests.
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
    --allow-legacy-slack)
      export ONEESAMA_LIVE_ALLOW_LEGACY_SLACK=1
      shift
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
    if [[ -n "${ONEESAMA_LIVE_DEFAULT_ENV_DIR:-}" ]]; then
      default_env_dir="${ONEESAMA_LIVE_DEFAULT_ENV_DIR}"
    else
      config_home="${XDG_CONFIG_HOME:-${HOME:-}}"
      [[ -n "$config_home" ]] || die "HOME or XDG_CONFIG_HOME is required to locate default live env files"
      if [[ -z "${XDG_CONFIG_HOME:-}" ]]; then
        config_home="${config_home}/.config"
      fi
      default_env_dir="${config_home}/oneesama/live-env"
    fi
    env_files=(
      "${default_env_dir}/oneesama-r24-a-window/live-env.sh"
      "${default_env_dir}/oneesama-live-env-from-proc.sh"
    )
    if [[ "$subcommand" == "meeting-agent" ]]; then
      env_files+=(
        "${default_env_dir}/oneesama-openai-live.sh"
        "${default_env_dir}/oneesama-app-control-live.sh"
      )
    fi
    if [[ "$subcommand" == "slack-agent" ]]; then
      env_files+=(
        "${default_env_dir}/oneesama-workspace-triage-policy.sh"
        "${default_env_dir}/oneesama-slack-env.sh"
      )
    fi
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

set_env_default() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || return 0
  if [[ -z "${!name:-}" ]]; then
    export "$name=$value"
  fi
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
  check_env_alias_conflict "OpenAI Realtime runtime placement" ONEESAMA_OPENAI_REALTIME_RUNTIME_PLACEMENT ONEESAMA_REALTIME_RUNTIME_PLACEMENT MAB_OPENAI_REALTIME_RUNTIME_PLACEMENT MAB_REALTIME_RUNTIME_PLACEMENT
  check_env_alias_conflict "state provider" ONEESAMA_STATE_PROVIDER ONEESAMA_PERSISTENCE_PROVIDER MAB_STATE_PROVIDER
  check_env_alias_conflict "state SQLite path" ONEESAMA_STATE_SQLITE_PATH ONEESAMA_PERSISTENCE_SQLITE_PATH MAB_STATE_SQLITE_PATH
}

sanitize_live_env() {
  if [[ "$subcommand" != "meeting-agent" ]]; then
    return 0
  fi
  if [[ -n "${ONEESAMA_DISABLE_EMPTY_ROOM_AUTO_STOP:-}" || -n "${MAB_DISABLE_EMPTY_ROOM_AUTO_STOP:-}" ]]; then
    if is_true "${ONEESAMA_ALLOW_DISABLE_EMPTY_ROOM_AUTO_STOP:-0}"; then
      log "warn: empty-room auto-stop is disabled by explicit override"
    else
      unset ONEESAMA_DISABLE_EMPTY_ROOM_AUTO_STOP
      unset MAB_DISABLE_EMPTY_ROOM_AUTO_STOP
      log "ok: cleared empty-room auto-stop disable flags for live meeting-agent"
    fi
  fi
}

load_kwwk_planner_config() {
  if [[ "$subcommand" != "meeting-agent" ]]; then
    return 0
  fi

  local provider
  provider="$(first_env_value ONEESAMA_KWWK_CU_PLANNER_PROVIDER ONEESAMA_KWWK_PLANNER_PROVIDER MAB_KWWK_CU_PLANNER_PROVIDER MAB_KWWK_PLANNER_PROVIDER || true)"
  provider="$(normalize_provider "${provider:-gemini}")"
  if [[ "$provider" != "openrouter" && "$provider" != "gemini" ]]; then
    return 0
  fi

  local config_path
  config_path="$(first_env_value ONEESAMA_KWWK_CU_PLANNER_CUEBOARD_CONFIG_PATH MAB_KWWK_CU_PLANNER_CUEBOARD_CONFIG_PATH || true)"
  config_path="${config_path:-/Users/pengx17/Desktop/config.cueboard.staging.json}"
  if [[ ! -f "$config_path" ]]; then
    log "warn: KWWK CU planner cueboard config not found: $config_path"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log "warn: jq is required to load KWWK CU planner cueboard config"
    return 0
  fi

  local provider_json
  provider_json="$(jq -cer --arg provider "$provider" '
    .copilot.llm.providers[]?
    | select((.name // "") == $provider)
    | {
        api_key: (.api_key // ""),
        base_url: (.base_url // ""),
        http_referer: ((.headers // {})["HTTP-Referer"] // ""),
        x_title: ((.headers // {})["X-Title"] // "")
      }
    | select(.api_key != "")
  ' "$config_path" | head -n 1 || true)"
  if [[ -z "$provider_json" ]]; then
    log "warn: KWWK CU planner cueboard config has no usable ${provider} provider"
    return 0
  fi

  local api_key base_url http_referer x_title
  api_key="$(jq -r '.api_key' <<<"$provider_json")"
  base_url="$(jq -r '.base_url' <<<"$provider_json")"
  http_referer="$(jq -r '.http_referer' <<<"$provider_json")"
  x_title="$(jq -r '.x_title' <<<"$provider_json")"

  if [[ "$provider" == "openrouter" ]]; then
    set_env_default ONEESAMA_KWWK_CU_PLANNER_PROVIDER "openrouter"
    set_env_default ONEESAMA_KWWK_CU_PLANNER_MODEL "google/gemini-3.5-flash"
    set_env_default ONEESAMA_OPENROUTER_API_KEY "$api_key"
    set_env_default ONEESAMA_OPENROUTER_BASE_URL "$base_url"
    set_env_default ONEESAMA_OPENROUTER_HTTP_REFERER "$http_referer"
    set_env_default ONEESAMA_OPENROUTER_X_TITLE "$x_title"
    log "ok: KWWK CU planner OpenRouter config loaded from cueboard config via ONEESAMA_OPENROUTER_API_KEY"
  elif [[ "$provider" == "gemini" ]]; then
    set_env_default ONEESAMA_KWWK_CU_PLANNER_PROVIDER "gemini"
    set_env_default ONEESAMA_KWWK_CU_PLANNER_MODEL "gemini-3.5-flash"
    set_env_default ONEESAMA_GEMINI_API_KEY "$api_key"
    set_env_default ONEESAMA_GEMINI_BASE_URL "$base_url"
    log "ok: KWWK CU planner Gemini config loaded from cueboard config via ONEESAMA_GEMINI_API_KEY"
  fi
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

require_env_value() {
  local label="$1"
  local expected="$2"
  shift 2
  local found value
  found="$(first_env_name_with_value "$@" || true)"
  if [[ -z "$found" ]]; then
    die "$label is required; expected ${expected} via one of: $*"
  fi
  value="${!found}"
  if [[ "$value" != "$expected" ]]; then
    die "$label must be ${expected}; got ${found}=${value}"
  fi
  log "ok: $label = $expected via $found"
}

require_env_present() {
  local label="$1"
  shift
  local found value
  found="$(first_env_name_with_value "$@" || true)"
  if [[ -z "$found" ]]; then
    die "$label is required; expected one of: $*"
  fi
  value="${!found}"
  log "ok: $label exported via $found (length ${#value})"
}

require_env_false() {
  local label="$1"
  shift
  local found value normalized
  found="$(first_env_name_with_value "$@" || true)"
  if [[ -z "$found" ]]; then
    die "$label must be explicitly false for live slack-agent; expected one of: $*"
  fi
  value="${!found}"
  normalized="$(normalize_bool "$value")"
  case "$normalized" in
    0|false|no|n|off)
      log "ok: $label = false via $found"
      ;;
    *)
      die "$label must be false for live slack-agent; got ${found}=${value}"
      ;;
  esac
}

require_env_name() {
	local name="$1"
	local value="${!name:-}"
	if [[ -z "$value" ]]; then
		die "$name is required but not exported"
	fi
	log "ok: $name exported (length ${#value})"
}

check_live_meeting_realtime_placement() {
  if [[ "$subcommand" != "meeting-agent" ]]; then
    return 0
  fi
  local placement normalized
  placement="$(first_env_value ONEESAMA_OPENAI_REALTIME_RUNTIME_PLACEMENT ONEESAMA_REALTIME_RUNTIME_PLACEMENT MAB_OPENAI_REALTIME_RUNTIME_PLACEMENT MAB_REALTIME_RUNTIME_PLACEMENT || true)"
  if [[ -z "$placement" ]]; then
    log "ok: OpenAI Realtime runtime placement defaults to sidecar"
    return 0
  fi
  normalized="$(printf '%s' "$placement" | tr '[:upper:]_' '[:lower:]-')"
  case "$normalized" in
    sidecar)
      log "ok: OpenAI Realtime runtime placement explicitly sidecar"
      ;;
    inline)
      die "inline Realtime SDK on Meet has been removed; remove the placement override to use the sidecar default"
      ;;
    *)
      die "OpenAI Realtime runtime placement must be sidecar; got ${placement}"
      ;;
  esac
}

strict_live_slack_enabled() {
  [[ "$subcommand" == "slack-agent" ]] && ! is_true "${ONEESAMA_LIVE_ALLOW_LEGACY_SLACK:-0}"
}

check_live_slack_posture() {
  if [[ "$subcommand" != "slack-agent" ]]; then
    return 0
  fi
  if is_true "${ONEESAMA_LIVE_ALLOW_LEGACY_SLACK:-0}"; then
    log "warn: skipping live slack-agent Pi foreground posture guard because ONEESAMA_LIVE_ALLOW_LEGACY_SLACK is enabled"
    return 0
  fi

  require_env_value "triage foreground chain" "pi_first_live" ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN MAB_SLACK_TRIAGE_FOREGROUND_CHAIN
  require_env_present "workspace triage policy" ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY MAB_SLACK_TRIAGE_WORKSPACE_POLICY
  require_env_value "persona runtime provider" "oneesama-pi" ONEESAMA_PERSONA_RUNTIME MAB_PERSONA_RUNTIME
  require_env_value "persona runtime mode" "live" ONEESAMA_PERSONA_RUNTIME_MODE MAB_PERSONA_RUNTIME_MODE
  require_env_false "persona runtime shadow-only" ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY MAB_PERSONA_RUNTIME_SHADOW_ONLY
  require_env_any "Oneesama Pi API key" ONEESAMA_PI_API_KEY PI_API_KEY OPENROUTER_API_KEY
  log "ok: live slack-agent Pi foreground posture locked"
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
    check_live_slack_posture
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
  elif [[ "$subcommand" == "meeting-agent" ]]; then
    require_env_any "OpenAI Realtime API key" ONEESAMA_OPENAI_API_KEY MAB_OPENAI_API_KEY OPENAI_API_KEY
    check_live_meeting_realtime_placement
    local kwwk_planner_provider kwwk_planner_model
    kwwk_planner_provider="$(first_env_value ONEESAMA_KWWK_CU_PLANNER_PROVIDER ONEESAMA_KWWK_PLANNER_PROVIDER MAB_KWWK_CU_PLANNER_PROVIDER MAB_KWWK_PLANNER_PROVIDER || true)"
    kwwk_planner_provider="$(normalize_provider "${kwwk_planner_provider:-gemini}")"
    if [[ "$kwwk_planner_provider" == "openrouter" ]]; then
      require_env_any "KWWK CU OpenRouter planner API key" ONEESAMA_OPENROUTER_API_KEY MAB_OPENROUTER_API_KEY OPENROUTER_API_KEY ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_API_KEY MAB_KWWK_CU_PLANNER_OPENROUTER_API_KEY
      kwwk_planner_model="$(first_env_value ONEESAMA_KWWK_CU_PLANNER_MODEL ONEESAMA_KWWK_PLANNER_MODEL MAB_KWWK_CU_PLANNER_MODEL MAB_KWWK_PLANNER_MODEL || true)"
      log "ok: KWWK CU planner provider=openrouter model=${kwwk_planner_model:-google/gemini-3.5-flash}"
    elif [[ "$kwwk_planner_provider" == "gemini" ]]; then
      require_env_any "KWWK CU Gemini planner API key" ONEESAMA_GEMINI_API_KEY MAB_GEMINI_API_KEY GEMINI_API_KEY ONEESAMA_KWWK_CU_PLANNER_GEMINI_API_KEY MAB_KWWK_CU_PLANNER_GEMINI_API_KEY
      kwwk_planner_model="$(first_env_value ONEESAMA_KWWK_CU_PLANNER_MODEL ONEESAMA_KWWK_PLANNER_MODEL MAB_KWWK_CU_PLANNER_MODEL MAB_KWWK_PLANNER_MODEL || true)"
      log "ok: KWWK CU planner provider=gemini model=${kwwk_planner_model:-gemini-3.5-flash}"
    else
      log "ok: KWWK CU planner provider=${kwwk_planner_provider}"
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

process_has_env_key() {
  local pid="$1"
  local name="$2"
  if [[ -r "/proc/$pid/environ" ]]; then
    tr '\0' '\n' <"/proc/$pid/environ" | grep -Eq "^${name}="
    return $?
  fi
  ps eww -p "$pid" 2>/dev/null | grep -Eq "(^|[[:space:]])${name}="
}

check_process_env() {
  local pid="$1"
  [[ -n "$pid" ]] || die "--check-pid requires a pid"
  kill -0 "$pid" 2>/dev/null || die "process $pid is not running"

  local names=()
  local slack_bot slack_app openai_realtime_key realtime_placement required_codex_env
  slack_bot="$(first_env_name_with_value ONEESAMA_SLACK_BOT_TOKEN SLACK_BOT_TOKEN MAB_SLACK_BOT_TOKEN || true)"
  slack_app="$(first_env_name_with_value ONEESAMA_SLACK_APP_TOKEN SLACK_APP_TOKEN MAB_SLACK_APP_TOKEN || true)"
  [[ -n "$slack_bot" ]] && names+=("$slack_bot")
  [[ -n "$slack_app" ]] && names+=("$slack_app")
  if [[ "$subcommand" == "meeting-agent" ]]; then
    local kwwk_planner_provider kwwk_planner_model kwwk_openrouter_key kwwk_openrouter_base kwwk_openrouter_referer kwwk_openrouter_title kwwk_gemini_key kwwk_gemini_base
    openai_realtime_key="$(first_env_name_with_value ONEESAMA_OPENAI_API_KEY MAB_OPENAI_API_KEY OPENAI_API_KEY || true)"
    realtime_placement="$(first_env_name_with_value ONEESAMA_OPENAI_REALTIME_RUNTIME_PLACEMENT ONEESAMA_REALTIME_RUNTIME_PLACEMENT MAB_OPENAI_REALTIME_RUNTIME_PLACEMENT MAB_REALTIME_RUNTIME_PLACEMENT || true)"
    [[ -n "$openai_realtime_key" ]] && names+=("$openai_realtime_key")
    [[ -n "$realtime_placement" ]] && names+=("$realtime_placement")
    kwwk_planner_provider="$(first_env_name_with_value ONEESAMA_KWWK_CU_PLANNER_PROVIDER ONEESAMA_KWWK_PLANNER_PROVIDER MAB_KWWK_CU_PLANNER_PROVIDER MAB_KWWK_PLANNER_PROVIDER || true)"
    kwwk_planner_model="$(first_env_name_with_value ONEESAMA_KWWK_CU_PLANNER_MODEL ONEESAMA_KWWK_PLANNER_MODEL MAB_KWWK_CU_PLANNER_MODEL MAB_KWWK_PLANNER_MODEL || true)"
    kwwk_openrouter_key="$(first_env_name_with_value ONEESAMA_OPENROUTER_API_KEY MAB_OPENROUTER_API_KEY OPENROUTER_API_KEY ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_API_KEY MAB_KWWK_CU_PLANNER_OPENROUTER_API_KEY || true)"
    kwwk_openrouter_base="$(first_env_name_with_value ONEESAMA_OPENROUTER_BASE_URL MAB_OPENROUTER_BASE_URL OPENROUTER_BASE_URL ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_BASE_URL MAB_KWWK_CU_PLANNER_OPENROUTER_BASE_URL || true)"
    kwwk_openrouter_referer="$(first_env_name_with_value ONEESAMA_OPENROUTER_HTTP_REFERER MAB_OPENROUTER_HTTP_REFERER OPENROUTER_HTTP_REFERER ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_HTTP_REFERER MAB_KWWK_CU_PLANNER_OPENROUTER_HTTP_REFERER || true)"
    kwwk_openrouter_title="$(first_env_name_with_value ONEESAMA_OPENROUTER_X_TITLE MAB_OPENROUTER_X_TITLE OPENROUTER_X_TITLE ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_X_TITLE MAB_KWWK_CU_PLANNER_OPENROUTER_X_TITLE || true)"
    kwwk_gemini_key="$(first_env_name_with_value ONEESAMA_GEMINI_API_KEY MAB_GEMINI_API_KEY GEMINI_API_KEY ONEESAMA_KWWK_CU_PLANNER_GEMINI_API_KEY MAB_KWWK_CU_PLANNER_GEMINI_API_KEY || true)"
    kwwk_gemini_base="$(first_env_name_with_value ONEESAMA_GEMINI_BASE_URL MAB_GEMINI_BASE_URL GEMINI_BASE_URL ONEESAMA_KWWK_CU_PLANNER_GEMINI_BASE_URL MAB_KWWK_CU_PLANNER_GEMINI_BASE_URL || true)"
    [[ -n "$kwwk_planner_provider" ]] && names+=("$kwwk_planner_provider")
    [[ -n "$kwwk_planner_model" ]] && names+=("$kwwk_planner_model")
    [[ -n "$kwwk_openrouter_key" ]] && names+=("$kwwk_openrouter_key")
    [[ -n "$kwwk_openrouter_base" ]] && names+=("$kwwk_openrouter_base")
    [[ -n "$kwwk_openrouter_referer" ]] && names+=("$kwwk_openrouter_referer")
    [[ -n "$kwwk_openrouter_title" ]] && names+=("$kwwk_openrouter_title")
    [[ -n "$kwwk_gemini_key" ]] && names+=("$kwwk_gemini_key")
    [[ -n "$kwwk_gemini_base" ]] && names+=("$kwwk_gemini_base")
  fi
  required_codex_env="$(codex_required_env_key || true)"
  [[ -n "$required_codex_env" ]] && names+=("$required_codex_env")
  if strict_live_slack_enabled; then
    local foreground_chain persona_provider persona_mode persona_shadow pi_key workspace_policy
    foreground_chain="$(first_env_name_with_value ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN MAB_SLACK_TRIAGE_FOREGROUND_CHAIN || true)"
    workspace_policy="$(first_env_name_with_value ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY MAB_SLACK_TRIAGE_WORKSPACE_POLICY || true)"
    persona_provider="$(first_env_name_with_value ONEESAMA_PERSONA_RUNTIME MAB_PERSONA_RUNTIME || true)"
    persona_mode="$(first_env_name_with_value ONEESAMA_PERSONA_RUNTIME_MODE MAB_PERSONA_RUNTIME_MODE || true)"
    persona_shadow="$(first_env_name_with_value ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY MAB_PERSONA_RUNTIME_SHADOW_ONLY || true)"
    pi_key="$(first_env_name_with_value ONEESAMA_PI_API_KEY PI_API_KEY OPENROUTER_API_KEY || true)"
    [[ -n "$foreground_chain" ]] && names+=("$foreground_chain")
    [[ -n "$persona_provider" ]] && names+=("$persona_provider")
    [[ -n "$persona_mode" ]] && names+=("$persona_mode")
    [[ -n "$persona_shadow" ]] && names+=("$persona_shadow")
    [[ -n "$pi_key" ]] && names+=("$pi_key")
    if [[ -n "$workspace_policy" ]] && ! process_has_env_key "$pid" "$workspace_policy"; then
      die "process $pid does not expose required env $workspace_policy"
    fi
    [[ -n "$workspace_policy" ]] && log "ok: process $pid exposes $workspace_policy"
  fi

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

sanitize_live_env
load_kwwk_planner_config
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
