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
