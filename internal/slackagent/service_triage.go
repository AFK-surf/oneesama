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
)

const (
	slackTriageStatusDefaultLimit      = 100
	slackTriageLowContextCharThreshold = 200
	slackTriageAuditDefaultWindow      = 6 * time.Hour
	slackTriageAuditStaleSampleAfter   = 2 * time.Hour
)

type slackTriageStartOptions struct {
	Probe         bool
	ExtraMetadata map[string]any
}

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
		if run.Failures > 0 || strings.TrimSpace(run.Error) != "" || strings.EqualFold(strings.TrimSpace(run.Status), "failed") {
			outcome.FailedRuns++
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
		flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "real_outcome_failures", Message: fmt.Sprintf("%d real triage run(s) failed in the audit window.", report.RealOutcome.FailedRuns)})
	}
	if report.ProbeOutcome.FailedRuns > 0 {
		flags = append(flags, SlackTriageAuditFlag{Level: "yellow", Code: "probe_outcome_failures", Message: fmt.Sprintf("%d synthetic triage probe run(s) failed in the audit window.", report.ProbeOutcome.FailedRuns)})
	}
	if report.ProcessHealth.CodexRequiredEnvKey != "" && !report.ProcessHealth.CodexRequiredEnvPresent {
		flags = append(flags, SlackTriageAuditFlag{Level: "red", Code: "codex_provider_env_missing", Message: fmt.Sprintf("Required Codex provider env %s is not exported in the slack-agent process.", report.ProcessHealth.CodexRequiredEnvKey)})
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

func buildSlackTriageAuditFixtures() []SlackTriageAuditFixture {
	type fixture struct {
		name     string
		expected string
		raw      string
	}
	fixtures := []fixture{
		{
			name:     "act_post_thread_reply",
			expected: "ACT",
			raw:      `{"summary":"用户明确 @ bot 请求一个短回复。","actions":[{"type":"post_thread_reply","title":"短回复","message":"收到，我来跟进。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.9,"requiresConfirmation":false}]}`,
		},
		{
			name:     "maybe_follow_up",
			expected: "MAYBE",
			raw:      `{"summary":"用户提出需要后续确认的事项。","actions":[{"type":"follow_up","title":"确认 owner","message":"确认 owner 并跟进阻塞事项。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.8,"requiresConfirmation":true}]}`,
		},
		{
			name:     "synthesis_link_reply",
			expected: "ACT",
			raw:      `{"summary":"分享的长文链接值得轻量读后感。","actions":[{"type":"post_thread_reply","title":"链接初步看法","message":"我粗读了一下，这篇文章的核心是把模型能力和可验证机制分开看。","channelId":"C_AUDIT","threadTs":"123.456","confidence":0.7,"requiresConfirmation":false}]}`,
		},
		{
			name:     "skip_no_action",
			expected: "SKIP",
			raw:      "No action.\n\n闲聊自然收尾，无需助手介入。",
		},
	}
	results := make([]SlackTriageAuditFixture, 0, len(fixtures))
	for _, item := range fixtures {
		decision := parseSlackTriageDecision(item.raw, slackTriageFallback{Summary: "fixture fallback", Channel: "C_AUDIT", ThreadTS: "123.456"})
		outcome, mutations := slackTriageAuditFixtureOutcome(decision.Actions)
		results = append(results, SlackTriageAuditFixture{
			Name:             item.name,
			Expected:         item.expected,
			Outcome:          outcome,
			Pass:             decision.ParseOK && outcome == item.expected,
			ParseOK:          decision.ParseOK,
			Actions:          len(decision.Actions),
			Mutations:        mutations,
			SuppressedReason: slackTriageSuppressedReason(decision, decision.Actions, true),
			Summary:          decision.Summary,
		})
	}
	results = append(results, buildSlackMemoryBackedTriageAuditFixtures()...)
	return results
}

func buildSlackMemoryBackedTriageAuditFixtures() []SlackTriageAuditFixture {
	const category = "memory_backed_triage"
	fixtures := []SlackTriageAuditFixture{}

	ahaRecord := SlackRelatedMemoryRecord{
		Kind:       "team_question",
		SourcePath: "memory/team/questions/bridge-memory.md",
		StartLine:  3,
		EndLine:    5,
		Content:    "Bridge memory Aha moments should answer with related-topic recall evidence and cite the source lines.",
		Score:      0.72,
	}
	ahaPrompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:     "C_AUDIT",
		Digest:        "为什么 bridge memory 没接住 Aha Moment?",
		RelatedMemory: []SlackRelatedMemoryRecord{ahaRecord},
	})
	ahaCitation := slackRelatedMemoryCitation(ahaRecord)
	ahaPass := strings.Contains(ahaPrompt, "Related memory evidence") &&
		strings.Contains(ahaPrompt, "cite source path/lines") &&
		strings.Contains(ahaPrompt, ahaCitation)
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "aha_unanswered_question_with_recent_memory",
		Category: category,
		Expected: "prompt_cites_related_memory",
		Outcome:  boolOutcome(ahaPass, "prompt_cites_related_memory", "missing_related_memory_citation"),
		Pass:     ahaPass,
		ParseOK:  true,
		Summary:  "Aha-style unanswered questions must enter the triage prompt with source-cited related memory evidence.",
		Evidence: []string{ahaCitation},
	})

	delayedEvidence := formatSlackRelatedMemoryEvidence([]SlackRelatedMemoryRecord{ahaRecord}, 3)
	delayedFooter := renderRelatedMemoryEvidenceFooter(delayedEvidence, "这个问题等了一阵子还没人接，我补一个相关记忆。")
	delayedPass := strings.Contains(delayedFooter, ahaCitation) && strings.Contains(delayedFooter, "记忆")
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "delayed_no_reply_uses_memory_before_reply",
		Category: category,
		Expected: "footer_cites_related_memory",
		Outcome:  boolOutcome(delayedPass, "footer_cites_related_memory", "missing_delayed_memory_footer"),
		Pass:     delayedPass,
		ParseOK:  true,
		Summary:  "Delayed no-reply surfaces must attach cited memory evidence when memory exists.",
		Evidence: []string{ahaCitation},
	})

	readyCandidate := SlackBackfillCandidate{
		ChannelID:      "C_AUDIT",
		ThreadTS:       "123.456",
		OriginatorTS:   "123.456",
		Classification: "unanswered_question",
		Title:          "unanswered architecture question",
		OriginalText:   "Pi-style persona runtime 和 Go 周边应该怎么切边界？",
		Draft:          "可以先把 persona runtime 做成 sidecar，Go 保留 IO 和调度。",
	}
	noMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, nil, 3)
	noMemoryOutcome := ""
	if len(noMemory) > 0 {
		noMemoryOutcome = noMemory[0].ReviewStatus
	}
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "backfill_review_ready_requires_memory_or_agent_read",
		Category: category,
		Expected: BackfillReviewNeedsContext,
		Outcome:  noMemoryOutcome,
		Pass:     noMemoryOutcome == BackfillReviewNeedsContext,
		ParseOK:  true,
		Summary:  "Backfill must not mark a reply review_ready without related memory evidence or delegated agent read evidence.",
	})

	weakMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{
			Status: "ok",
			Results: []SlackRelatedMemoryRecord{{
				Kind:       "daily_note",
				SourcePath: "memory/2026-05-01.md",
				StartLine:  10,
				Content:    "A weak unrelated note about flaky tests.",
				Score:      0.1,
			}},
		}
	}, 3)
	weakOutcome := ""
	if len(weakMemory) > 0 {
		weakOutcome = weakMemory[0].ReviewStatus
	}
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "weak_memory_hit_stays_needs_context",
		Category: category,
		Expected: BackfillReviewNeedsContext,
		Outcome:  weakOutcome,
		Pass:     weakOutcome == BackfillReviewNeedsContext,
		ParseOK:  true,
		Summary:  "Weak lexical memory hits are not enough to turn a backfill lead into a postable reply.",
	})

	personRecord := SlackRelatedMemoryRecord{
		Kind:       "person_profile",
		SourcePath: "memory/people/he-jiachen.md",
		StartLine:  2,
		EndLine:    6,
		Content:    "He Jiachen previously asked about related-topic recall; answer with evidence rather than a generic opinion.",
		Score:      0.81,
		Reasons:    []string{"family_boost:person_profile"},
	}
	withMemory := EnrichBackfillCandidatesWithRelatedMemory([]SlackBackfillCandidate{readyCandidate}, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{Status: "ok", Results: []SlackRelatedMemoryRecord{personRecord}}
	}, 3)
	personCitation := slackRelatedMemoryCitation(personRecord)
	personOutcome := ""
	personEvidenceOK := false
	if len(withMemory) > 0 {
		personOutcome = withMemory[0].ReviewStatus
		personEvidenceOK = len(withMemory[0].RelatedMemory) == 1 &&
			strings.Contains(formatSlackRelatedMemoryEvidence(withMemory[0].RelatedMemory, 3), personCitation)
	}
	personPass := personOutcome == BackfillReviewReady && personEvidenceOK
	fixtures = append(fixtures, SlackTriageAuditFixture{
		Name:     "person_project_memory_cites_source",
		Category: category,
		Expected: BackfillReviewReady,
		Outcome:  personOutcome,
		Pass:     personPass,
		ParseOK:  true,
		Summary:  "Person/project memory can make a candidate review_ready only when the report carries source path and line citations.",
		Evidence: []string{personCitation},
	})

	return fixtures
}

