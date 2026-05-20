package slackagent

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
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
		LastTriageJobID:   s.InboundStatus().EventBuffer.LastTriageJobID,
		AuditFreshness:    buildSlackTriageFreshness(runs),
		AuditFixtures:     buildSlackTriageAuditFixtures(),
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
	report := buildSlackTriageAuditReport(runs, window)
	report.ProcessHealth = s.slackTriageProcessHealth(window)
	report.PersonaRuntime = s.slackTriagePersonaRuntimeHealth(ctx)
	report.Flags = buildSlackTriageAuditFlags(report)
	return report, nil
}

func buildSlackTriageAuditReport(runs []SlackTriageContext, window time.Duration) SlackTriageAuditReport {
	if window <= 0 {
		window = slackTriageAuditDefaultWindow
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
	report := SlackTriageAuditReport{
		GeneratedAt:    now.Format(time.RFC3339Nano),
		WindowSeconds:  int64(window.Seconds()),
		Cutoff:         cutoff.Format(time.RFC3339Nano),
		RunCount:       len(windowRuns),
		Freshness:      *freshness,
		Outcome:        buildSlackTriageAuditOutcome(windowRuns),
		RealOutcome:    buildSlackTriageAuditOutcome(filterSlackTriageProbeRuns(windowRuns, false)),
		ProbeOutcome:   buildSlackTriageAuditOutcome(filterSlackTriageProbeRuns(windowRuns, true)),
		InputContext:   buildSlackTriageInputContext(windowRuns),
		ContextFetch:   buildSlackTriageContextFetch(windowRuns),
		SkipReasons:    buildSlackTriageSkipReasons(windowRuns),
		PersonaQuality: buildSlackTriagePersonaQuality(windowRuns),
		Canary:         canary,
		LiveProbe:      buildSlackTriageLiveProbeSummary(windowRuns),
		FailureSamples: buildSlackTriageFailureSamples(windowRuns, 5),
		RecentRuns:     buildSlackTriageAuditRunBriefs(windowRuns, 20),
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

func (s *Service) slackTriageProcessHealth(window time.Duration) SlackTriageProcessHealth {
	if window <= 0 {
		window = slackTriageAuditDefaultWindow
	}
	now := timeNow().UTC()
	cutoff := now.Add(-window)
	startedAt := now
	if s != nil && !s.startedAt.IsZero() {
		startedAt = s.startedAt.UTC()
	}
	uptime := now.Sub(startedAt)
	if uptime < 0 {
		uptime = 0
	}
	socket := SlackSocketModeStatus{}
	if s != nil {
		socket = s.socketModeStatus()
	}
	rateLimits := 0
	if s != nil {
		rateLimits = s.slackScannerRateLimitCountSince(cutoff)
	}
	health := SlackTriageProcessHealth{
		PID:                         os.Getpid(),
		UptimeSeconds:               int64(uptime.Seconds()),
		CPUPercent:                  slackProcessCPUPercent(uptime),
		ScannerRateLimitsLastWindow: rateLimits,
		HTTP429LastWindow:           rateLimits,
		SocketConnected:             socket.Connected,
		SocketReconnectsTotal:       socket.Reconnects,
		SocketLastConnectedAt:       socket.LastConnectedAt,
		SocketLastClosedAt:          socket.LastClosedAt,
		SocketLastEventAt:           socket.LastEventAt,
	}
	if s != nil {
		if envKey := agentrunner.RequiredCodexProviderEnvKey(s.agentRunner.Codex); envKey != "" {
			health.CodexRequiredEnvKey = envKey
			health.CodexRequiredEnvPresent = strings.TrimSpace(os.Getenv(envKey)) != ""
		}
	}
	if s != nil {
		health.ScannerSweepsLastWindow = s.slackScannerSweepCountSince(cutoff)
		health.SocketReconnectsLastWindow = s.socketModeReconnectsSince(cutoff)
	}
	return health
}

func (s *Service) slackTriagePersonaRuntimeHealth(ctx context.Context) SlackTriagePersonaRuntime {
	if s == nil {
		return SlackTriagePersonaRuntime{}
	}
	status := s.personaStatus(ctx)
	provider := persona.NormalizeProvider(status.Provider)
	return SlackTriagePersonaRuntime{
		Configured:        provider != "" && provider != persona.ProviderLegacy,
		ForegroundEnabled: s.foregroundPersonaRuntimeEnabled(),
		Provider:          status.Provider,
		Mode:              status.Mode,
		Ready:             status.Ready,
		Healthy:           status.Healthy,
		ShadowOnly:        status.ShadowOnly,
		Version:           status.Version,
		BaseURL:           status.BaseURL,
		LastRequestAt:     status.LastRequestAt,
		LastLatencyMS:     status.LastLatencyMS,
		LastError:         status.LastError,
		StateSummary:      status.StateSummary,
		Error:             status.Error,
	}
}

func (s *Service) socketModeReconnectsSince(cutoff time.Time) int {
	if s == nil {
		return 0
	}
	s.socketModeMu.Lock()
	runner := s.socketMode
	s.socketModeMu.Unlock()
	if runner == nil {
		return 0
	}
	return runner.ReconnectsSince(cutoff)
}

func slackProcessCPUPercent(uptime time.Duration) float64 {
	if uptime <= 0 {
		return 0
	}
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0
	}
	cpu := slackTimevalDuration(usage.Utime) + slackTimevalDuration(usage.Stime)
	if cpu <= 0 {
		return 0
	}
	return float64(cpu) / float64(uptime) * 100
}

func slackTimevalDuration(value syscall.Timeval) time.Duration {
	return time.Duration(value.Sec)*time.Second + time.Duration(value.Usec)*time.Microsecond
}

func buildSlackTriageCanarySummary(runs []SlackTriageContext) SlackTriageCanarySummary {
	controls := buildSlackTriageAuditFixtures()
	canary := SlackTriageCanarySummary{
		Total:    len(controls),
		Controls: controls,
	}
	for _, control := range controls {
		if control.Pass {
			canary.Passed++
		}
	}
	for _, run := range runs {
		if run.Mutations > 0 || len(run.Actions) > 0 {
			canary.LivePositiveRuns++
		}
	}
	canary.NeedsLiveSample = canary.LivePositiveRuns == 0
	return canary
}

func buildSlackTriageLiveProbeSummary(runs []SlackTriageContext) SlackTriageLiveProbeSummary {
	var summary SlackTriageLiveProbeSummary
	for _, run := range runs {
		if !boolFromAny(run.Metadata["live_positive_probe"], false) {
			continue
		}
		summary.Total++
		outcome := slackTriageLiveProbeOutcome(run)
		if outcome == "ACT" || outcome == "MAYBE" {
			summary.Passed++
		}
		summary.LatestRunID = run.ID
		summary.LatestAt = run.Timestamp
		summary.LatestOutcome = outcome
		summary.LatestSummary = firstLine(run.Summary)
	}
	return summary
}

func buildSlackTriagePersonaQuality(runs []SlackTriageContext) SlackTriagePersonaQuality {
	var quality SlackTriagePersonaQuality
	var latest time.Time
	var latestAuthFailure time.Time
	var oldestQueued time.Time
	now := timeNow().UTC()
	for _, run := range runs {
		timestamp := parseTriageTimestamp(run.Timestamp).UTC()
		raw, ok := mapFromAny(run.Metadata["persona_foreground"])
		if boolFromAny(run.Metadata["persona_foreground_queued"], false) {
			quality.ForegroundQueuedRuns++
			if !ok && !timestamp.IsZero() {
				age := now.Sub(timestamp)
				if age > slackTriageForegroundQueuedStaleAfter {
					quality.ForegroundStaleQueuedRuns++
					if oldestQueued.IsZero() || timestamp.Before(oldestQueued) {
						oldestQueued = timestamp
						quality.OldestQueuedRunID = run.ID
						quality.OldestQueuedAt = run.Timestamp
						quality.OldestQueuedAgeSeconds = int64(age.Seconds())
					}
				}
			}
		}
		if !ok {
			continue
		}
		quality.ForegroundRuns++
		success := boolFromAny(raw["success"], false)
		if success {
			quality.Successes++
		} else {
			quality.Failures++
			if slackTriageRunHasRetryScheduled(run) {
				quality.RetryScheduledFailures++
			}
		}
		if success && boolFromAny(raw["shadow_only"], false) {
			quality.ShadowOnlyResponses++
		}
		quality.WorkerRequests += lenStringSliceFromAny(raw["worker_requests"])
		quality.MemoryWriteIntents += lenStringSliceFromAny(raw["memory_writes"])
		decision := stringFromAny(raw["decision"])
		if strings.EqualFold(decision, persona.DecisionReply) || stringFromAny(raw["visible_text"]) != "" {
			quality.Replies++
		}
		errorText := firstNonEmpty(stringFromAny(raw["error"]), run.Error, stringFromAny(raw["reason"]), run.Summary)
		if personaForegroundAuthFailureText(errorText) {
			quality.AuthFailures++
			if !timestamp.IsZero() && (latestAuthFailure.IsZero() || timestamp.After(latestAuthFailure)) {
				latestAuthFailure = timestamp
				quality.LatestAuthFailureRunID = run.ID
				quality.LatestAuthFailureAt = run.Timestamp
				quality.LatestAuthFailureError = slackTriageFailureSampleText(errorText)
			}
		}
		if !timestamp.IsZero() && (latest.IsZero() || timestamp.After(latest)) {
			latest = timestamp
			quality.LatestRunID = run.ID
			quality.LatestAt = run.Timestamp
			quality.LatestDecision = decision
			quality.LatestError = stringFromAny(raw["error"])
			quality.LatestLatencyMS = int64FromAny(raw["latency_ms"])
		}
	}
	return quality
}

func personaForegroundAuthFailureText(value string) bool {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" {
		return false
	}
	if strings.Contains(text, "authentication fails") ||
		strings.Contains(text, "authentication failed") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "invalid api key") ||
		strings.Contains(text, "invalid key") ||
		strings.Contains(text, "401 unauthorized") ||
		strings.Contains(text, "status code: 401") ||
		strings.Contains(text, "http 401") {
		return true
	}
	return strings.Contains(text, "api key") && (strings.Contains(text, "401") || strings.Contains(text, "invalid") || strings.Contains(text, "auth"))
}

