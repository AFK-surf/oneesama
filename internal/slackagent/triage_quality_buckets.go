package slackagent

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

// Thresholds shared between the daily report's per-run quality bucketing
// (`computeSlackDailyReportMetrics` in daily_report.go) and the operational
// `scripts/oneesama-triage-quality-sweep.sh` jq pipeline. Centralising them
// here keeps the two surfaces from silently disagreeing on what counts as a
// "high-context no-action" or a "low-confidence no-action" run.
//
// Task #285 anchor: align daily report and triage quality sweep buckets.
// If a threshold changes, update this file AND the matching jq literal in
// scripts/oneesama-triage-quality-sweep.sh in the same commit.

const (
	// triageQualityHighContextInputCharsThreshold flags a no-action run whose
	// persona request carried at least this many characters of input context.
	// A high-context no-action is a signal the persona had material to work
	// with but chose to stay silent; the daily report and the sweep both
	// surface these for human review.
	triageQualityHighContextInputCharsThreshold = 7000

	// triageQualityLowConfidenceCeiling defines the upper bound on
	// `persona_foreground.confidence` (exclusive) for a no-action run to be
	// classified as low-confidence-no-action. Below this confidence the
	// persona is hedging; the bucket exists to surface "Pi was unsure and
	// silently dropped" runs for human review.
	triageQualityLowConfidenceCeiling = 0.75

	// triageQualityDynamicContextFreshnessSkew flags dynamic envelopes whose
	// freshness timestamp is too far away from the triage run timestamp.
	// Dynamic envelopes are built with the request, so a few seconds is
	// normal; minutes of skew means stale or replayed context.
	triageQualityDynamicContextFreshnessSkew = 5 * time.Minute
)

var triageQualityRequiredDynamicContextKinds = []string{"current_time"}

type triageQualityDynamicContextIssue struct {
	MissingKinds    []string
	IncompleteKinds []string
	StaleKinds      []string
	Details         []string
}

type triageQualityDynamicContextEnvelope struct {
	Kind         string
	Source       string
	Version      string
	Freshness    string
	CachePolicy  string
	ContentChars int
}

func triageQualityRunDynamicContextIssue(run SlackTriageContext) (triageQualityDynamicContextIssue, bool) {
	if !boolFromAny(run.Metadata["persona_dynamic_context_expected"], false) {
		return triageQualityDynamicContextIssue{}, false
	}
	required := triageQualityRequiredDynamicContextKindsForRun(run)
	envelopes := triageQualityDynamicContextEnvelopesFromAny(run.Metadata["persona_dynamic_context"])
	byKind := make(map[string]triageQualityDynamicContextEnvelope, len(envelopes))
	for _, env := range envelopes {
		if env.Kind != "" {
			byKind[env.Kind] = env
		}
	}
	out := triageQualityDynamicContextIssue{}
	runTime := parseTriageTimestamp(run.Timestamp)
	for _, kind := range required {
		env, ok := byKind[kind]
		if !ok {
			out.MissingKinds = append(out.MissingKinds, kind)
			out.Details = append(out.Details, kind+":missing")
			continue
		}
		if incompleteReason := triageQualityDynamicContextIncompleteReason(env); incompleteReason != "" {
			out.IncompleteKinds = append(out.IncompleteKinds, kind)
			out.Details = append(out.Details, kind+":"+incompleteReason)
		}
		if staleReason := triageQualityDynamicContextStaleReason(env, runTime); staleReason != "" {
			out.StaleKinds = append(out.StaleKinds, kind)
			out.Details = append(out.Details, kind+":"+staleReason)
		}
	}
	return out, len(out.MissingKinds)+len(out.IncompleteKinds)+len(out.StaleKinds) > 0
}