func boolOutcome(pass bool, success string, failure string) string {
	if pass {
		return success
	}
	return failure
}

func slackTriageAuditFixtureOutcome(actions []SlackTriageDecisionAction) (string, int) {
	if len(actions) == 0 {
		return "SKIP", 0
	}
	mutations := 0
	for _, action := range actions {
		if slackTriageDirectReplyAction(action) {
			mutations++
		}
	}
	if mutations > 0 {
		return "ACT", mutations
	}
	return "MAYBE", 0
}

func (s *Service) StartSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (SlackTriageStartResult, error) {
	return s.startSlackTriage(ctx, channelID, messages, digest, slackTriageStartOptions{})
}

func (s *Service) StartSlackTriageProbe(ctx context.Context) (SlackTriageStartResult, error) {
	now := timeNow().UTC()
	channelID := "C_TRIAGE_PROBE"
	threadTS := fmt.Sprintf("probe.%d", now.UnixMilli())
	messages := []SlackInboundMessage{{
		TeamID:    "T_TRIAGE_PROBE",
		ChannelID: channelID,
		UserID:    "U_TRIAGE_PROBE",
		Text:      "<@U_BOT> positive probe: please create a follow-up suggestion for verifying triage recall. Do not post a public reply.",
		TS:        threadTS,
	}}
	digest := renderSlackActivityDigest(channelID, messages)
	return s.startSlackTriage(ctx, channelID, messages, digest, slackTriageStartOptions{
		Probe: true,
		ExtraMetadata: map[string]any{
			"live_positive_probe": true,
			"probe_kind":          "maybe_follow_up",
			"skip_reason_bucket":  "",
		},
	})
}

