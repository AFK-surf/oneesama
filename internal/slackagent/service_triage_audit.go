package slackagent

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func (s *Service) TriageStatus(ctx context.Context, limit int) (SlackTriageStatus, error) {
	if limit <= 0 {
		limit = slackTriageStatusDefaultLimit
	}
	runs, err := s.triage.ListRuns(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	actions, err := s.triage.ListPendingActions(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	brains, err := s.cognition.ListChannelBrains(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	return SlackTriageStatus{
		Enabled:           s.InboundStatus().EventBuffer.TriageEnabled,
		PostActions:       s.triagePostActions,
		HeuristicFallback: s.triageHeuristicFallback,
		WorkspacePolicy:   s.slackWorkspacePolicyStatus(),
		LastTriageJobID:   s.InboundStatus().EventBuffer.LastTriageJobID,
		AuditFreshness:    buildSlackTriageFreshness(runs),
		AuditFixtures:     buildSlackTriageAuditFixtures(),
		EpisodeRecall:     BuildSlackEpisodeRecallStatus(ctx),
		Runs:              runs,
		PendingActions:    actions,
		ChannelBrains:     brains,
	}, nil
}

func (s *Service) TriageAudit(ctx context.Context, window time.Duration, limit int) (SlackTriageAuditReport, error) {
	if window <= 0 {
		window = slackTriageAuditDefaultWindow
	}
	if limit <= 0 {
		limit = slackTriageStatusDefaultLimit
	}
	runs, err := s.triage.ListRuns(ctx, limit)
	if err != nil {
		return SlackTriageAuditReport{}, err
	}
	actions, err := s.triage.ListPendingActions(ctx, limit)
	if err != nil {
		return SlackTriageAuditReport{}, err
	}
	report := buildSlackTriageAuditReport(runs, window, actions)
	report.ProcessHealth = s.slackTriageProcessHealth(window)
	report.PersonaRuntime = s.slackTriagePersonaRuntimeHealth(ctx)
	report.EpisodeRecall = BuildSlackEpisodeRecallStatus(ctx)
	report.Flags = buildSlackTriageAuditFlags(report)
	return report, nil
}

func buildSlackTriageAuditReport(runs []SlackTriageContext, window time.Duration, pendingActions ...[]SlackPendingAction) SlackTriageAuditReport {
	if window <= 0 {
		window = slackTriageAuditDefaultWindow
	}
	actions := []SlackPendingAction{}
	if len(pendingActions) > 0 {
		actions = pendingActions[0]
	}
	now := timeNow().UTC()
	cutoff := now.Add(-window)
	windowRuns := filterTriageRunsSince(runs, cutoff, now)
	freshness := buildSlackTriageFreshness(windowRuns)
	if freshness == nil {
		freshness = &SlackTriageFreshness{GeneratedAt: now.Format(time.RFC3339Nano)}
	}
	freshness.GeneratedAt = now.Format(time.RFC3339Nano)
	canary := buildSlackTriageCanarySummary(windowRuns)
	contextBudget := buildSlackTriageContextBudget(windowRuns)
	reviewBuckets := buildSlackTriageReviewBuckets(windowRuns, 5)
	infoBuckets := buildSlackTriageInfoBuckets(windowRuns, 5)
	replyQualitySamples := slackVisibleReplyQualitySamples(actions, windowRuns, window)
	report := SlackTriageAuditReport{
		GeneratedAt:         now.Format(time.RFC3339Nano),
		WindowSeconds:       int64(window.Seconds()),
		Cutoff:              cutoff.Format(time.RFC3339Nano),
		RunCount:            len(windowRuns),
		Freshness:           *freshness,
		Outcome:             buildSlackTriageAuditOutcome(windowRuns),
		RealOutcome:         buildSlackTriageAuditOutcome(filterSlackTriageProbeRuns(windowRuns, false)),
		ProbeOutcome:        buildSlackTriageAuditOutcome(filterSlackTriageProbeRuns(windowRuns, true)),
		InputContext:        buildSlackTriageInputContext(windowRuns),
		ContextBudget:       contextBudget,
		Harness:             buildSlackTriageHarnessDrift(contextBudget, reviewBuckets, infoBuckets),
		ContextFetch:        buildSlackTriageContextFetch(windowRuns),
		SkipReasons:         buildSlackTriageSkipReasons(windowRuns),
		PersonaQuality:      buildSlackTriagePersonaQuality(windowRuns),
		Canary:              canary,
		LiveProbe:           buildSlackTriageLiveProbeSummary(windowRuns),
		FailureSamples:      buildSlackTriageFailureSamples(windowRuns, 5),
		RecentRuns:          buildSlackTriageAuditRunBriefs(windowRuns, 20),
		ReplyQualitySamples: summarizeSlackVisibleReplyQualitySamples(replyQualitySamples, 10),
		VisibleReplyCanary:  buildSlackVisibleReplyAllowListCanarySummary(),
		VisibleReplyShadow:  buildSlackVisibleReplyAllowListShadowSummary(replyQualitySamples, 10),
		EpisodeRecall:       BuildSlackEpisodeRecallStatus(context.Background()),
		QualityThresholds:   slackTriageQualityBucketThresholds(),
		ReviewBuckets:       reviewBuckets,
		InfoBuckets:         infoBuckets,
	}
	report.Flags = buildSlackTriageAuditFlags(report)
	return report
}

func filterTriageRunsSince(runs []SlackTriageContext, cutoff time.Time, now time.Time) []SlackTriageContext {
	var out []SlackTriageContext
	for _, run := range runs {
		timestamp := parseTriageTimestamp(run.Timestamp)
		if timestamp.IsZero() {
			continue
		}
		timestamp = timestamp.UTC()
		if timestamp.Before(cutoff.UTC()) || timestamp.After(now.UTC()) {
			continue
		}
		out = append(out, run)
	}
	return out
}

func buildSlackTriageAuditOutcome(runs []SlackTriageContext) SlackTriageAuditOutcome {
	var outcome SlackTriageAuditOutcome
	for _, run := range runs {
		if run.Mutations > 0 {
			outcome.OutboundRuns++
		}
		if len(run.Actions) > 0 && run.Mutations == 0 {
			outcome.MaybeRuns++
		}
		if run.Mutations == 0 && len(run.Actions) == 0 {
			outcome.NoActionRuns++
		}
		outcome.Mutations += run.Mutations
		if slackTriageRunFailed(run) {
			outcome.FailedRuns++
			if slackTriageRunHasRetryScheduled(run) {
				outcome.RetryScheduledFailures++
			}
		}
		if slackTriageRunParseFallback(run) {
			outcome.ParseFallbacks++
		}
	}
	return outcome
}

func buildSlackTriageReviewBuckets(runs []SlackTriageContext, sampleLimit int) SlackTriageReviewBuckets {
	out := SlackTriageReviewBuckets{}
	if len(runs) == 0 {
		return out
	}
	ordered := append([]SlackTriageContext(nil), runs...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return parseTriageTimestamp(ordered[i].Timestamp).After(parseTriageTimestamp(ordered[j].Timestamp))
	})
	for _, run := range ordered {
		if len(run.Actions) > 0 || run.Mutations > 0 {
			continue
		}
		if _, ok := triageQualityRunRecoveredProviderFailure(run, runs); ok {
			continue
		}
		if issue, ok := triageQualityRunDynamicContextIssue(run); ok {
			out.DynamicContextIssueCount++
			if sampleLimit > 0 && len(out.DynamicContextIssueSamples) < sampleLimit {
				out.DynamicContextIssueSamples = append(out.DynamicContextIssueSamples, SlackTriageDynamicContextIssueSample{
					Timestamp:       run.Timestamp,
					RunID:           run.ID,
					Channels:        run.Channels,
					Summary:         slackTriageFailureSampleText(run.Summary),
					MissingKinds:    issue.MissingKinds,
					IncompleteKinds: issue.IncompleteKinds,
					StaleKinds:      issue.StaleKinds,
					Details:         issue.Details,
				})
			}
			continue
		}
		// Skip handled-by-other runs from review-tier sampling; they belong
		// in the info tier, not the review tier. Task #285 follow-up #3.
		if _, ok := triageQualityRunDirectedToActiveAgent(run); ok {
			continue
		}
		if triageQualityRunIsHandledByOther(run.Summary) != "" {
			continue
		}
		// Bucket precedence: a no-action run that actually requested a
		// delegate_worker (persona_foreground.decision=delegate_worker +
		// non-empty worker_requests) goes to the delegate-no-visible-action
		// bucket and is NOT also counted as a narrative
		// intent-action-mismatch. The two failure modes need different
		// operator evidence — see SlackTriageReviewBuckets doc and the
		// triage_quality_buckets.go classifier. Task #285 follow-up
		// (driver 2h sweep 2026-05-21 15:00 review proposal).
		if evidence, ok := triageQualityRunDelegateNoVisibleAction(run); ok {
			if !triageQualityDelegateNeedsOperatorReview(evidence) {
				continue
			}
			out.DelegateNoVisibleActionCount++
			if sampleLimit > 0 && len(out.DelegateNoVisibleActionSamples) < sampleLimit {
				out.DelegateNoVisibleActionSamples = append(out.DelegateNoVisibleActionSamples, SlackTriageDelegateNoVisibleActionSample{
					Timestamp:      run.Timestamp,
					RunID:          run.ID,
					Channels:       run.Channels,
					Summary:        slackTriageFailureSampleText(run.Summary),
					ActionsCount:   len(run.Actions),
					WorkerRequests: evidence.WorkerRequests,
					JobID:          evidence.JobID,
					DeliveryStatus: evidence.DeliveryStatus,
				})
			}
			continue
		}
		marker := triageQualityIntentActionMismatchMatch(run.Summary)
		if marker == "" {
			continue
		}
		out.IntentActionMismatchCount++
		if sampleLimit > 0 && len(out.IntentActionMismatchSamples) < sampleLimit {
			decision := ""
			if raw, ok := mapFromAny(run.Metadata["persona_foreground"]); ok {
				decision = strings.TrimSpace(stringFromAny(raw["decision"]))
			}
			out.IntentActionMismatchSamples = append(out.IntentActionMismatchSamples, SlackTriageIntentActionMismatchSample{
				Timestamp:       run.Timestamp,
				RunID:           run.ID,
				Channels:        run.Channels,
				Summary:         slackTriageFailureSampleText(run.Summary),
				ActionsCount:    len(run.Actions),
				PersonaDecision: decision,
				MarkerMatched:   marker,
			})
		}
	}
	return out
}

// buildSlackTriageInfoBuckets collects record-keeping-only buckets: no-action
// runs whose evidence says the work was handled elsewhere, plus transient
// provider failures that were followed by a same-thread successful recovery.
// These runs land in the info tier so operator review queues stay focused on
// real "something might be wrong" candidates.
func buildSlackTriageInfoBuckets(runs []SlackTriageContext, sampleLimit int) SlackTriageInfoBuckets {
	out := SlackTriageInfoBuckets{}
	if len(runs) == 0 {
		return out
	}
	ordered := append([]SlackTriageContext(nil), runs...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return parseTriageTimestamp(ordered[i].Timestamp).After(parseTriageTimestamp(ordered[j].Timestamp))
	})
	for _, run := range ordered {
		if evidence, ok := triageQualityRunRecoveredProviderFailure(run, runs); ok {
			out.RecoveredProviderFailureCount++
			if sampleLimit > 0 && len(out.RecoveredProviderFailureSamples) < sampleLimit {
				out.RecoveredProviderFailureSamples = append(out.RecoveredProviderFailureSamples, SlackTriageRecoveredProviderFailureSample{
					Timestamp:        run.Timestamp,
					RunID:            run.ID,
					Channels:         run.Channels,
					ThreadTS:         evidence.ThreadTS,
					Summary:          slackTriageFailureSampleText(run.Summary),
					Error:            slackTriageFailureSampleText(evidence.Error),
					RecoveredByRunID: evidence.RecoveredByRunID,
					RecoveredAt:      evidence.RecoveredAt,
					RecoverySummary:  slackTriageFailureSampleText(evidence.RecoverySummary),
				})
			}
			continue
		}
		if len(run.Actions) > 0 || run.Mutations > 0 {
			continue
		}
		if evidence, ok := triageQualityRunDirectedToActiveAgent(run); ok {
			out.DirectedToActiveAgentNoActionCount++
			if sampleLimit > 0 && len(out.DirectedToActiveAgentNoActionSamples) < sampleLimit {
				out.DirectedToActiveAgentNoActionSamples = append(out.DirectedToActiveAgentNoActionSamples, SlackTriageDirectedToActiveAgentSample{
					Timestamp:       run.Timestamp,
					RunID:           run.ID,
					Channels:        run.Channels,
					Summary:         slackTriageFailureSampleText(run.Summary),
					MentionedUserID: evidence.MentionedUserID,
					ActiveMessages:  evidence.ActiveMessages,
					Evidence:        slackTriageFailureSampleText(evidence.Evidence),
				})
			}
			continue
		}
		marker := triageQualityRunIsHandledByOther(run.Summary)
		if marker == "" {
			continue
		}
		out.HandledByOtherNoActionCount++
		if sampleLimit > 0 && len(out.HandledByOtherNoActionSamples) < sampleLimit {
			out.HandledByOtherNoActionSamples = append(out.HandledByOtherNoActionSamples, SlackTriageHandledByOtherSample{
				Timestamp:     run.Timestamp,
				RunID:         run.ID,
				Channels:      run.Channels,
				Summary:       slackTriageFailureSampleText(run.Summary),
				MarkerMatched: marker,
			})
		}
	}
	return out
}

func buildSlackTriageFailureSamples(runs []SlackTriageContext, limit int) []SlackTriageFailureSample {
	if limit <= 0 || len(runs) == 0 {
		return nil
	}
	ordered := append([]SlackTriageContext(nil), runs...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return parseTriageTimestamp(ordered[i].Timestamp).After(parseTriageTimestamp(ordered[j].Timestamp))
	})
	samples := make([]SlackTriageFailureSample, 0, limit)
	for _, run := range ordered {
		if len(samples) >= limit {
			break
		}
		if !slackTriageRunFailed(run) {
			continue
		}
		if _, ok := triageQualityRunRecoveredProviderFailure(run, runs); ok {
			continue
		}
		samples = append(samples, SlackTriageFailureSample{
			Timestamp: run.Timestamp,
			Channels:  run.Channels,
			Probe:     slackTriageRunIsProbe(run),
			Status:    strings.TrimSpace(run.Status),
			Summary:   slackTriageFailureSampleText(run.Summary),
			Error:     slackTriageFailureSampleText(run.Error),
		})
	}
	if len(samples) == 0 {
		return nil
	}
	return samples
}