func triageQualityRequiredDynamicContextKindsForRun(run SlackTriageContext) []string {
	required := append([]string(nil), triageQualityRequiredDynamicContextKinds...)
	if boolFromAny(run.Metadata["workspace_policy_configured"], false) || stringFromAny(run.Metadata["workspace_triage_policy"]) != "" {
		required = append(required, "workspace_triage_policy")
	}
	if lenStringSliceFromAny(run.Metadata["workspace_custom_emoji"]) > 0 {
		required = append(required, "workspace_custom_emoji")
	}
	return required
}

func triageQualityDynamicContextIncompleteReason(env triageQualityDynamicContextEnvelope) string {
	switch {
	case strings.TrimSpace(env.Source) == "":
		return "missing_source"
	case strings.TrimSpace(env.Version) == "":
		return "missing_version"
	case strings.TrimSpace(env.Freshness) == "":
		return "missing_freshness"
	case strings.TrimSpace(env.CachePolicy) != persona.DynamicContextCachePolicyNotStablePrefix:
		return "wrong_cache_policy"
	default:
		return ""
	}
}

func triageQualityDynamicContextStaleReason(env triageQualityDynamicContextEnvelope, runTime time.Time) string {
	if runTime.IsZero() {
		return ""
	}
	freshness := parseTriageTimestamp(env.Freshness)
	if freshness.IsZero() {
		return "invalid_freshness"
	}
	delta := freshness.Sub(runTime)
	if delta < 0 {
		delta = -delta
	}
	if delta > triageQualityDynamicContextFreshnessSkew {
		return "freshness_skew"
	}
	return ""
}

func triageQualityDynamicContextEnvelopesFromAny(value any) []triageQualityDynamicContextEnvelope {
	switch typed := value.(type) {
	case []triageQualityDynamicContextEnvelope:
		return append([]triageQualityDynamicContextEnvelope(nil), typed...)
	case []map[string]any:
		out := make([]triageQualityDynamicContextEnvelope, 0, len(typed))
		for _, item := range typed {
			out = append(out, triageQualityDynamicContextEnvelopeFromMap(item))
		}
		return out
	case []any:
		out := make([]triageQualityDynamicContextEnvelope, 0, len(typed))
		for _, item := range typed {
			if mapped, ok := mapFromAny(item); ok {
				out = append(out, triageQualityDynamicContextEnvelopeFromMap(mapped))
			}
		}
		return out
	default:
		return nil
	}
}

func triageQualityDynamicContextEnvelopeFromMap(item map[string]any) triageQualityDynamicContextEnvelope {
	return triageQualityDynamicContextEnvelope{
		Kind:         stringFromAny(item["kind"]),
		Source:       stringFromAny(item["source"]),
		Version:      stringFromAny(item["version"]),
		Freshness:    stringFromAny(item["freshness"]),
		CachePolicy:  stringFromAny(item["cache_policy"]),
		ContentChars: intFromAny(item["content_chars"]),
	}
}

// triageQualityIntentActionMismatchMarkers are case-insensitive substrings
// indicating the run's `summary` text claims an intent to act
// (delegate / reply / react / etc.) even though the run ended with
// `actions=0` AND `mutations=0`. The bucket exists to surface "model said it
// would but actually did nothing" runs for human review without classifying
// them as red — many such runs are model self-narration of historical
// behaviour, but a recurring spike is a signal the action wiring is broken.
//
// Markers are intentionally compound phrases. Bare single-word ZH markers
// like `回复` / `需要` / `应该` were too wide: they false-positive on
// historical / negated phrases such as `已被 ... 回复` / `没有需要回复`
// (driver false-positive report 2026-05-21 on the initial cut).
//
// Task #285 follow-up (driver 6h audit 2026-05-21 review proposal +
// false-positive tightening).
var triageQualityIntentActionMismatchMarkers = []string{
	// English action verbs the persona uses in summary narration.
	"delegate",
	"will reply",
	"will react",
	"will post",
	"should reply",
	"should react",
	"should delegate",
	"should post",
	"plan to",
	"going to",
	// Chinese compound phrases. Avoid bare single-word markers so historical
	// / negated narration (`已被 X 回复` / `没有需要回复`) does not trip the
	// bucket; the negation guard below catches the remaining edge cases.
	"应该回复",
	"应该委托",
	"应该反应",
	"应该跟进",
	"需要回复",
	"需要委托",
	"需要跟进",
	"建议回复",
	"建议委托",
	"打算回复",
	"打算委托",
	"会回复",
	"会委托",
	"要回复",
	"要委托",
	"应当回复",
	"应当委托",
}