func (s *Service) startSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, options slackTriageStartOptions) (SlackTriageStartResult, error) {
	if s.runner == nil {
		return SlackTriageStartResult{}, fmt.Errorf("agent runner is not ready: %s", runnerErrorText(s.runnerErr))
	}
	messages = normalizeSlackInboundMessages(messages)
	workspaceID := firstNonEmpty(firstMessageTeamID(messages), "workspace")
	threadTS := firstNonEmpty(lastMessageThreadTS(messages), "channel-root")
	sessionID := fmt.Sprintf("triage:%s:%d", channelID, timeNow().UnixMilli())
	threadContexts := s.fetchSlackTriageThreadContexts(ctx, channelID, messages)
	channelContexts := s.fetchSlackTriageChannelContexts(ctx, channelID, messages, digest, threadContexts)
	if len(channelContexts) > 0 {
		digest = renderSlackActivityDigestWithContext(channelID, channelContexts, messages)
	}
	if enriched := appendSlackTriageThreadContextDigest(digest, threadContexts); enriched != "" {
		digest = enriched
	}
	externalLinks := fetchSlackExternalLinkContexts(ctx, messages)
	auditMetadata := slackTriageAuditMetadata(digest, messages, threadContexts, channelContexts, externalLinks)
	auditMetadata = mergeStringAnyMaps(auditMetadata, options.ExtraMetadata)
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: sessionID,
		Status:    "pending",
		Summary:   fmt.Sprintf("Triage pending for %d Slack message(s) in %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
		Metadata:  auditMetadata,
	})
	if err != nil {
		return SlackTriageStartResult{}, err
	}

	channelBrain, _ := s.cognition.GetChannelBrain(ctx, workspaceID, channelID)
	previousRuns := loadTriageContexts(s.triage, s.workspaceDir)
	previous := filterTriageContextsForChannel(previousRuns, channelID)
	localMemory := slackTriageMemoryFromLocal(s.SearchLocalMemory(digest, 5), digest)
	relatedMemory := s.searchSlackTriageRelatedMemory(digest, 5)
	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:      channelID,
		Messages:       messages,
		Digest:         digest,
		ChannelBrain:   channelBrain,
		LocalMemory:    localMemory,
		RelatedMemory:  relatedMemory.Results,
		PreviousTriage: formatTriageContexts(previous),
		ExternalLinks:  externalLinks,
		ThreadContexts: threadContexts,
	})
	contextMap := map[string]any{
		"source":        "slack-triage",
		"sessionId":     sessionID,
		"session_id":    sessionID,
		"channelId":     channelID,
		"channel_id":    channelID,
		"workspaceId":   workspaceID,
		"workspace_id":  workspaceID,
		"threadTs":      threadTS,
		"thread_ts":     threadTS,
		"messageCount":  len(messages),
		"message_count": len(messages),
		"messages":      messages,
		"digest":        digest,
		"triageRunId":   run.ID,
		"triage_run_id": run.ID,
		"localSlackMemory": map[string]any{
			"results": localMemory,
			"query":   digest,
			"limit":   5,
		},
		"relatedMemory": relatedMemory,
		"domainContext": map[string]any{
			"channelBrain": channelBrain,
			"recentThreads": func() []SlackThreadLedgerRecord {
				records, _ := s.cognition.ListRecentThreadLedgers(ctx, workspaceID, channelID, 8)
				return records
			}(),
		},
		"previousTriage": map[string]any{
			"workspaceId": workspaceID,
			"channelId":   channelID,
			"count":       len(previous),
			"text":        formatTriageContexts(previous),
		},
		"externalLinks":   externalLinks,
		"threadContexts":  threadContexts,
		"channelContexts": channelContexts,
		"triageAudit":     auditMetadata,
		"triageProbe":     options.Probe,
		"expectedOutput":  "JSON triage decision with summary and actions[]",
	}
	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             prompt,
		Context:          contextMap,
		Mode:             "analysis",
		AllowCodeChanges: false,
	}, agentrunner.SessionKindTriage))
	if err != nil {
		return SlackTriageStartResult{Run: run}, err
	}
	s.inbound.SetLastTriageJob(job.ID)
	result := SlackTriageStartResult{Run: run, Job: job}
	if isTerminalJobStatus(job.Status) {
		finalization, err := s.finalizeSlackTriageJob(ctx, job)
		if err != nil {
			return result, err
		}
		result.Finalization = finalization
	}
	return result, nil
}