type triageQualityRecoveredProviderFailureEvidence struct {
	ThreadTS         string
	Error            string
	RecoveredByRunID int64
	RecoveredAt      string
	RecoverySummary  string
}

type triageQualityThreadKey struct {
	ChannelID string
	ThreadTS  string
}

func triageQualityRunRecoveredProviderFailure(run SlackTriageContext, runs []SlackTriageContext) (triageQualityRecoveredProviderFailureEvidence, bool) {
	if !slackTriageRunFailed(run) || !triageQualityRunProviderTransientFailure(run) {
		return triageQualityRecoveredProviderFailureEvidence{}, false
	}
	key, ok := triageQualityRunThreadKey(run)
	if !ok {
		return triageQualityRecoveredProviderFailureEvidence{}, false
	}
	failedAt := parseTriageTimestamp(run.Timestamp).UTC()
	if failedAt.IsZero() {
		return triageQualityRecoveredProviderFailureEvidence{}, false
	}
	var recovery SlackTriageContext
	var recoveredAt time.Time
	for _, candidate := range runs {
		if candidate.ID == run.ID {
			continue
		}
		candidateKey, ok := triageQualityRunThreadKey(candidate)
		if !ok || candidateKey != key || slackTriageRunFailed(candidate) {
			continue
		}
		candidateAt := parseTriageTimestamp(candidate.Timestamp).UTC()
		if candidateAt.IsZero() || !candidateAt.After(failedAt) {
			continue
		}
		if recoveredAt.IsZero() || candidateAt.Before(recoveredAt) {
			recovery = candidate
			recoveredAt = candidateAt
		}
	}
	if recoveredAt.IsZero() {
		return triageQualityRecoveredProviderFailureEvidence{}, false
	}
	return triageQualityRecoveredProviderFailureEvidence{
		ThreadTS:         key.ThreadTS,
		Error:            firstNonEmpty(run.Error, triageQualityRunPersonaError(run)),
		RecoveredByRunID: recovery.ID,
		RecoveredAt:      recovery.Timestamp,
		RecoverySummary:  firstNonEmpty(recovery.Summary, triageQualityRunPersonaReason(recovery)),
	}, true
}

