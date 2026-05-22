#!/usr/bin/env bash
set -euo pipefail

# oneesama-status-report.sh — run both oneesama-monitor and the triage quality
# sweep into a shared output directory, then emit one unified markdown report
# (and JSON manifest) covering both health and quality findings. Task #295.
#
# Inputs (env):
#   ONEESAMA_MONITOR_SLACK_URL        — slack-agent base URL (default 127.0.0.1:8780)
#   ONEESAMA_MONITOR_MEETING_URL      — meeting-agent base URL (default 127.0.0.1:8781)
#   ONEESAMA_MONITOR_AUDIT_WINDOW     — audit window (default 3h)
#   ONEESAMA_TRIAGE_QUALITY_WINDOW    — quality sweep window (defaults to audit window)
#   ONEESAMA_STATUS_REPORT_TRIAGE_BENCHMARK — set to 1 to run live fixture benchmark
#   ONEESAMA_TRIAGE_BENCHMARK_FIXTURES — fixture glob (default internal/slackagent/testdata/triage_benchmark/*.json)
#   ONEESAMA_TRIAGE_BENCHMARK_TIMEOUT — fixture benchmark timeout (default 10m)
#   ONEESAMA_STATUS_REPORT_OUTPUT_DIR — output dir for shared artifacts (default mktemp)
#
# Outputs:
#   <output_dir>/monitor-result.json          ← written by oneesama-monitor.sh
#   <output_dir>/triage-quality-result.json   ← written by oneesama-triage-quality-sweep.sh
#   <output_dir>/triage-benchmark-fixtures.json ← optional live fixture benchmark report
#   <output_dir>/status-report.json           ← merged manifest emitted by this script
#   <output_dir>/status-report.md             ← human-readable summary
#   stdout                                    ← short ok / red one-liner
#
# Exit code: 0 if both scripts ok; 1 if either red; 2 on usage / missing dep.

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "oneesama-status-report: missing required command: $1" >&2
    exit 2
  }
}

need jq
need date

script_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="${ONEESAMA_STATUS_REPORT_OUTPUT_DIR:-$(mktemp -d -t oneesama-status-XXXXXX)}"
mkdir -p "$output_dir"

export ONEESAMA_STATUS_OUTPUT_DIR="$output_dir"

monitor_status="unknown"
sweep_status="unknown"
benchmark_status="skipped"

if "${script_dir}/oneesama-monitor.sh"; then
  monitor_status="ok"
else
  monitor_status="red"
fi

if "${script_dir}/oneesama-triage-quality-sweep.sh"; then
  sweep_status="ok"
else
  sweep_status="red"
fi

benchmark_json="${output_dir}/triage-benchmark-fixtures.json"
if [[ "${ONEESAMA_STATUS_REPORT_TRIAGE_BENCHMARK:-0}" == "1" ]]; then
  benchmark_fixtures="${ONEESAMA_TRIAGE_BENCHMARK_FIXTURES:-internal/slackagent/testdata/triage_benchmark/*.json}"
  benchmark_timeout="${ONEESAMA_TRIAGE_BENCHMARK_TIMEOUT:-10m}"
  if (cd "${script_dir}/.." && go run ./cmd/oneesama-triage-benchmark \
    --slack-url "${ONEESAMA_MONITOR_SLACK_URL:-http://127.0.0.1:8780}" \
    --fixture "${benchmark_fixtures}" \
    --timeout "${benchmark_timeout}" \
    --output "${benchmark_json}"); then
    benchmark_status="ok"
  else
    benchmark_status="red"
  fi
fi

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

monitor_json="${output_dir}/monitor-result.json"
sweep_json="${output_dir}/triage-quality-result.json"

# Defensive: write empty stubs if a script crashed before writing its summary so
# the merge below cannot blow up with "file not found".
[[ -f "$monitor_json" ]] || echo '{}' >"$monitor_json"
[[ -f "$sweep_json" ]] || echo '{}' >"$sweep_json"
[[ -f "$benchmark_json" ]] || jq -n --arg status "$benchmark_status" '{status: $status}' >"$benchmark_json"

overall_status="ok"
if [[ "$monitor_status" != "ok" || "$sweep_status" != "ok" || "$benchmark_status" == "red" ]]; then
  overall_status="red"
fi

jq -n \
  --arg generated_at "$generated_at" \
  --arg overall_status "$overall_status" \
  --arg benchmark_status "$benchmark_status" \
  --slurpfile monitor "$monitor_json" \
  --slurpfile sweep "$sweep_json" \
  --slurpfile benchmark "$benchmark_json" \
  '{
    schema: "oneesama.status-report.v1",
    generated_at: $generated_at,
    overall_status: $overall_status,
    monitor: ($monitor[0] // {}),
    triage_quality: ($sweep[0] // {}),
    triage_benchmark: (($benchmark[0] // {}) + {status: $benchmark_status})
  }' >"${output_dir}/status-report.json"

{
  echo "# Oneesama status report"
  echo
  echo "- generated_at: ${generated_at}"
  echo "- overall_status: ${overall_status}"
  echo "- monitor_status: ${monitor_status}"
  echo "- triage_quality_status: ${sweep_status}"
  echo "- triage_benchmark_status: ${benchmark_status}"
  echo
  echo "## Monitor findings"
  jq -r '
    "- script: \(.script // "n/a")",
    "- status: \(.status // "n/a")",
    "- window: \(.window // "n/a")",
    "- slack_url: \(.checks.slack_url // "n/a")",
    "- meeting_url: \(.checks.meeting_url // "n/a")",
    "- persona_provider: \(.checks.persona_provider // "n/a")",
    "- persona_mode: \(.checks.persona_mode // "n/a")",
    "- red_flags:",
    (.red_flags // [] | map("  - " + .) | .[]),
    "- persona_foreground_context:",
    (.persona_foreground_context // [] | map("  - " + .) | .[])
  ' <"$monitor_json"
  echo
  echo "## Triage quality findings"
  jq -r '
    "- script: \(.script // "n/a")",
    "- status: \(.status // "n/a")",
    "- window: \(.window // "n/a")",
    "- cutoff: \(.cutoff // "n/a")",
    "- totals: runs=\(.totals.runs // 0) failed=\(.totals.failed // 0) mutations=\(.totals.mutations // 0) no_action=\(.totals.noAction // 0)",
    "- red.failures: \(.red.failures // [] | length)",
    "- red.invalid_persona_json: \(.red.invalidPersonaJSON // [] | length)",
    "- red.placeholder_summaries: \(.red.placeholderSummaries // [] | length)",
    "- review.high_context_no_action: \(.review.highContextNoAction // [] | length)",
    "- review.link_context_no_action: \(.review.linkContextNoAction // [] | length)",
    "- review.low_confidence_no_action: \(.review.lowConfidenceNoAction // [] | length)"
  ' <"$sweep_json"
  echo
  echo "## Triage benchmark fixtures"
  jq -r '
    "- status: \(.status // "n/a")",
    "- mode: \(.mode // "n/a")",
    "- fixtures: \(.fixtures // [] | length)",
    "- fixture_passes: \(.summary.fixturePasses // 0)",
    "- fixture_failures: \(.summary.fixtureFailures // 0)",
    "- errors: \(.summary.errors // 0)"
  ' <"$benchmark_json"
} >"${output_dir}/status-report.md"

echo "oneesama-status-report: overall_status=${overall_status} output_dir=${output_dir}"

if [[ "$overall_status" != "ok" ]]; then
  exit 1
fi
