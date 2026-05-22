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
dynamic_context_freshness_skew="$(jq -r '.audit.qualityThresholds.dynamicContextFreshnessSkewSeconds // 300' <"${tmpdir}/audit.json")"
# task #285 follow-up: canonical EN+ZH marker list lives in
# internal/slackagent/triage_quality_buckets.go.
# triageQualityIntentActionMismatchMarkers. The audit endpoint exposes it via
# audit.qualityThresholds.intentActionMismatchSummaryMarkers; servers older
# than the #285 follow-up will not have it, so we fall back to a compact
# in-script list mirroring the same EN+ZH set.
intent_action_markers="$(jq -c '((.audit.qualityThresholds.intentActionMismatchSummaryMarkers // []) + ["delegate","will reply","will react","will post","should reply","should react","should delegate","should post","plan to","going to","应该回复","应该委托","应该反应","应该跟进","需要回复","需要委托","需要跟进","建议回复","建议委托","打算回复","打算委托","会回复","会委托","要回复","要委托","应当回复","应当委托"]) | unique' <"${tmpdir}/audit.json")"
# Same negation/historical markers triageQualityIntentActionMismatchMatch
# uses in Go; presence of any anywhere in the summary suppresses the bucket
# so "已被 X 回复" / "没有需要回复" do not false-positive trip a match.
intent_action_negations='["no need","no further action","not needed","not be delegated","not delegated","should not","do not","does not","not to","stay silent","would be intrusive","would be noise","无需","不需","无须","没有","已被","已由","已经","已回复","已反应","不再","不必"]'
# Task #285 follow-up #3: handled-by-other markers demote no-action runs from
# review (operator-attention needed) to info (record-keeping only). Canonical
# list lives in internal/slackagent/triage_quality_buckets.go via
# triageQualityHandledByOtherMarkers; the audit endpoint exposes it via
# audit.qualityThresholds.handledByOtherSummaryMarkers. Inline fallback for
# pre-follow-up servers mirrors the same EN+ZH compound set.
handled_by_other_markers="$(jq -c '((.audit.qualityThresholds.handledByOtherSummaryMarkers // []) + ["already answered","already responded","already replied","already acknowledged","already addressed","already implemented","already been answered","already been fully handled","already deeply handled","already handled","already handles","already on it","already active","already started reviewing","already joined","already executed","already merged","already resolved","already confirmed","actively handled","already being handled","being actively handled","being handled by","being investigated and resolved","being investigated","was already handled","is being handled","is already being handled","active agent","active codex","active claude","already complied","has opened a session","has already opened","has already been answered","has already responded","has already been fully handled","has already complied","no actionable remainder","已经查了","已经由","已经被充分分析","已被回复","已被处理","已被解决","已被直接回复","已被直接处理","已由 codex","已由 claude","已经回复","已经处理","已经解决","已经确认","已经接手","正在处理","正在跟进","正在被处理","问题已被","已在 msg_ts","已在线程"]) | unique' <"${tmpdir}/audit.json")"
handled_by_other_negations="$(jq -c '((.audit.qualityThresholds.handledByOtherSummaryNegations // []) + ["no idea","not sure","don'\''t know","doesn'\''t know","nobody knows","unknown who","unclear who","不认识","不知道","不清楚","搞不清","没人知道","无人知道","还没确定"]) | unique' <"${tmpdir}/audit.json")"
harness_rollup="$(jq -c '.audit.harness // {}' <"${tmpdir}/audit.json")"

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
  def epoch($value):
    (($value // "") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601? // 0);
  def absnum:
    if . < 0 then -. else . end;
  def dynamic_required_kinds($run):
    ["current_time"]
    + (if (($run.metadata.workspace_policy_configured // false) or (($run.metadata.workspace_triage_policy // "") != "")) then ["workspace_triage_policy"] else [] end)
    + (if ((($run.metadata.workspace_custom_emoji // []) | length) > 0) then ["workspace_custom_emoji"] else [] end);
  def dynamic_envelope($run; $kind):
    [($run.metadata.persona_dynamic_context // [])[]? | select((.kind // "") == $kind)] | first // null;
  def dynamic_context_issue($run):
    (($run.metadata.persona_dynamic_context_expected // false) == true)
    and (
      (dynamic_required_kinds($run) as $required | any($required[]; dynamic_envelope($run; .) == null))
      or (
        dynamic_required_kinds($run) as $required
        | any($required[]; (dynamic_envelope($run; .)) as $env
            | $env != null
            and (
              (($env.source // "") == "")
              or (($env.version // "") == "")
              or (($env.freshness // "") == "")
              or (($env.cache_policy // "") != "dynamic_not_stable_prefix")
            )
          )
      )
      or (
        (epoch($run.timestamp)) as $run_epoch
        | dynamic_required_kinds($run) as $required
        | any($required[]; (dynamic_envelope($run; .)) as $env
            | $env != null
            and (
              (epoch($env.freshness) == 0)
              or (((epoch($env.freshness) - $run_epoch) | absnum) > $dynamic_skew)
            )
          )
      )
    );
  def retry_scheduled_failure($run):
    (($run.metadata.triage_timeout_needs_retry // false)
      or ($run.metadata.triage_empty_final_needs_retry // false)
      or ($run.metadata.persona_foreground_orphan_needs_retry // false));
  def fresh_pending_run($run):
    (($run.status // "") | test("^(pending|in_progress)$"; "i"))
    and ((now - epoch($run.timestamp)) < 180);
  # task #285 follow-up (driver 2h sweep 2026-05-21 15:00): a no-action
  # run that is actually a delegate_worker call with a non-empty
  # worker_requests list does NOT belong in the narrative
  # summary_intent_action_mismatch bucket. The operator triple here is
  # (worker_requests, jobId, delivery_status) — different from the
  # narrative bucket has (summary, marker). Classifier mirrors
  # triageQualityRunDelegateNoVisibleAction in
  # internal/slackagent/triage_quality_buckets.go.
  def is_delegate_no_visible_action($run):
    is_no_action($run)
    and (meta($run; "persona_foreground").decision == "delegate_worker")
    and (((meta($run; "persona_foreground").worker_requests // []) | length) > 0);
  def delegate_job_id($run):
    ([($run.tool_calls // [])[] | select(.tool == "agent_runner" and .action == "delegate_worker") | (.args // "")] | first // "")
    | . as $args
    | (try ($args | fromjson | (.jobId // .job_id // "") | tostring) catch "") as $json_id
    | if $json_id != "" then $json_id
      else
        (try ($args | capture("\"jobId\"\\s*:\\s*\"(?<id>[^\"]+)\"").id) catch "") as $camel_id
        | if $camel_id != "" then $camel_id
          else (try ($args | capture("\"job_id\"\\s*:\\s*\"(?<id>[^\"]+)\"").id) catch "")
          end
      end;
  def delegate_delivery_status($run):
    (delegate_job_id($run)) as $jid
    | if $jid == "" then "no_visible_job_id"
      elif (($run.metadata.delegate_worker_failures // 0) > 0) then "delegate_failed_in_run"
      elif (($run.metadata.delegate_worker_jobs_started // 0) == 0) then "delegate_not_started_in_run"
      else "delegate_started_pending_worker_audit"
      end;
  def is_delegate_started_pending_worker_audit($run):
    is_delegate_no_visible_action($run)
    and (delegate_delivery_status($run) == "delegate_started_pending_worker_audit");
  def handled_by_other($run):
    (.summary // "") as $raw
    | ($raw | ascii_downcase) as $haystack
    | ((any(($handled_negations // [])[]; (. | ascii_downcase) as $neg | $haystack | contains($neg))) | not)
    and ((($handled // []) | length) > 0)
    and (
      ($handled // []) as $needles
      | any($needles[]; (. | ascii_downcase) as $needle | $haystack | contains($needle))
    );
  def slack_mentions($text):
    [
      ($text // "")
      | scan("<@([A-Z0-9]+)(?:\\|[^>]+)?>")
      | if type == "array" then .[0] else . end
    ];
  def slack_activity_text($run):
    (($run.digest // "") | split("Fetched Slack thread context:")[0] // "");
  def slack_thread_text($run):
    (($run.digest // "") | split("Fetched Slack thread context:") | if length > 1 then .[1] else "" end);
  def slack_activity_mentioned_user_ids($run):
    [
      slack_activity_text($run)
      | split("\n")[]
      | select(contains(">: \""))
      | split(">: \"")[1]
      | slack_mentions(.)[]
    ] | unique;
  def slack_thread_speaker_count($run; $user_id):
    [
      slack_thread_text($run)
      | split("\n")[]
      | select(contains(">: \""))
      | select((split(">: \"")[0]) as $prefix | ($prefix | contains("<@" + $user_id)))
    ] | length;
  def directed_to_active_agent($run):
    is_no_action($run)
    and (
      [
        slack_activity_mentioned_user_ids($run)[]
        | select(slack_thread_speaker_count($run; .) > 0)
      ] | length
    ) > 0;
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
      harness: $harness,
      totals: {
        runs: ($runs | length),
        failed: ($runs | map(select(.status != "ok")) | length),
        mutations: ($runs | map(select((.mutations // 0) > 0)) | length),
        noAction: ($runs | map(select(is_no_action(.))) | length)
      },
      red: {
        failures: ($runs | map(select(.status != "ok" and (retry_scheduled_failure(.) | not) and (fresh_pending_run(.) | not)) | brief(.))),
        invalidPersonaJSON: ($runs | map(select(((.summary // "") + " " + (.error // "")) | test("not valid persona JSON|invalid persona JSON"; "i")) | brief(.))),
        placeholderSummaries: ($runs | map(select(((.summary // "") | test("short reason for the shadow decision|placeholder"; "i")) or ((.summary // "") | test("\\bTODO\\b"))) | brief(.)))
      },
      info: {
        retryScheduledFailures: (
          $runs | map(select(.status != "ok" and retry_scheduled_failure(.)) | brief(.))
        ),
        freshPendingRuns: (
          $runs | map(select(fresh_pending_run(.)) | brief(.))
        ),
        handledByOtherNoAction: (
          $runs
          | map(
              select(
                is_no_action(.)
                and (directed_to_active_agent(.) | not)
                and handled_by_other(.)
              )
              | brief(.)
            )
        ),
        directedToActiveAgentNoAction: (
          $runs
          | map(select(directed_to_active_agent(.)) | brief(.))
        ),
        delegateStartedPendingWorkerAudit: (
          $runs
          | map(
              select(is_delegate_started_pending_worker_audit(.))
              | brief(.) + {
                  workerRequests: ((meta(.; "persona_foreground").worker_requests // []) | map(. | tostring | .[0:200])),
                  jobId: delegate_job_id(.),
                  deliveryStatus: delegate_delivery_status(.)
                }
            )
        )
      },
      review: {
        dynamicContextIssue: (
          $runs
          | map(select(is_no_action(.) and dynamic_context_issue(.)) | brief(.))
        ),
        # task #285 follow-up #3: review buckets exclude runs where the
        # summary already names another agent / teammate as the handler;
        # those are info-tier (not operator-attention).
        # task #285 follow-up (driver 2h sweep 2026-05-21 15:00):
        # delegate_no_visible_action is the visibility-gap bucket — Pi
        # made a real delegation call but the audit layer cannot see
        # whether the worker started, was blocked, queued, or dropped.
        # The sample carries (worker_requests, jobId, delivery_status)
        # so an operator can decide without re-deriving from raw runs.
        delegateNoVisibleAction: (
          $runs
          | map(
              select(is_delegate_no_visible_action(.))
              | select(delegate_delivery_status(.) != "delegate_started_pending_worker_audit")
              | brief(.) + {
                  workerRequests: ((meta(.; "persona_foreground").worker_requests // []) | map(. | tostring | .[0:200])),
                  jobId: delegate_job_id(.),
                  deliveryStatus: delegate_delivery_status(.)
                }
            )
        ),
        highContextNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and (dynamic_context_issue(.) | not)
              and input_chars(.) >= $high_context
              and (is_delegate_started_pending_worker_audit(.) | not)
              and (directed_to_active_agent(.) | not)
              and (
                (handled_by_other(.) | not)
              )
            ) | brief(.)
          )
        ),
        linkContextNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and (dynamic_context_issue(.) | not)
              and external_links(.) > 0
              and (is_delegate_started_pending_worker_audit(.) | not)
              and (directed_to_active_agent(.) | not)
              and (
                (handled_by_other(.) | not)
              )
            ) | brief(.)
          )
        ),
        lowConfidenceNoAction: (
          $runs | map(
            select(
              is_no_action(.)
              and (dynamic_context_issue(.) | not)
              and ((meta(.; "persona_foreground").confidence // 1) < $low_confidence)
              and (is_delegate_started_pending_worker_audit(.) | not)
              and (directed_to_active_agent(.) | not)
              and (
                (handled_by_other(.) | not)
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
                and (dynamic_context_issue(.) | not)
                # bucket precedence: a real delegate_worker call belongs
                # in delegateNoVisibleAction, not narrative mismatch.
                and (is_delegate_no_visible_action(.) | not)
                and (is_delegate_started_pending_worker_audit(.) | not)
                and (directed_to_active_agent(.) | not)
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
                    (handled_by_other(.) | not)
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
' --arg window "$audit_window" --argjson markers "$intent_action_markers" --argjson negations "$intent_action_negations" --argjson handled "$handled_by_other_markers" --argjson handled_negations "$handled_by_other_negations" --argjson dynamic_skew "$dynamic_context_freshness_skew" --argjson harness "$harness_rollup" <"${tmpdir}/status.json" >"${tmpdir}/quality.json"

echo "oneesama-triage-quality-sweep: window=${audit_window} cutoff=${cutoff}"
jq -r '
  .harness as $h
  | "harness: pi_stable_prompt_hash=\($h.piStablePromptHash // "unknown") dynamic_context_issue=\($h.dynamicContextIssueCount // 0) delegate_no_visible_action=\($h.delegateNoVisibleActionCount // 0) handled_by_other_no_action=\($h.handledByOtherNoActionCount // 0)"
' <"${tmpdir}/quality.json"
jq -r '
  .audit.contextBudget as $budget
  | "budget: count=\($budget.count // 0) max_total_tokens=\($budget.maxTotalTokens // 0) max_stable_tokens=\($budget.maxStableTokens // 0) max_dynamic_tokens=\($budget.maxDynamicTokens // 0) max_worker_result_tokens=\($budget.maxWorkerResultTokens // 0) max_memory_evidence_tokens=\($budget.maxMemoryEvidenceTokens // 0)"
' <"${tmpdir}/audit.json"
jq -r '
  "totals: runs=\(.totals.runs) failed=\(.totals.failed) mutations=\(.totals.mutations) no_action=\(.totals.noAction)",
  "red: failures=\(.red.failures | length) invalid_persona_json=\(.red.invalidPersonaJSON | length) placeholder_summaries=\(.red.placeholderSummaries | length)",
  "review: dynamic_context_issue=\(.review.dynamicContextIssue | length) high_context_no_action=\(.review.highContextNoAction | length) link_context_no_action=\(.review.linkContextNoAction | length) low_confidence_no_action=\(.review.lowConfidenceNoAction | length) summary_intent_action_mismatch=\(.review.summaryIntentActionMismatch | length) delegate_no_visible_action=\(.review.delegateNoVisibleAction | length)",
  "info: retry_scheduled_failures=\(.info.retryScheduledFailures | length) fresh_pending=\(.info.freshPendingRuns | length) directed_to_active_agent_no_action=\(.info.directedToActiveAgentNoAction | length) handled_by_other_no_action=\(.info.handledByOtherNoAction | length) delegate_started_pending_worker_audit=\(.info.delegateStartedPendingWorkerAudit | length)"
' <"${tmpdir}/quality.json"

if jq -e '((.review.dynamicContextIssue | length) + (.review.highContextNoAction | length) + (.review.linkContextNoAction | length) + (.review.lowConfidenceNoAction | length) + (.review.summaryIntentActionMismatch | length) + (.review.delegateNoVisibleAction | length)) > 0' <"${tmpdir}/quality.json" >/dev/null; then
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