func triageQualityRunProviderTransientFailure(run SlackTriageContext) bool {
	text := strings.ToLower(firstNonEmpty(run.Error, triageQualityRunPersonaError(run), run.Summary))
	if text == "" {
		return false
	}
	if strings.Contains(text, "eof") && (strings.Contains(text, "openrouter") || strings.Contains(text, "chat/completions")) {
		return true
	}
	return strings.Contains(text, "connection reset by peer") ||
		strings.Contains(text, "unexpected eof") ||
		strings.Contains(text, "decode oneesama pi decision json") ||
		strings.Contains(text, "unexpected end of json input")
}

func triageQualityRunThreadKey(run SlackTriageContext) (triageQualityThreadKey, bool) {
	channelID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(run.Metadata["channel_id"]),
		stringFromAny(run.Metadata["channelId"]),
	))
	threadTS := strings.TrimSpace(firstNonEmpty(
		stringFromAny(run.Metadata["thread_ts"]),
		stringFromAny(run.Metadata["threadTs"]),
	))
	if raw, ok := mapFromAny(run.Metadata["persona_foreground"]); ok {
		channelID = firstNonEmpty(channelID, stringFromAny(raw["channel_id"]), stringFromAny(raw["channelId"]))
		threadTS = firstNonEmpty(threadTS, stringFromAny(raw["thread_ts"]), stringFromAny(raw["threadTs"]))
	}
	if channelID == "" && len(run.Channels) > 0 {
		channelID = strings.TrimSpace(run.Channels[0])
	}
	if channelID == "" || threadTS == "" {
		return triageQualityThreadKey{}, false
	}
	return triageQualityThreadKey{ChannelID: channelID, ThreadTS: threadTS}, true
}