// triageQualityIntentActionMismatchNegations are substrings that, when
// present anywhere in the summary, suppress the mismatch bucket entirely.
// They flag "the run is describing historical / already-handled / negated
// state" rather than asserting an unrealised intent.
//
// Example trip the original cut: `没有明确问题或需要回复...无需介入`
// substring-matched `需要回复` even though the surrounding `没有 ... 或` /
// `无需` negates it. Rather than try to track negation scope statically,
// treat the whole summary as descriptive when any of these negation /
// historical markers appear.
var triageQualityIntentActionMismatchNegations = []string{
	"no need",
	"no further action",
	"not needed",
	"not be delegated",
	"not delegated",
	"should not",
	"do not",
	"does not",
	"not to",
	"stay silent",
	"would be intrusive",
	"would be noise",
	"无需",
	"不需",
	"无须",
	"没有",
	"已被",
	"已由",
	"已经",
	"已回复",
	"已反应",
	"不再",
	"不必",
}

// triageQualityDelegateNoVisibleAction holds the evidence extracted from a
// no-action run whose `persona_foreground.decision` is `delegate_worker`
// and that carries a non-empty `worker_requests` list. These runs land in
// their own review bucket (separate from `summary_intent_action_mismatch`)
// because the failure mode is different — Pi correctly requested
// delegation, but the audit layer cannot see whether the downstream job
// actually started, was blocked by policy, is still queued, or silently
// dropped. Operator needs the worker_requests + job_id + delivery_status
// triple to decide. Task #285 follow-up (driver 2h sweep 2026-05-21 15:00
// review proposal).
type triageQualityDelegateNoVisibleAction struct {
	WorkerRequests []string
	JobID          string
	DeliveryStatus string
}

// triageQualityRunDelegateNoVisibleAction returns the extracted evidence
// when the run matches the bucket conditions, or ok=false when it does
// not. Conditions (caller must have already filtered actions=[] +
// mutations=0):
//
//   - metadata.persona_foreground.decision == "delegate_worker"
//   - metadata.persona_foreground.worker_requests is non-empty
//
// This bucket takes precedence over intent_action_mismatch because the
// evidence triple is different (and the user-visible failure shape is
// different).
func triageQualityRunDelegateNoVisibleAction(run SlackTriageContext) (triageQualityDelegateNoVisibleAction, bool) {
	out := triageQualityDelegateNoVisibleAction{}
	raw, ok := mapFromAny(run.Metadata["persona_foreground"])
	if !ok {
		return out, false
	}
	if strings.TrimSpace(stringFromAny(raw["decision"])) != "delegate_worker" {
		return out, false
	}
	requests := triageQualityStringSliceFromAny(raw["worker_requests"])
	if len(requests) == 0 {
		return out, false
	}
	out.WorkerRequests = requests
	out.JobID = triageQualityExtractDelegateJobID(run.ToolCalls)
	out.DeliveryStatus = triageQualityDelegateDeliveryStatus(run, out.JobID)
	return out, true
}

