#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/oneesama-live-screen.sh [options] [meeting-agent|slack-agent ...]

Options:
  --restart                    Stop an existing screen session before starting it.
  --allow-slack-agent-restart  Permit slack-agent lifecycle changes. Without this,
                               slack-agent is only audited when already running.
  --env <path>                 Pass an env file through to oneesama-live.sh.
  --bin <path>                 Pass the oneesama binary path through to oneesama-live.sh.
  --log-dir <path>             Log directory. Default: /tmp.
  --repo <path>                Repository root. Default: parent of this script.
  -h, --help                   Show this help.

Default service: meeting-agent.

This is the canonical detached-screen launcher. It deliberately routes service
startup through scripts/oneesama-live.sh so live env preflight and pid postcheck
cannot be bypassed by inline env snippets.
USAGE
}

die() {
  echo "oneesama-live-screen: $*" >&2
  exit 1
}

log() {
  echo "oneesama-live-screen: $*" >&2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${script_dir}/.." && pwd)"
log_dir="/tmp"
restart=0
allow_slack_restart=0
env_args=()
bin_arg=()
services=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart)
      restart=1
      shift
      ;;
    --allow-slack-agent-restart)
      allow_slack_restart=1
      shift
      ;;
    --env)
      [[ $# -ge 2 ]] || die "--env requires a path"
      env_args+=(--env "$2")
      shift 2
      ;;
    --bin)
      [[ $# -ge 2 ]] || die "--bin requires a path"
      bin_arg=(--bin "$2")
      shift 2
      ;;
    --log-dir)
      [[ $# -ge 2 ]] || die "--log-dir requires a path"
      log_dir="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires a path"
      repo="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option $1"
      ;;
    meeting-agent|slack-agent)
      services+=("$1")
      shift
      ;;
    *)
      die "unknown service $1"
      ;;
  esac
done

if [[ ${#services[@]} -eq 0 ]]; then
  services=(meeting-agent)
fi

session_name() {
  case "$1" in
    slack-agent) printf '%s' "oneesama-live-slack" ;;
    meeting-agent) printf '%s' "oneesama-live-meeting" ;;
    *) die "unknown service $1" ;;
  esac
}

log_path() {
  case "$1" in
    slack-agent) printf '%s/oneesama-slack-agent-live.log' "$log_dir" ;;
    meeting-agent) printf '%s/oneesama-meeting-agent-live.log' "$log_dir" ;;
    *) die "unknown service $1" ;;
  esac
}

screen_exists() {
  local output
  output="$(screen -ls 2>/dev/null || true)"
  grep -Fq ".$1" <<<"$output"
}

find_service_pid() {
  local service="$1"
  find_service_pids "$service" | tail -n 1
}

find_service_pids() {
  local service="$1"
  ps axww -o pid=,command= | find_service_pids_from_ps "$service"
}