func triageQualityRunPersonaError(run SlackTriageContext) string {
	raw, ok := mapFromAny(run.Metadata["persona_foreground"])
	if !ok {
		return ""
	}
	return stringFromAny(raw["error"])
}

func triageQualityRunPersonaReason(run SlackTriageContext) string {
	raw, ok := mapFromAny(run.Metadata["persona_foreground"])
	if !ok {
		return ""
	}
	return stringFromAny(raw["reason"])
}

func filterSlackTriageProbeRuns(runs []SlackTriageContext, probe bool) []SlackTriageContext {
	out := make([]SlackTriageContext, 0, len(runs))
	for _, run := range runs {
		if slackTriageRunIsProbe(run) == probe {
			out = append(out, run)
		}
	}
	return out
}

func buildSlackTriageInputContext(runs []SlackTriageContext) SlackTriageInputContext {
	values := make([]int, 0, len(runs))
	for _, run := range runs {
		value := intFromAny(run.Metadata["input_context_chars"])
		if value <= 0 {
			continue
		}
		values = append(values, value)
	}
	if len(values) == 0 {
		return SlackTriageInputContext{}
	}
	sort.Ints(values)
	stats := SlackTriageInputContext{
		Count:  len(values),
		Min:    values[0],
		Median: medianInt(values),
		Max:    values[len(values)-1],
	}
	for _, value := range values {
		if value < slackTriageLowContextCharThreshold {
			stats.LowUnder200++
		}
	}
	return stats
}