// triageQualityStringSliceFromAny mirrors the test-only stringSliceFromAny
// helper, scoped here so production triage code can pull worker_requests
// from the persona_foreground metadata blob without taking a dependency on
// the test file.
func triageQualityStringSliceFromAny(value any) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, s := range typed {
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			s := strings.TrimSpace(stringFromAny(item))
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// triageQualityExtractDelegateJobID scans the run's tool_calls for the
// agent_runner / delegate_worker tool-call and pulls `jobId` out of its
// JSON args. Returns "" if no match.
func triageQualityExtractDelegateJobID(calls []SlackTriageToolCall) string {
	for _, call := range calls {
		if strings.TrimSpace(call.Tool) != "agent_runner" || strings.TrimSpace(call.Action) != "delegate_worker" {
			continue
		}
		args := strings.TrimSpace(call.Args)
		if args == "" {
			continue
		}
		jobID := triageQualityExtractDelegateJobIDFromArgs(args)
		if jobID == "" {
			continue
		}
		return jobID
	}
	return ""
}

func triageQualityDelegateNeedsOperatorReview(evidence triageQualityDelegateNoVisibleAction) bool {
	switch strings.TrimSpace(evidence.DeliveryStatus) {
	case "delegate_started_pending_worker_audit":
		return false
	default:
		return true
	}
}

func triageQualityExtractDelegateJobIDFromArgs(args string) string {
	args = strings.TrimSpace(args)
	if args == "" {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(args), &payload); err == nil {
		if jobID := strings.TrimSpace(stringFromAny(payload["jobId"])); jobID != "" {
			return jobID
		}
		if jobID := strings.TrimSpace(stringFromAny(payload["job_id"])); jobID != "" {
			return jobID
		}
	}
	// Tolerate legacy compact string snippets if the args blob was not valid JSON.
	for _, marker := range []string{`"jobId":"`, `"job_id":"`} {
		idx := strings.Index(args, marker)
		if idx < 0 {
			continue
		}
		rest := args[idx+len(marker):]
		end := strings.Index(rest, `"`)
		if end < 0 {
			continue
		}
		return strings.TrimSpace(rest[:end])
	}
	return ""
}

// triageQualityDelegateDeliveryStatus encodes what the audit layer can
// observe about the requested delegation without crossing into worker
// runtime internals. Today the persona_foreground metadata carries the
// minimum we need; richer status (deliveredToSlack / finalReply present)
// requires a worker_reports cross-reference and is left to a follow-up.
func triageQualityDelegateDeliveryStatus(run SlackTriageContext, jobID string) string {
	if jobID == "" {
		return "no_visible_job_id"
	}
	if intFromAny(run.Metadata["delegate_worker_failures"]) > 0 {
		return "delegate_failed_in_run"
	}
	started := intFromAny(run.Metadata["delegate_worker_jobs_started"])
	if started == 0 {
		return "delegate_not_started_in_run"
	}
	return "delegate_started_pending_worker_audit"
}

// triageQualityIntentActionMismatchMatch returns the first marker that
// triggered the bucket so callers can record it in the review sample for
// operator clarity. Returns empty string when no marker is present, the
// summary is empty, or any negation / historical marker appears anywhere in
// the summary.
func triageQualityIntentActionMismatchMatch(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return ""
	}
	for _, neg := range triageQualityIntentActionMismatchNegations {
		if strings.Contains(s, neg) {
			return ""
		}
	}
	lower := strings.ToLower(s)
	for _, marker := range triageQualityIntentActionMismatchMarkers {
		needle := strings.ToLower(marker)
		if strings.Contains(lower, needle) {
			return marker
		}
	}
	return ""
}