func lenStringSliceFromAny(value any) int {
	switch typed := value.(type) {
	case []string:
		return len(typed)
	case []any:
		count := 0
		for _, item := range typed {
			if strings.TrimSpace(fmt.Sprint(item)) != "" {
				count++
			}
		}
		return count
	default:
		return 0
	}
}

func slackTriageLiveProbeOutcome(run SlackTriageContext) string {
	switch {
	case run.Mutations > 0:
		return "ACT"
	case len(run.Actions) > 0:
		return "MAYBE"
	case strings.TrimSpace(run.Error) != "" || strings.EqualFold(strings.TrimSpace(run.Status), "failed"):
		return "FAILED"
	default:
		return "SKIP"
	}
}

func slackTriageRunIsProbe(run SlackTriageContext) bool {
	return boolFromAny(run.Metadata["live_positive_probe"], false) || strings.TrimSpace(stringFromAny(run.Metadata["probe_kind"])) != ""
}

func buildSlackTriageAuditFlags(report SlackTriageAuditReport) []SlackTriageAuditFlag {
	var flags []SlackTriageAuditFlag
	if report.RunCount == 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "no_recent_runs", Message: "No triage runs were recorded in the audit window."})
	}
	if report.Freshness.NewestRunAgeSeconds > int64(slackTriageAuditStaleSampleAfter.Seconds()) {
		level := "yellow"
		code := "stale_sample"
		message := fmt.Sprintf("Newest triage run is older than %s.", slackTriageAuditStaleSampleAfter)
		if report.ProcessHealth.SocketConnected && report.ProcessHealth.ScannerSweepsLastWindow > 10 {
			level = "info"
			code = "quiet_window"
			message = fmt.Sprintf("Newest triage run is older than %s, but scanner sweeps and Socket Mode look healthy.", slackTriageAuditStaleSampleAfter)
		}
		flags = append(flags, SlackTriageAuditFlag{Level: level, Code: code, Message: message})
	}
	if report.RealOutcome.FailedRuns > 0 {
		unhandled := report.RealOutcome.FailedRuns - report.RealOutcome.RetryScheduledFailures
		if unhandled > 0 {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "real_outcome_failures", Message: fmt.Sprintf("%d unhandled real triage failure(s) in the audit window.", unhandled)})
		} else {
			flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "real_outcome_failures_retry_scheduled", Message: fmt.Sprintf("%d real triage failure(s) already have retry follow-up scheduled.", report.RealOutcome.RetryScheduledFailures)})
		}
	}
	if report.ProbeOutcome.FailedRuns > 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "probe_outcome_failures", Message: fmt.Sprintf("%d synthetic triage probe run(s) failed in the audit window.", report.ProbeOutcome.FailedRuns)})
	}
	if report.ProcessHealth.CodexRequiredEnvKey != "" && !report.ProcessHealth.CodexRequiredEnvPresent {
		flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "codex_provider_env_missing", Message: fmt.Sprintf("Required Codex provider env %s is not exported in the slack-agent process.", report.ProcessHealth.CodexRequiredEnvKey)})
	}
	if report.PersonaRuntime.ForegroundEnabled {
		if !report.PersonaRuntime.Ready || !report.PersonaRuntime.Healthy || strings.TrimSpace(firstNonEmpty(report.PersonaRuntime.Error, report.PersonaRuntime.LastError)) != "" {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_runtime_unhealthy", Message: "Foreground persona runtime is enabled but its health/status check is not healthy."})
		}
		if persona.NormalizeMode(report.PersonaRuntime.Mode) != persona.ModeLive || report.PersonaRuntime.ShadowOnly {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_runtime_not_live", Message: "Foreground persona runtime is enabled but status does not report live non-shadow mode."})
		}
		if report.PersonaQuality.Failures > 0 {
			unhandled := report.PersonaQuality.Failures - report.PersonaQuality.RetryScheduledFailures
			if unhandled > 0 {
				flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_foreground_failures", Message: fmt.Sprintf("%d persona foreground triage run(s) failed in the audit window.", unhandled)})
			} else {
				flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "persona_foreground_failures_retry_scheduled", Message: fmt.Sprintf("%d persona foreground triage failure(s) already have retry follow-up scheduled.", report.PersonaQuality.RetryScheduledFailures)})
			}
		}
		if report.PersonaQuality.AuthFailures > 0 {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_foreground_auth_failures", Message: fmt.Sprintf("%d persona foreground triage run(s) failed with provider authentication errors.", report.PersonaQuality.AuthFailures)})
		}
		if report.PersonaQuality.ForegroundStaleQueuedRuns > 0 {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_foreground_stuck_queued", Message: fmt.Sprintf("%d persona foreground triage run(s) stayed queued for more than %s.", report.PersonaQuality.ForegroundStaleQueuedRuns, slackTriageForegroundQueuedStaleAfter)})
		}
		if report.PersonaQuality.ShadowOnlyResponses > 0 {
			flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "persona_foreground_shadow_only", Message: "Persona foreground returned shadow-only responses while live mode was enabled."})
		}
	}
	if report.InputContext.LowUnder200 > 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "low_context_samples", Message: "Some triage runs had less than 200 characters of input context."})
	}
	if report.Outcome.ParseFallbacks > 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "parse_fallbacks", Message: "Some triage runs required parser fallback handling."})
	}
	if report.SkipReasons["dev_bot_stuck_or_handoff"] > 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "dev_bot_stuck_or_handoff", Message: "Some skipped development threads look like a bot is stuck, handing off, or being repeatedly chased."})
	}
	if report.Canary.NeedsLiveSample {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "no_live_positive_samples", Message: "No real ACT/MAYBE triage samples appeared in this window; rely on canary controls until live positives occur."})
	}
	if report.Canary.Passed != report.Canary.Total {
		flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "canary_failed", Message: "One or more deterministic ACT/MAYBE/SKIP canary controls failed."})
	}
	return flags
}