func buildSlackTriageContextBudget(runs []SlackTriageContext) SlackTriageContextBudget {
	totalChars := make([]int, 0, len(runs))
	var budget SlackTriageContextBudget
	for _, run := range runs {
		total := intFromAny(run.Metadata["context_budget_total_chars"])
		tokens := intFromAny(run.Metadata["context_budget_total_tokens"])
		if total <= 0 && tokens <= 0 {
			continue
		}
		budget.Count++
		if total > 0 {
			totalChars = append(totalChars, total)
			if total > budget.MaxTotalChars {
				budget.MaxTotalChars = total
			}
		}
		if tokens > budget.MaxTotalTokens {
			budget.MaxTotalTokens = tokens
		}
		if value := intFromAny(run.Metadata["context_budget_stable_tokens"]); value > budget.MaxStableTokens {
			budget.MaxStableTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_dynamic_tokens"]); value > budget.MaxDynamicTokens {
			budget.MaxDynamicTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_worker_result_tokens"]); value > budget.MaxWorkerResultTokens {
			budget.MaxWorkerResultTokens = value
		}
		if value := intFromAny(run.Metadata["context_budget_memory_evidence_tokens"]); value > budget.MaxMemoryEvidenceTokens {
			budget.MaxMemoryEvidenceTokens = value
		}
	}
	if len(totalChars) > 0 {
		sort.Ints(totalChars)
		budget.MedianTotalChars = medianInt(totalChars)
	}
	return budget
}