// triageQualityHandledByOtherMarkers indicate the no-action run's summary is
// describing "another agent / teammate already handled this thread", which is
// the correct dispose for many high-context / link-context no-action runs.
// Hitting any marker demotes the run from the review tier (operator-attention
// needed) to the info tier (record-keeping only) — operators stop having to
// triage through "all 5 review candidates were handled elsewhere" sweeps.
//
// Markers are compound phrases for the same reason intent-action markers are:
// bare `已被` / `已经` / `already` etc. would false-positive on a wide range
// of historical / passive narration that has nothing to do with "another
// agent handled the thread". The 5 dispose samples driver pulled from the
// 6h sweep at 11:52 SHA are pinned as positive regression cases in
// triage_quality_buckets_test.go. Task #285 follow-up #3 (driver 6h audit
// 2026-05-21 review proposal #2: handled-by-other → info bucket).
var triageQualityHandledByOtherMarkers = []string{
	// English compound phrases observed in 6h live samples.
	"already answered",
	"already responded",
	"already replied",
	"already acknowledged",
	"already addressed",
	"already implemented",
	"already been fully handled",
	"already handled",
	"already handles",
	"already on it",
	"already active",
	"already started reviewing",
	"already joined",
	"already executed",
	"already merged",
	"already resolved",
	"already confirmed",
	"actively handled",
	"already being handled",
	"being actively handled",
	"being handled by",
	"being investigated and resolved",
	"being investigated",
	"was already handled",
	"is being handled",
	"is already being handled",
	"active agent",
	"already complied",
	"has opened a session",
	"has already opened",
	"has already responded",
	"has already been fully handled",
	"has already complied",
	// Chinese compound phrases. Same compound discipline as the
	// intent-action markers — avoid bare `已被` / `已经`.
	"已经查了",
	"已经由",
	"已经被充分分析",
	"已被回复",
	"已被处理",
	"已被解决",
	"已被直接回复",
	"已被直接处理",
	"已由 codex",
	"已由 claude",
	"已经回复",
	"已经处理",
	"已经解决",
	"已经确认",
	"已经接手",
	"正在处理",
	"正在跟进",
	"正在被处理",
	"问题已被",
	"已在 msg_ts",
	"已在线程",
}

var triageQualityHandledByOtherNegations = []string{
	"no idea",
	"not sure",
	"don't know",
	"doesn't know",
	"nobody knows",
	"unknown who",
	"unclear who",
	"不认识",
	"不知道",
	"不清楚",
	"搞不清",
	"没人知道",
	"无人知道",
	"还没确定",
}

// triageQualityRunIsHandledByOther returns the first matching marker (for
// audit / sample tagging) when the summary indicates another agent or
// teammate already handled the thread.
func triageQualityRunIsHandledByOther(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return ""
	}
	lower := strings.ToLower(s)
	for _, negation := range triageQualityHandledByOtherNegations {
		if strings.Contains(lower, strings.ToLower(negation)) {
			return ""
		}
	}
	for _, marker := range triageQualityHandledByOtherMarkers {
		needle := strings.ToLower(marker)
		if strings.Contains(lower, needle) {
			return marker
		}
	}
	return ""
}

// SlackTriageQualityBucketThresholds is the snapshot exposed via the triage
// audit endpoint so external tooling (sweep script, monitor, future
// dashboards) can read the live thresholds instead of hard-coding them.
type SlackTriageQualityBucketThresholds struct {
	HighContextInputChars              int      `json:"highContextInputChars"`
	LowConfidenceCeiling               float64  `json:"lowConfidenceCeiling"`
	DynamicContextFreshnessSkewSeconds int64    `json:"dynamicContextFreshnessSkewSeconds"`
	IntentActionMismatchSummaryMarkers []string `json:"intentActionMismatchSummaryMarkers"`
	HandledByOtherSummaryMarkers       []string `json:"handledByOtherSummaryMarkers"`
	HandledByOtherSummaryNegations     []string `json:"handledByOtherSummaryNegations"`
}

func slackTriageQualityBucketThresholds() SlackTriageQualityBucketThresholds {
	intentMarkers := append([]string(nil), triageQualityIntentActionMismatchMarkers...)
	handledMarkers := append([]string(nil), triageQualityHandledByOtherMarkers...)
	handledNegations := append([]string(nil), triageQualityHandledByOtherNegations...)
	return SlackTriageQualityBucketThresholds{
		HighContextInputChars:              triageQualityHighContextInputCharsThreshold,
		LowConfidenceCeiling:               triageQualityLowConfidenceCeiling,
		DynamicContextFreshnessSkewSeconds: int64(triageQualityDynamicContextFreshnessSkew.Seconds()),
		IntentActionMismatchSummaryMarkers: intentMarkers,
		HandledByOtherSummaryMarkers:       handledMarkers,
		HandledByOtherSummaryNegations:     handledNegations,
	}
}