func (s *Service) recordSlackTriageOnly(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (*SlackTriageContext, error) {
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: fmt.Sprintf("buffer:%s:%d", channelID, s.InboundStatus().EventBuffer.Flushes),
		Status:    "recorded",
		Summary:   fmt.Sprintf("Buffered %d Slack message(s) for %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
	})
	if run != nil {
		persistTriageContext(s.workspaceDir, *run)
	}
	return run, err
}

func (s *Service) finalizeSlackTriageJob(ctx context.Context, job agentrunner.Job) (*SlackTriageFinalization, error) {
	if job.ID == "" {
		return nil, nil
	}
	s.triageMu.Lock()
	defer s.triageMu.Unlock()
	if result, ok := s.finalizedTriageResults[job.ID]; ok {
		return result, nil
	}
	s.finalizedTriageJobIDs[job.ID] = struct{}{}

	channelID := stringFromContext(job.Context, "channelId", "channel_id")
	workspaceID := firstNonEmpty(stringFromContext(job.Context, "workspaceId", "workspace_id"), "workspace")
	threadTS := firstNonEmpty(stringFromContext(job.Context, "threadTs", "thread_ts"), "channel-root")
	messages := messagesFromContext(job.Context["messages"])
	runID := int64FromContext(job.Context, "triageRunId", "triage_run_id")
	fallback := slackTriageFallback{Summary: fmt.Sprintf("Slack triage finished for %s.", channelID), Channel: channelID, ThreadTS: threadTS}
	if s.triageHeuristicFallback {
		fallback = suggestSlackTriageFallback(channelID, messages)
		fallback.Channel = firstNonEmpty(fallback.Channel, channelID)
		fallback.ThreadTS = firstNonEmpty(fallback.ThreadTS, threadTS)
	}

	rawOutput := firstNonEmpty(job.Result, job.Error)
	decision := parseSlackTriageDecision(rawOutput, fallback)
	ok := job.Status == agentrunner.StatusCompleted
	actions := append([]SlackTriageDecisionAction(nil), decision.Actions...)
	if ok && !decision.ParseOK && len(actions) == 0 {
		if action, ok := slackTriageSharedLinkSynthesisAction(channelID, threadTS, messages, slackExternalLinksFromContext(job.Context["externalLinks"])); ok {
			actions = append(actions, action)
			decision.Summary = firstNonEmpty(decision.Summary, "Shared link is synthesis-eligible; posting a lightweight initial opinion.")
		}
	}
	actions = filterSlackTriageActionsForMessages(actions, messages, s.botUserID)
	decision.Actions = actions
	if !ok {
		actions = nil
		decision.Actions = nil
	}
	probe := boolFromAny(job.Context["triageProbe"], false)
	var directToolCalls []SlackTriageToolCall
	var directFailures int
	var directMutations int
	if !probe {
		directToolCalls, directFailures, directMutations = s.executeSlackTriageDirectActions(ctx, workspaceID, channelID, threadTS, runID, actions, messages)
	}
	mutationCandidates := len(actions) - countSlackTriageDirectReplyActions(actions) + directMutations
	mutations, failures := reconcileTriageCounts(&triageCounters{mutations: mutationCandidates, failures: directFailures}, nil)
	if probe {
		mutations = 0
	}
	if ok {
		var reason string
		ok, reason = triageDidSucceed(job.ID, mutations, failures, nil, rawOutput)
		if !ok {
			job.Error = reason
		}
	}
	runPatch := SlackTriageContext{
		ID:        runID,
		SessionID: stringFromContext(job.Context, "sessionId", "session_id"),
		Status:    "ok",
		Summary:   decision.Summary,
		RawOutput: rawOutput,
		Digest:    stringFromContext(job.Context, "digest"),
		Channels:  firstNonEmptyStringSlice(extractChannelNames(stringFromContext(job.Context, "digest")), []string{channelID}),
		Actions:   triageActionRows(actions),
		ToolCalls: append([]SlackTriageToolCall{{
			Tool:    "agent_runner",
			Action:  "slack_triage",
			Args:    marshalTriageArgs(job.Provider, job.ID, decision.ParseOK),
			Success: ok,
			Brief:   mapBool(ok, "AgentRunner triage completed", "AgentRunner triage failed"),
			Result:  rawOutput,
		}}, directToolCalls...),
		Steps:     1,
		Mutations: mutations,
		Failures:  failures,
		Metadata: mergeStringAnyMaps(mapFromAnyOrEmpty(job.Context["triageAudit"]), map[string]any{
			"suppressed_reason":  slackTriageSuppressedReason(decision, actions, ok),
			"skip_reason_bucket": slackTriageSkipReasonBucketForDecision(decision, actions, ok),
		}),
	}
	if !ok {
		runPatch.Status = "failed"
		runPatch.Summary = "Triage failed: " + firstNonEmpty(job.Error, job.Result, string(job.Status))
		runPatch.Error = firstNonEmpty(job.Error, job.Result, string(job.Status), "triage_failed")
		runPatch.Failures = 1
	}
	updatedRun, err := s.triage.UpdateRun(ctx, runPatch)
	if err != nil {
		return nil, err
	}
	if updatedRun != nil {
		persistTriageContext(s.workspaceDir, *updatedRun)
	}
	go s.maybeCompactDailyNotes(context.WithoutCancel(ctx))
	if ok && decision.Summary != "" {
		if err := s.cognition.RecordTriageSummary(ctx, workspaceID, channelID, threadTS, runPatch.SessionID, decision.Summary, slackTriageLedgerOutcome(ok, mutations, failures)); err != nil {
			s.logger.Warn("slack thread ledger triage summary record failed", "error", err)
		}
		if _, err := s.cognition.UpsertChannelBrainSummary(ctx, workspaceID, channelID, decision.Summary); err != nil {
			s.logger.Warn("slack channel brain summary update failed", "error", err)
		}
	}
	if ok && !probe && len(actions) == 0 {
		s.maybeRecordDelayedNoReplyFollowup(ctx, workspaceID, channelID, threadTS, updatedRun, decision, messages)
	}
	var pendingActions []SlackTriagePendingResult
	if !probe {
		pendingActions = s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, job.ID, updatedRun, actions)
	}
	finalization := &SlackTriageFinalization{Run: updatedRun, Decision: decision, PendingActions: pendingActions}
	s.finalizedTriageResults[job.ID] = finalization
	return finalization, nil
}

