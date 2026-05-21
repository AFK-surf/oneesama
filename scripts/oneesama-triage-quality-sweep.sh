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

# Read the per-run quality bucket thresholds from the live audit response so
# this script and internal/slackagent/triage_quality_buckets.go stay in sync.
# Defaults match triageQualityHighContextInputCharsThreshold = 7000 and
# triageQualityLowConfidenceCeiling = 0.75 in case the server is older than
# task #285 and does not yet emit the qualityThresholds block.
high_context_threshold="$(jq -r '.audit.qualityThresholds.highContextInputChars // 7000' <"${tmpdir}/audit.json")"
low_confidence_ceiling="$(jq -r '.audit.qualityThresholds.lowConfidenceCeiling // 0.75' <"${tmpdir}/audit.json")"
# task #285 follow-up: canonical EN+ZH marker list lives in
# internal/slackagent/triage_quality_buckets.go.
# triageQualityIntentActionMismatchMarkers. The audit endpoint exposes it via
# audit.qualityThresholds.intentActionMismatchSummaryMarkers; servers older
# than the #285 follow-up will not have it, so we fall back to a compact
# in-script list mirroring the same EN+ZH set.
intent_action_markers="$(jq -c '.audit.qualityThresholds.intentActionMismatchSummaryMarkers // ["delegate","will reply","will react","will post","should reply","should react","should delegate","should post","plan to","going to","应该回复","应该委托","应该反应","应该跟进","需要回复","需要委托","需要跟进","建议回复","建议委托","打算回复","打算委托","会回复","会委托","要回复","要委托","应当回复","应当委托"]' <"${tmpdir}/audit.json")"
# Same negation/historical markers triageQualityIntentActionMismatchMatch
# uses in Go; presence of any anywhere in the summary suppresses the bucket
# so "已被 X 回复" / "没有需要回复" do not false-positive trip a match.
intent_action_negations='["无需","不需","无须","没有","已被","已由","已经","已回复","已反应","不再","不必"]'
# Task #285 follow-up #3: handled-by-other markers demote no-action runs from
# review (operator-attention needed) to info (record-keeping only). Canonical
# list lives in internal/slackagent/triage_quality_buckets.go via
# triageQualityHandledByOtherMarkers; the audit endpoint exposes it via
# audit.qualityThresholds.handledByOtherSummaryMarkers. Inline fallback for
# pre-follow-up servers mirrors the same EN+ZH compound set.
handled_by_other_markers="$(jq -c '.audit.qualityThresholds.handledByOtherSummaryMarkers // ["already answered","already responded","already replied","already acknowledged","already addressed","already implemented","already handled","already started reviewing","already joined","already executed","already merged","already resolved","already confirmed","actively handled","being actively handled","was already handled","is being handled","is already being handled","已被回复","已被处理","已被解决","已被直接回复","已被直接处理","已由 codex","已由 claude","已经回复","已经处理","已经解决","已经确认","已经接手","正在处理","正在跟进","正在被处理","问题已被","已在 msg_ts","已在线程"]' <"${tmpdir}/audit.json")"