configured_oneesama_bin() {
  if [[ ${#bin_arg[@]} -gt 0 ]]; then
    printf '%s' "${bin_arg[1]}"
  else
    printf '%s' "${ONEESAMA_LIVE_BIN:-./oneesama}"
  fi
}

find_service_pids_from_ps() {
  local service="$1"
  local configured_bin configured_base
  configured_bin="$(configured_oneesama_bin)"
  configured_base="$(basename "$configured_bin")"
  awk -v svc="$service" -v configured_bin="$configured_bin" -v configured_base="$configured_base" '
    {
      pid = $1
      cmd = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", cmd)
      split(cmd, parts, /[[:space:]]+/)
      exe = parts[1]
      first_arg = parts[2]
      n = split(exe, path, "/")
      base = path[n]
      if (first_arg != svc) {
        next
      }
      matches = exe == configured_bin || exe == "./" configured_base || base == configured_base || base == "oneesama" || base ~ /^oneesama[-_]/
      if (matches) {
        print pid
      }
    }
  '
}

wait_for_exit() {
  local session="$1"
  local attempt
  for attempt in {1..40}; do
    if ! screen_exists "$session"; then
      return 0
    fi
    sleep 0.25
  done
  die "screen session ${session} did not exit"
}

wait_for_pid_exit() {
  local pid="$1"
  local attempt
  for attempt in {1..40}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_pid() {
  local service="$1"
  local pid attempt
  for attempt in {1..40}; do
    pid="$(find_service_pid "$service")"
    if [[ -n "$pid" ]]; then
      printf '%s' "$pid"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

run_preflight() {
  local service="$1"
  local args=()
  if [[ ${#env_args[@]} -gt 0 ]]; then
    args+=("${env_args[@]}")
  fi
  if [[ ${#bin_arg[@]} -gt 0 ]]; then
    args+=("${bin_arg[@]}")
  fi
  log "preflight ${service} via oneesama-live.sh"
  if [[ ${#args[@]} -gt 0 ]]; then
    (cd "$repo" && "$wrapper" "${args[@]}" --preflight-only "$service")
  else
    (cd "$repo" && "$wrapper" --preflight-only "$service")
  fi
}

run_pid_check() {
  local service="$1"
  local pid="$2"
  local args=()
  if [[ ${#env_args[@]} -gt 0 ]]; then
    args+=("${env_args[@]}")
  fi
  if [[ ${#bin_arg[@]} -gt 0 ]]; then
    args+=("${bin_arg[@]}")
  fi
  log "postcheck ${service} pid=${pid} via oneesama-live.sh"
  if [[ ${#args[@]} -gt 0 ]]; then
    (cd "$repo" && "$wrapper" "${args[@]}" --check-pid "$pid" "$service")
  else
    (cd "$repo" && "$wrapper" --check-pid "$pid" "$service")
  fi
}

start_service() {
  local service="$1"
  local session logfile pid
  session="$(session_name "$service")"
  logfile="$(log_path "$service")"

  if [[ "$service" == "slack-agent" && "$allow_slack_restart" -ne 1 ]]; then
    pid="$(find_service_pid "$service")"
    if [[ -n "${pid:-}" ]]; then
      run_pid_check "$service" "$pid"
      log "slack-agent already running; audited existing process and refused lifecycle change"
      return 0
    fi
    die "refusing to start slack-agent without --allow-slack-agent-restart; use the flag only when you intend to replace the live Pi foreground process"
  fi

  run_preflight "$service"

  if screen_exists "$session"; then
    if [[ "$restart" -eq 1 ]]; then
      log "stopping existing screen session ${session}"
      screen -S "$session" -X quit || true
      wait_for_exit "$session"
    else
      pid="$(find_service_pid "$service")"
      if [[ ( "$service" == "slack-agent" || "$service" == "meeting-agent" ) && -n "${pid:-}" ]]; then
        run_pid_check "$service" "$pid"
      fi
      log "screen session ${session} already exists; use --restart to replace it"
      return 0
    fi
  fi

  local existing_pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && existing_pids+=("$pid")
  done < <(find_service_pids "$service")
  pid="$(find_service_pid "$service")"
  if [[ "$restart" -eq 1 && ${#existing_pids[@]} -gt 0 ]]; then
    for pid in "${existing_pids[@]}"; do
      log "stopping existing ${service} process pid=${pid}"
      kill "$pid" || true
    done
    for pid in "${existing_pids[@]}"; do
      if ! wait_for_pid_exit "$pid"; then
        log "existing ${service} process pid=${pid} did not exit after SIGTERM; sending SIGKILL"
        kill -9 "$pid" || true
        wait_for_pid_exit "$pid" || die "${service} process pid=${pid} did not exit"
      fi
    done
    pid=""
  elif [[ -n "${pid:-}" ]]; then
    log "${service} process pid=${pid} already exists outside screen; use --restart to replace it"
    return 0
  fi

  mkdir -p "$log_dir"
  log "starting ${service} in screen ${session}; log=${logfile}"
  local start_args=()
  if [[ ${#env_args[@]} -gt 0 ]]; then
    start_args+=("${env_args[@]}")
  fi
  if [[ ${#bin_arg[@]} -gt 0 ]]; then
    start_args+=("${bin_arg[@]}")
  fi
  if [[ ${#start_args[@]} -gt 0 ]]; then
    screen -dmS "$session" bash -lc '
      repo="$1"
      wrapper="$2"
      logfile="$3"
      shift 3
      cd "$repo"
      exec "$wrapper" "$@" >> "$logfile" 2>&1
    ' _ "$repo" "$wrapper" "$logfile" "${start_args[@]}" "$service"
  else
    screen -dmS "$session" bash -lc '
    repo="$1"
    wrapper="$2"
    logfile="$3"
    shift 3
    cd "$repo"
    exec "$wrapper" "$@" >> "$logfile" 2>&1
    ' _ "$repo" "$wrapper" "$logfile" "$service"
  fi

  pid="$(wait_for_pid "$service" || true)"
  [[ -n "$pid" ]] || die "started screen ${session}, but ${service} pid did not appear; inspect ${logfile}"
  if [[ "$service" == "slack-agent" || "$service" == "meeting-agent" ]]; then
    run_pid_check "$service" "$pid"
  fi
  log "ok: ${service} running pid=${pid}"
}

if [[ -n "${ONEESAMA_LIVE_SCREEN_TEST_FIND_PID:-}" ]]; then
  find_service_pids_from_ps "$ONEESAMA_LIVE_SCREEN_TEST_FIND_PID" | tail -n 1
  exit 0
fi

wrapper="${repo}/scripts/oneesama-live.sh"
[[ -x "$wrapper" ]] || die "wrapper is not executable: $wrapper"
command -v screen >/dev/null 2>&1 || die "screen is required"

for service in "${services[@]}"; do
  start_service "$service"
done