func (s *Service) executeSlackTriageDirectActions(ctx context.Context, workspaceID string, channelID string, threadTS string, runID int64, actions []SlackTriageDecisionAction, snapshotMessages ...[]SlackInboundMessage) ([]SlackTriageToolCall, int, int) {
	calls := make([]SlackTriageToolCall, 0)
	var failures int
	var mutations int
	var messages []SlackInboundMessage
	if len(snapshotMessages) > 0 {
		messages = snapshotMessages[0]
	}
	for _, action := range actions {
		if !slackTriageDirectReplyAction(action) {
			continue
		}
		effectiveChannel := firstNonEmpty(action.ChannelID, channelID)
		effectiveThread := firstNonEmpty(action.ThreadTS, threadTS)
		snapshotTS := slackTriageSnapshotLatestTS(messages, effectiveChannel, effectiveThread)
		if newer, newerTS, reason := s.slackTriageThreadHasNewerBlockingActivity(ctx, effectiveChannel, effectiveThread, snapshotTS); newer {
			calls = append(calls, SlackTriageToolCall{
				Tool:    "slack_api",
				Action:  "post_thread_reply",
				Args:    marshalTriageArgs("conversations.replies", newerTS, true),
				Success: true,
				Brief:   firstNonEmpty(action.Title, "skipped stale thread reply"),
				Result:  reason,
			})
			continue
		}
		result := s.PostMessage(ctx, PostMessageInput{
			Channel:  effectiveChannel,
			ThreadTS: effectiveThread,
			Text:     markdownToSlackFallbackText(action.Message),
			Blocks:   buildSlackThreadReplyBlocks(action.Message, "", nil),
			DedupKey: fmt.Sprintf("slack-triage-direct:%d:%s:%s", runID, effectiveChannel, firstNonEmpty(effectiveThread, "root")),
		})
		call := SlackTriageToolCall{
			Tool:    "slack_api",
			Action:  "post_thread_reply",
			Args:    marshalTriageArgs("chat.postMessage", result.TS, result.OK),
			Success: result.OK,
			Brief:   firstNonEmpty(action.Title, firstLine(action.Message), "posted a thread reply"),
			Result:  firstNonEmpty(result.Error, result.Detail, result.TS, result.ThreadTS),
		}
		if !result.OK {
			failures++
		} else if err := s.cognition.RecordOutbound(ctx, workspaceID, effectiveChannel, effectiveThread, "Triage replied: "+firstNonEmpty(action.Title, firstLine(action.Message))); err != nil {
			s.logger.Warn("slack thread ledger direct reply record failed", "error", err)
		}
		mutations++
		calls = append(calls, call)
	}
	return calls, failures, mutations
}