func slackTriageRunFailed(run SlackTriageContext) bool {
	return run.Failures > 0 || strings.TrimSpace(run.Error) != "" || strings.EqualFold(strings.TrimSpace(run.Status), "failed")
}

func slackTriageRunHasRetryScheduled(run SlackTriageContext) bool {
	return boolFromAny(run.Metadata["triage_timeout_needs_retry"], false) ||
		boolFromAny(run.Metadata["triage_empty_final_needs_retry"], false) ||
		boolFromAny(run.Metadata["persona_foreground_orphan_needs_retry"], false)
}

func slackTriageFailureSampleText(value string) string {
	value = strings.TrimSpace(strings.ToValidUTF8(value, ""))
	if value == "" {
		return ""
	}
	value = firstLine(value)
	const maxFailureSampleText = 200
	runes := []rune(value)
	if len(runes) <= maxFailureSampleText {
		return value
	}
	return string(runes[:maxFailureSampleText]) + "..."
}

func buildSlackTriageAuditRunBriefs(runs []SlackTriageContext, limit int) []SlackTriageAuditRunBrief {
	if limit <= 0 || len(runs) == 0 {
		return nil
	}
	start := len(runs) - limit
	if start < 0 {
		start = 0
	}
	briefs := make([]SlackTriageAuditRunBrief, 0, len(runs)-start)
	for _, run := range runs[start:] {
		briefs = append(briefs, SlackTriageAuditRunBrief{
			Timestamp:             run.Timestamp,
			Channels:              run.Channels,
			InputContextChars:     intFromAny(run.Metadata["input_context_chars"]),
			ThreadContextFetched:  boolFromAny(run.Metadata["thread_context_fetched"], false),
			ChannelContextFetched: boolFromAny(run.Metadata["channel_context_fetched"], false),
			ContextFetchReason:    slackTriageContextFetchReason(run),
			ExternalLinksFetched:  intFromAny(run.Metadata["external_links_fetched"]),
			Mutations:             run.Mutations,
			Actions:               len(run.Actions),
			SuppressedReason:      stringFromAny(run.Metadata["suppressed_reason"]),
			SkipReasonBucket:      slackTriageSkipReasonBucket(run),
			Summary:               firstLine(run.Summary),
		})
	}
	return briefs
}