jq --arg cutoff "$cutoff" --argjson high_context "$high_context_threshold" --argjson low_confidence "$low_confidence_ceiling" '
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
      thresholds: {
        highContextInputChars: $high_context,
        lowConfidenceCeiling: $low_confidence
      },
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
      info: {
        handledByOtherNoAction: (
          $runs
          | map(
              select(
                is_no_action(.)
                and ((($handled // []) | length) > 0)
                and (
                  (.summary // "" | ascii_downcase) as $haystack
                  | ($handled // []) as $needles
                  | any($needles[]; (. | ascii_downcase) as $needle | $haystack | contains($needle))
                )
              )
              | brief(.)
            )
        )
      },
      review: {
        # task #285 follow-up #3: review buckets exclude runs where the
        # summary already names another agent / teammate as the handler;
        # those are info-tier (not operator-attention).
        highContextNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and input_chars(.) >= $high_context
              and (
                ((($handled // []) | length) == 0)
                or ((.summary // "" | ascii_downcase) as $haystack | ($handled // []) as $needles | (any($needles[]; (. | ascii_downcase) as $needle | $haystack | contains($needle)) | not))
              )
            ) | brief(.)
          )
        ),
        linkContextNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and external_links(.) > 0
              and (
                ((($handled // []) | length) == 0)
                or ((.summary // "" | ascii_downcase) as $haystack | ($handled // []) as $needles | (any($needles[]; (. | ascii_downcase) as $needle | $haystack | contains($needle)) | not))
              )
            ) | brief(.)
          )
        ),
        lowConfidenceNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and ((meta(.; "persona_foreground").confidence // 1) < $low_confidence)
              and (
                ((($handled // []) | length) == 0)
                or ((.summary // "" | ascii_downcase) as $haystack | ($handled // []) as $needles | (any($needles[]; (. | ascii_downcase) as $needle | $haystack | contains($needle)) | not))
              )
            ) | brief(.)
          )
        ),
        # task #285 follow-up: summary asserts action intent (delegate / reply
        # / react / 应该 / 委托 / etc.) but actions=0 and mutations=0. Detector
        # mirrors triageQualityIntentActionMismatchMatch; if the audit
        # endpoint exposes the canonical marker list (audit.qualityThresholds
        # .intentActionMismatchSummaryMarkers, this list is fed via
        # --argjson markers) it wins, otherwise the inline fallback covers
        # pre-#285-follow-up servers.
        summaryIntentActionMismatch: (
          $runs
          | map(
              select(
                is_no_action(.)
                and ((($markers // []) | length) > 0)
                and (
                  (.summary // "") as $raw
                  | ($raw | ascii_downcase) as $haystack
                  # negation guard: any historical / negated marker in the
                  # summary suppresses the whole match.
                  | (any(($negations // [])[]; . as $neg | $raw | contains($neg)) | not)
                  # also skip runs already classified as handled-by-other
                  # info-tier; they belong in info, not review.
                  and (
                    ((($handled // []) | length) == 0)
                    or ((($handled // []) as $hand | any($hand[]; (. | ascii_downcase) as $needle | $haystack | contains($needle))) | not)
                  )
                  and (
                    ($markers // []) as $needles
                    | any($needles[]; (. | ascii_downcase) as $needle | $haystack | test($needle; "i"))
                  )
                )
              )
              | brief(.)
            )
        )
      }
    }
' --arg window "$audit_window" --argjson markers "$intent_action_markers" --argjson negations "$intent_action_negations" --argjson handled "$handled_by_other_markers" <"${tmpdir}/status.json" >"${tmpdir}/quality.json"

echo "oneesama-triage-quality-sweep: window=${audit_window} cutoff=${cutoff}"
jq -r '
  "totals: runs=\(.totals.runs) failed=\(.totals.failed) mutations=\(.totals.mutations) no_action=\(.totals.noAction)",
  "red: failures=\(.red.failures | length) invalid_persona_json=\(.red.invalidPersonaJSON | length) placeholder_summaries=\(.red.placeholderSummaries | length)",
  "review: high_context_no_action=\(.review.highContextNoAction | length) link_context_no_action=\(.review.linkContextNoAction | length) low_confidence_no_action=\(.review.lowConfidenceNoAction | length) summary_intent_action_mismatch=\(.review.summaryIntentActionMismatch | length)",
  "info: handled_by_other_no_action=\(.info.handledByOtherNoAction | length)"
' <"${tmpdir}/quality.json"

if jq -e '((.review.highContextNoAction | length) + (.review.linkContextNoAction | length) + (.review.lowConfidenceNoAction | length) + (.review.summaryIntentActionMismatch | length)) > 0' <"${tmpdir}/quality.json" >/dev/null; then
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