func countSlackTriageDirectReplyActions(actions []SlackTriageDecisionAction) int {
	count := 0
	for _, action := range actions {
		if slackTriageDirectReplyAction(action) {
			count++
		}
	}
	return count
}

func slackTriageSnapshotLatestTS(messages []SlackInboundMessage, channelID string, threadTS string) string {
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	var latest string
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		if channelID != "" && message.ChannelID != "" && message.ChannelID != channelID {
			continue
		}
		messageThread := firstNonEmpty(message.ThreadTS, message.TS)
		if threadTS != "" && messageThread != "" && messageThread != threadTS {
			continue
		}
		if ts := firstNonEmpty(message.TS, message.EventTS); slackTSGreater(ts, latest) {
			latest = ts
		}
	}
	return latest
}

func (s *Service) slackTriageThreadHasNewerBlockingActivity(ctx context.Context, channelID string, threadTS string, snapshotTS string) (bool, string, string) {
	if s == nil || strings.TrimSpace(s.botToken) == "" || strings.TrimSpace(channelID) == "" || strings.TrimSpace(threadTS) == "" || strings.TrimSpace(threadTS) == "channel-root" || strings.TrimSpace(snapshotTS) == "" {
		return false, "", ""
	}
	response, err := s.callSlackConversationsReplies(ctx, channelID, threadTS)
	if err != nil {
		s.logger.Warn("slack triage direct reply freshness check failed", "channel", channelID, "thread_ts", threadTS, "error", err)
		return false, "", ""
	}
	if !response.OK {
		s.logger.Warn("slack triage direct reply freshness check returned slack error", "channel", channelID, "thread_ts", threadTS, "error", response.Error)
		return false, "", ""
	}
	for _, message := range slackInboundMessagesFromThreadMessages(channelID, response.Messages) {
		if !slackTSGreater(firstNonEmpty(message.TS, message.EventTS), snapshotTS) {
			continue
		}
		if isAuthoredByBot(message, []string{s.botUserID}) {
			return true, firstNonEmpty(message.TS, message.EventTS), "thread_has_newer_bot_activity"
		}
		return true, firstNonEmpty(message.TS, message.EventTS), "thread_has_newer_activity"
	}
	return false, "", ""
}

