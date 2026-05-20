#!/usr/bin/env bash
set -euo pipefail

slack_url="${ONEESAMA_MONITOR_SLACK_URL:-http://127.0.0.1:8780}"
audit_window="${ONEESAMA_TRIAGE_QUALITY_WINDOW:-${ONEESAMA_MONITOR_AUDIT_WINDOW:-3h}}"
status_limit="${ONEESAMA_TRIAGE_QUALITY_LIMIT:-200}"

# When ONEESAMA_STATUS_OUTPUT_DIR is set, a structured summary is written to
# "<dir>/triage-quality-result.json" so the unified status report wrapper can
# merge this script's findings with sibling scripts. Task #295.
status_output_dir="${ONEESAMA_STATUS_OUTPUT_DIR:-}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "oneesama-triage-quality-sweep: missing required command: $1" >&2
    exit 2
  }
}

need curl
need jq

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

curl -fsS "${slack_url}/slack/triage/audit?window=${audit_window}" >"${tmpdir}/audit.json"
curl -fsS "${slack_url}/slack/triage/status?limit=${status_limit}" >"${tmpdir}/status.json"

cutoff="$(jq -r '.audit.cutoff' <"${tmpdir}/audit.json")"
cutoff="${ONEESAMA_TRIAGE_QUALITY_AFTER:-$cutoff}"

jq --arg cutoff "$cutoff" '
  def runs:
    [.triage.runs[]? | select((.timestamp // "") >= $cutoff)];
  def meta($run; $key):
    ($run.metadata[$key] // empty);
  def input_chars($run):
    (meta($run; "input_context_chars") // 0);
  def external_links($run):
    (meta($run; "external_links_fetched") // 0);
  def actions_count($run):
    (($run.actions // []) | length);
  def is_no_action($run):
    (($run.mutations // 0) == 0 and actions_count($run) == 0);
  def brief($run):
    {
      id: $run.id,
      at: $run.timestamp,
      channels: ($run.channels // []),
      status: $run.status,
      summary: (($run.summary // "") | gsub("\n"; " ") | .[0:240]),
      inputContextChars: input_chars($run),
      externalLinksFetched: external_links($run),
      skipReasonBucket: (meta($run; "skip_reason_bucket") // null),
      personaDecision: (meta($run; "persona_foreground").decision // null),
      personaConfidence: (meta($run; "persona_foreground").confidence // null),
      personaReason: ((meta($run; "persona_foreground").reason // "") | gsub("\n"; " ") | .[0:240])
    };
  runs as $runs
  | {
      window: $ARGS.named.window,
      cutoff: $cutoff,
      totals: {
        runs: ($runs | length),
        failed: ($runs | map(select(.status != "ok")) | length),
        mutations: ($runs | map(select((.mutations // 0) > 0)) | length),
        noAction: ($runs | map(select(is_no_action(.))) | length)
      },
      red: {
        failures: ($runs | map(select(.status != "ok") | brief(.))),
        invalidPersonaJSON: ($runs | map(select(((.summary // "") + " " + (.error // "")) | test("not valid persona JSON|invalid persona JSON"; "i")) | brief(.))),
        placeholderSummaries: ($runs | map(select((.summary // "") | test("short reason for the shadow decision|placeholder|TODO"; "i")) | brief(.)))
      },
      review: {
        highContextNoAction: ($runs | map(select(is_no_action(.) and input_chars(.) >= 7000) | brief(.))),
        linkContextNoAction: ($runs | map(select(is_no_action(.) and external_links(.) > 0) | brief(.))),
        lowConfidenceNoAction: ($runs | map(select(is_no_action(.) and ((meta(.; "persona_foreground").confidence // 1) < 0.75)) | brief(.)))
      }
    }
' --arg window "$audit_window" <"${tmpdir}/status.json" >"${tmpdir}/quality.json"

echo "oneesama-triage-quality-sweep: window=${audit_window} cutoff=${cutoff}"
jq -r '
  "totals: runs=\(.totals.runs) failed=\(.totals.failed) mutations=\(.totals.mutations) no_action=\(.totals.noAction)",
  "red: failures=\(.red.failures | length) invalid_persona_json=\(.red.invalidPersonaJSON | length) placeholder_summaries=\(.red.placeholderSummaries | length)",
  "review: high_context_no_action=\(.review.highContextNoAction | length) link_context_no_action=\(.review.linkContextNoAction | length) low_confidence_no_action=\(.review.lowConfidenceNoAction | length)"
' <"${tmpdir}/quality.json"

if jq -e '((.review.highContextNoAction | length) + (.review.linkContextNoAction | length) + (.review.lowConfidenceNoAction | length)) > 0' <"${tmpdir}/quality.json" >/dev/null; then
  echo "oneesama-triage-quality-sweep: review candidates:" >&2
  jq -r '
    .review
    | to_entries[]
    | select(.value | length > 0)
    | "## \(.key)\n" + (.value[0:10] | map("- \(.at) \(.channels | join(",")) id=\(.id) summary=\(.summary)") | join("\n"))
  ' <"${tmpdir}/quality.json" >&2
fi

write_status_summary() {
  local status="$1"
  if [[ -z "$status_output_dir" ]]; then
    return 0
  fi
  mkdir -p "$status_output_dir"
  jq --arg script "oneesama-triage-quality-sweep" --arg status "$status" \
    '. + {script: $script, status: $status}' <"${tmpdir}/quality.json" >"${status_output_dir}/triage-quality-result.json"
}

if jq -e '((.red.failures | length) + (.red.invalidPersonaJSON | length) + (.red.placeholderSummaries | length)) > 0' <"${tmpdir}/quality.json" >/dev/null; then
  echo "oneesama-triage-quality-sweep: red quality samples:" >&2
  jq -r '
    .red
    | to_entries[]
    | select(.value | length > 0)
    | "## \(.key)\n" + (.value | map("- \(.at) \(.channels | join(",")) id=\(.id) summary=\(.summary)") | join("\n"))
  ' <"${tmpdir}/quality.json" >&2
  write_status_summary "red"
  exit 1
fi

write_status_summary "ok"
echo "oneesama-triage-quality-sweep: ok"