func slackTriageContextFetchReason(run SlackTriageContext) string {
	if reason := strings.TrimSpace(stringFromAny(run.Metadata["context_fetch_reason"])); reason != "" {
		return reason
	}
	if boolFromAny(run.Metadata["thread_context_fetched"], false) {
		return "thread_context_fetched"
	}
	if intFromAny(run.Metadata["thread_context_count"]) > 0 {
		return "thread_context_attempted_failed"
	}
	if boolFromAny(run.Metadata["channel_context_fetched"], false) {
		return "channel_low_context_expansion"
	}
	if intFromAny(run.Metadata["message_count"]) == 0 {
		return "no_messages"
	}
	return "standalone_digest"
}

func slackTriageSkipReasonBucket(run SlackTriageContext) string {
	if reason := strings.TrimSpace(stringFromAny(run.Metadata["skip_reason_bucket"])); reason != "" {
		return reason
	}
	if run.Mutations > 0 || len(run.Actions) > 0 {
		return ""
	}
	text := strings.ToLower(run.Summary + "\n" + stringFromAny(run.Metadata["suppressed_reason"]))
	switch {
	case containsAnySubstring(text, "重复", "duplicate", "followup", "跟上一次", "一致"):
		return "duplicate_or_followup"
	case containsAnySubstring(text, "备忘", "个人操作", "点赞", "转发", "note"):
		return "personal_note"
	case slackTriageLooksLikeDevBotStuckOrHandoff(text):
		return "dev_bot_stuck_or_handoff"
	case containsAnySubstring(text, "已处理", "正在修复", "持续响应", "其他 bot", "target bot", "handled"):
		return "handled_by_other_bot"
	case containsAnySubstring(text, "纯技术", "开发", "实现", "pr ", "pr#", "cherry-pick", "ci"):
		return "pure_dev_progress"
	case containsAnySubstring(text, "日程", "请假", "赶飞机", "同步", "schedule"):
		return "schedule_note"
	case containsAnySubstring(text, "file_share", "截图", "上下文不足", "低信号", "low signal"):
		return "low_signal_file_share"
	case containsAnySubstring(text, "链接", "link", "http://", "https://", "分享"):
		return "link_share"
	case containsAnySubstring(text, "观察", "报备", "无协调需求", "observation"):
		return "observation_only"
	case strings.TrimSpace(stringFromAny(run.Metadata["suppressed_reason"])) == "no_actions":
		return "no_action_other"
	default:
		return ""
	}
}