func slackTriageLedgerOutcome(ok bool, mutations int, failures int) string {
	switch {
	case !ok || failures > 0:
		return "failed"
	case mutations > 0:
		return "acted"
	default:
		return "no_action"
	}
}

func firstNonEmptyStringSlice(values []string, fallback []string) []string {
	if len(values) > 0 {
		return values
	}
	return fallback
}

func (s *Service) fetchSlackTriageThreadContexts(ctx context.Context, channelID string, messages []SlackInboundMessage) []SlackTriageThreadContext {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return nil
	}
	seen := map[string]struct{}{}
	var contexts []SlackTriageThreadContext
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		threadTS := slackTriageThreadLookupTS(message)
		if threadTS == "" {
			continue
		}
		channel := firstNonEmpty(message.ChannelID, channelID)
		key := channel + "\x00" + threadTS
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		response, err := s.callSlackConversationsReplies(ctx, channel, threadTS)
		if err != nil {
			contexts = append(contexts, SlackTriageThreadContext{
				ChannelID:  channel,
				ThreadTS:   threadTS,
				FetchOK:    false,
				FetchError: err.Error(),
			})
			continue
		}
		if !response.OK {
			contexts = append(contexts, SlackTriageThreadContext{
				ChannelID:  channel,
				ThreadTS:   threadTS,
				FetchOK:    false,
				FetchError: firstNonEmpty(response.Error, "slack_api_error"),
			})
			continue
		}
		inbound := slackInboundMessagesFromThreadMessages(channel, response.Messages)
		contexts = append(contexts, SlackTriageThreadContext{
			ChannelID:    channel,
			ThreadTS:     threadTS,
			FetchOK:      true,
			MessageCount: len(inbound),
			Messages:     inbound,
			Transcript:   renderSlackTriageThreadTranscript(inbound),
		})
	}
	return contexts
}

func (s *Service) fetchSlackTriageChannelContexts(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, threadContexts []SlackTriageThreadContext) []SlackInboundMessage {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return nil
	}
	if !slackTriageNeedsChannelContext(digest, messages, threadContexts) {
		return nil
	}
	latestTS := ""
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		if ts := firstNonEmpty(message.TS, message.EventTS); slackTSGreater(ts, latestTS) {
			latestTS = ts
		}
	}
	if latestTS == "" {
		return nil
	}
	channel := firstNonEmpty(firstMessageChannelID(messages), channelID)
	contextMessages := s.fetchSlackHistoryContext(ctx, channel, latestTS)
	if len(contextMessages) == 0 {
		return nil
	}
	return slackScannerInboundMessages(slackScannerConversation{ID: channel, IsChannel: true}, contextMessages)
}