func buildSlackTriageHarnessDrift(contextBudget SlackTriageContextBudget, reviewBuckets SlackTriageReviewBuckets, infoBuckets SlackTriageInfoBuckets) SlackTriageHarnessDrift {
	return SlackTriageHarnessDrift{
		PIStablePromptHash:           persona.OneesamaPIStablePromptHash(persona.Request{}),
		DynamicContextIssueCount:     reviewBuckets.DynamicContextIssueCount,
		DelegateNoVisibleActionCount: reviewBuckets.DelegateNoVisibleActionCount,
		HandledByOtherNoActionCount:  infoBuckets.HandledByOtherNoActionCount,
		RunsWithContextBudget:        contextBudget.Count,
		MaxContextBudgetTokens:       contextBudget.MaxTotalTokens,
		MaxStablePromptTokens:        contextBudget.MaxStableTokens,
		MaxDynamicContextTokens:      contextBudget.MaxDynamicTokens,
		MaxWorkerResultTokens:        contextBudget.MaxWorkerResultTokens,
		MaxMemoryEvidenceTokens:      contextBudget.MaxMemoryEvidenceTokens,
	}
}

func buildSlackTriageContextFetch(runs []SlackTriageContext) SlackTriageContextFetch {
	fetch := SlackTriageContextFetch{Reasons: map[string]int{}}
	for _, run := range runs {
		if boolFromAny(run.Metadata["channel_context_fetched"], false) {
			fetch.ChannelContextFetched++
		}
		if boolFromAny(run.Metadata["thread_context_fetched"], false) {
			fetch.ThreadContextFetched++
		}
		fetch.ExternalLinksFetched += intFromAny(run.Metadata["external_links_fetched"])
		if reason := slackTriageContextFetchReason(run); reason != "" {
			fetch.Reasons[reason]++
		}
	}
	if len(fetch.Reasons) == 0 {
		fetch.Reasons = nil
	}
	return fetch
}

func buildSlackTriageSkipReasons(runs []SlackTriageContext) map[string]int {
	reasons := map[string]int{}
	for _, run := range runs {
		if run.Mutations > 0 || len(run.Actions) > 0 {
			continue
		}
		bucket := slackTriageSkipReasonBucket(run)
		if bucket == "" {
			continue
		}
		reasons[bucket]++
	}
	if len(reasons) == 0 {
		return nil
	}
	return reasons
}