func slackTriageLooksLikeDevBotStuckOrHandoff(text string) bool {
	hasDev := containsAnySubstring(text, "纯技术", "开发", "实现", "pr ", "pr#", "cueboard", "openbridge", "bot ")
	hasChase := containsAnySubstring(text, "追问", "尚未", "未回复", "没有回复", "internal issue", "follow-up", "续跑", "卡住", "stuck")
	hasHandoff := containsAnySubstring(text, "交接", "新 bot", "旧 bot", "session ready", "handoff")
	return (hasDev && hasChase) || hasHandoff
}

func containsAnySubstring(text string, values ...string) bool {
	for _, value := range values {
		if strings.Contains(text, strings.ToLower(value)) {
			return true
		}
	}
	return false
}

func slackTriageRunParseFallback(run SlackTriageContext) bool {
	reason := strings.TrimSpace(stringFromAny(run.Metadata["suppressed_reason"]))
	if strings.Contains(reason, "parse_fallback") {
		return true
	}
	text := strings.ToLower(run.Summary + "\n" + run.RawOutput + "\n" + run.Error)
	return strings.Contains(text, "parse_fallback") || strings.Contains(text, "no_actions_parse_fallback")
}

func medianInt(sorted []int) int {
	if len(sorted) == 0 {
		return 0
	}
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

func buildSlackTriageFreshness(runs []SlackTriageContext) *SlackTriageFreshness {
	now := timeNow().UTC()
	freshness := &SlackTriageFreshness{
		GeneratedAt: now.Format(time.RFC3339Nano),
		RunCount:    len(runs),
	}
	var oldest, newest time.Time
	for _, run := range runs {
		timestamp := parseTriageTimestamp(run.Timestamp)
		if timestamp.IsZero() {
			continue
		}
		if oldest.IsZero() || timestamp.Before(oldest) {
			oldest = timestamp
		}
		if newest.IsZero() || timestamp.After(newest) {
			newest = timestamp
		}
	}
	if !oldest.IsZero() {
		freshness.OldestRunAt = oldest.UTC().Format(time.RFC3339Nano)
	}
	if !newest.IsZero() {
		freshness.NewestRunAt = newest.UTC().Format(time.RFC3339Nano)
		if age := now.Sub(newest.UTC()); age > 0 {
			freshness.NewestRunAgeSeconds = int64(age.Seconds())
		}
	}
	if !oldest.IsZero() && !newest.IsZero() && newest.After(oldest) {
		freshness.SampleWindowSeconds = int64(newest.Sub(oldest).Seconds())
	}
	return freshness
}