func slackTriageNeedsChannelContext(digest string, messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext) bool {
	if len(threadContexts) > 0 {
		return false
	}
	if len(messages) == 0 {
		return false
	}
	if len([]rune(strings.TrimSpace(digest))) >= slackTriageLowContextCharThreshold {
		return false
	}
	for _, message := range messages {
		if slackTriageThreadLookupTS(message) != "" {
			return false
		}
	}
	return true
}

func slackTriageThreadLookupTS(message SlackInboundMessage) string {
	message = normalizeSlackInboundMessage(message)
	if ts := strings.TrimSpace(message.ThreadTS); ts != "" {
		return ts
	}
	if message.ReplyCount > 0 {
		return strings.TrimSpace(message.TS)
	}
	return ""
}

func renderSlackTriageThreadTranscript(messages []SlackInboundMessage) string {
	var lines []string
	for _, message := range messages {
		lines = append(lines, formatSlackInboundMessageLine(message, ""))
	}
	return strings.Join(lines, "\n")
}

func appendSlackTriageThreadContextDigest(digest string, contexts []SlackTriageThreadContext) string {
	threadContext := formatSlackTriageThreadContexts(contexts)
	if strings.TrimSpace(threadContext) == "" {
		return strings.TrimSpace(digest)
	}
	digest = strings.TrimSpace(digest)
	if digest == "" {
		return "Fetched Slack thread context:\n" + threadContext
	}
	return digest + "\n\nFetched Slack thread context:\n" + threadContext
}

func slackTriageAuditMetadata(digest string, messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext, channelContexts []SlackInboundMessage, externalLinks []SlackExternalLinkContext) map[string]any {
	threadFetched := false
	threadMessages := 0
	for _, context := range threadContexts {
		if context.FetchOK {
			threadFetched = true
			threadMessages += context.MessageCount
		}
	}
	metadata := map[string]any{
		"input_context_chars":      len([]rune(digest)),
		"message_count":            len(messages),
		"thread_context_fetched":   threadFetched,
		"thread_context_count":     len(threadContexts),
		"thread_context_messages":  threadMessages,
		"channel_context_fetched":  len(channelContexts) > 0,
		"channel_context_messages": len(channelContexts),
		"external_links_fetched":   len(externalLinks),
	}
	metadata["context_fetch_reason"] = slackTriageContextFetchReasonFromInputs(messages, threadContexts, channelContexts)
	return metadata
}

func slackTriageContextFetchReasonFromInputs(messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext, channelContexts []SlackInboundMessage) string {
	if len(threadContexts) > 0 {
		for _, context := range threadContexts {
			if context.FetchOK {
				return "thread_context_fetched"
			}
		}
		return "thread_context_attempted_failed"
	}
	if len(channelContexts) > 0 {
		return "channel_low_context_expansion"
	}
	if len(messages) == 0 {
		return "no_messages"
	}
	for _, message := range messages {
		if slackTriageThreadLookupTS(message) != "" {
			return "thread_context_not_available"
		}
	}
	return "standalone_digest"
}

func slackTriageSuppressedReason(decision SlackTriageDecision, actions []SlackTriageDecisionAction, ok bool) string {
	if !ok {
		return "triage_failed"
	}
	if len(actions) == 0 {
		if !decision.ParseOK {
			return "no_actions_parse_fallback"
		}
		return "no_actions"
	}
	return ""
}

func slackTriageSkipReasonBucketForDecision(decision SlackTriageDecision, actions []SlackTriageDecisionAction, ok bool) string {
	if !ok || len(actions) > 0 {
		return ""
	}
	return slackTriageSkipReasonBucket(SlackTriageContext{
		Summary:  decision.Summary,
		Metadata: map[string]any{"suppressed_reason": slackTriageSuppressedReason(decision, actions, ok)},
	})
}

func mergeStringAnyMaps(values ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, value := range values {
		for key, item := range value {
			out[key] = item
		}
	}
	return out
}

func mapFromAnyOrEmpty(value any) map[string]any {
	if mapped, ok := mapFromAny(value); ok {
		return mapped
	}
	return map[string]any{}
}
