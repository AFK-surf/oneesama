package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	improvementTopicHeartbeatTasking     = "heartbeat_tasking"
	improvementTopicMemoryInternal       = "memory_internalization"
	improvementTopicProgressNoise        = "progress_noise"
	improvementTopicToolCapability       = "tool_capability"
	improvementTopicProactivity          = "proactivity"
	improvementTopicReplyQuality         = "reply_quality"
	improvementTopicActionSuggestion     = "action_suggestion_quality"
	improvementTopicPendingActionHygiene = "pending_action_hygiene"

	improvementClusterBotAutonomy   = "bot_autonomy"
	improvementClusterBotExperience = "bot_experience"
	improvementClusterBotCapability = "bot_capability"

	selfGrowthMemoryStart = "<!-- codex:self-growth:start -->"
	selfGrowthMemoryEnd   = "<!-- codex:self-growth:end -->"
)

const (
	heartbeatFollowupKindSelfImprovement = "self_improvement"
	heartbeatFollowupPriorityLow         = "low"
	heartbeatFollowupPriorityNormal      = "normal"
	heartbeatFollowupPriorityHigh        = "high"
	heartbeatFollowupPriorityUrgent      = "urgent"
)

type improvementTopicSpec struct {
	Topic           string
	ClusterKey      string
	Title           string
	DesiredBehavior string
	Severity        string
	Keywords        []string
}

type improvementClusterSummary struct {
	ClusterKey          string
	Title               string
	Summary             string
	Priority            string
	LatestSourceKind    string
	LatestChannelID     string
	LatestThreadTS      string
	NextCheckAt         time.Time
	Topics              []string
	TopicCounts         []SlackImprovementTopicCount
	OpenSignalIDs       []int64
	SignalCount         int
	DistinctThreads7d   int
	ExplicitUserRequest bool
	EligibleForMemory   bool
	EligibleForRepoPR   bool
	LessonCandidates    []string
	EvidenceSummaries   []string
	EvidenceThreads     []improvementThreadEvidence
}

type improvementThreadEvidence struct {
	ChannelID             string   `json:"channel_id"`
	ThreadTS              string   `json:"thread_ts"`
	SignalCount           int      `json:"signal_count"`
	Topics                []string `json:"topics,omitempty"`
	RepresentativeSummary string   `json:"representative_summary,omitempty"`
}

var improvementTopicCatalog = []improvementTopicSpec{
	{
		Topic:           improvementTopicHeartbeatTasking,
		ClusterKey:      improvementClusterBotAutonomy,
		Title:           "Heartbeat should turn bot feedback into durable work",
		DesiredBehavior: "When people discuss heartbeat weaknesses or missing follow-through, automatically turn that into durable heartbeat work instead of letting it evaporate.",
		Severity:        improvementSignalSeverityHigh,
		Keywords:        []string{"heartbeat", "心跳", "followup", "follow-up", "跟进", "任务", "schedule", "排队"},
	},
	{
		Topic:           improvementTopicMemoryInternal,
		ClusterKey:      improvementClusterBotAutonomy,
		Title:           "Repeated bot feedback should be internalized into memory",
		DesiredBehavior: "Promote repeated bot feedback into lesson candidates and stable memory instead of leaving it only in daily notes or ad-hoc explanations.",
		Severity:        improvementSignalSeverityHigh,
		Keywords:        []string{"memory", "记忆", "内化", "lesson", "lessons", "candidate", "memory.md", "agents.md", "做梦", "梦"},
	},
	{
		Topic:           improvementTopicProgressNoise,
		ClusterKey:      improvementClusterBotExperience,
		Title:           "Interim progress updates should stay quiet and sparse",
		DesiredBehavior: "Do not spam repetitive interim status messages; only surface meaningful opening or closure signals in-thread.",
		Severity:        improvementSignalSeverityMedium,
		Keywords:        []string{"马上回来", "继续查", "继续跑", "继续翻", "烦", "刷屏", "噪音", "noise", "progress", "吵", "烦人"},
	},
	{
		Topic:           improvementTopicToolCapability,
		ClusterKey:      improvementClusterBotCapability,
		Title:           "Bot should proactively use available execution tools",
		DesiredBehavior: "When bash/python/node/repo access is available, the bot should investigate with tools directly and state concrete capability limits honestly.",
		Severity:        improvementSignalSeverityHigh,
		Keywords:        []string{"bash", "python", "node", "js", "javascript", "playwright", "repo", "desktop", "gui", "环境", "不会用", "做不到", "tool", "工具", "自己捞", "twitter", "x.com"},
	},
	{
		Topic:           improvementTopicProactivity,
		ClusterKey:      improvementClusterBotAutonomy,
		Title:           "Bot should intervene when it can add concrete value",
		DesiredBehavior: "Do not treat “people are already talking” as an automatic skip; intervene when the bot can add issue hygiene, verification, or a useful synthesis.",
		Severity:        improvementSignalSeverityHigh,
		Keywords:        []string{"不主动", "太保守", "skip", "no action", "不介入", "应该参与", "主动", "收口", "跟进"},
	},
	{
		Topic:           improvementTopicReplyQuality,
		ClusterKey:      improvementClusterBotExperience,
		Title:           "Reply feedback should shape future assistant behavior",
		DesiredBehavior: "Treat reply helpful/not-helpful signals as durable behavior feedback, not just an audit trail.",
		Severity:        improvementSignalSeverityMedium,
		Keywords:        []string{"helpful", "not helpful", "有帮助", "没帮助", "回复质量", "答非所问", "体验不一样", "不一致"},
	},
	{
		Topic:           improvementTopicActionSuggestion,
		ClusterKey:      improvementClusterBotAutonomy,
		Title:           "Action suggestions should learn from user acceptance and rejection",
		DesiredBehavior: "Use confirmation and dismissal outcomes to tune when the bot proactively offers actions like create_issue.",
		Severity:        improvementSignalSeverityMedium,
		Keywords:        []string{"建 issue", "create issue", "suggested issue", "确认", "dismiss", "confirm", "建议建", "要不要建"},
	},
	{
		Topic:           improvementTopicPendingActionHygiene,
		ClusterKey:      improvementClusterBotAutonomy,
		Title:           "Pending action reminders should auto-clean",
		DesiredBehavior: "Automatically clean up stale pending-action reminders so the heartbeat queue stays focused on real follow-up work.",
		Severity:        improvementSignalSeverityMedium,
	},
}

func (s *Service) maybeRecordThreadImprovementSignals(ctx context.Context, channelID, threadTS, msgTS, sessionID, userText, transcript, assistantText string) {
	if s == nil || s.improvements == nil {
		return
	}
	signals := buildImprovementSignals(channelID, threadTS, msgTS, sessionID, userText, transcript, assistantText)
	if len(signals) == 0 {
		return
	}
	if err := s.recordImprovementSignals(ctx, signals); err != nil {
		s.logger.Warn("slack improvement signal record failed", "error", err, "channel", channelID, "thread_ts", threadTS)
	}
}

func (s *Service) maybeRecordInboundImprovementSignal(ctx context.Context, message SlackInboundMessage) {
	message = normalizeSlackInboundMessage(message)
	s.maybeRecordThreadImprovementSignals(
		ctx,
		message.ChannelID,
		firstNonEmpty(message.ThreadTS, message.TS, message.EventTS),
		firstNonEmpty(message.TS, message.EventTS),
		"scanner:"+firstNonEmpty(message.ChannelID, "channel"),
		message.Text,
		"",
		"",
	)
}

func buildImprovementSignals(channelID, threadTS, msgTS, sessionID, userText, transcript, assistantText string) []SlackImprovementSignal {
	baseText := strings.TrimSpace(strings.Join([]string{userText, transcript}, "\n"))
	if baseText == "" {
		return nil
	}
	specs := selfGrowthTopicSpecs(baseText)
	if len(specs) == 0 {
		return nil
	}
	summary := selectImprovementSignalSummary(userText, transcript, assistantText)
	if summary == "" {
		return nil
	}
	explicit := explicitlyRequestsSelfImprovement(userText)
	records := make([]SlackImprovementSignal, 0, len(specs))
	for _, spec := range specs {
		records = append(records, newImprovementSignal(spec, improvementSignalOptions{
			SignalType: improvementSignalTypeComplaint,
			Summary:    summary,
			ChannelID:  channelID,
			ThreadTS:   threadTS,
			MsgTS:      msgTS,
			SessionID:  sessionID,
			Metadata: map[string]any{
				"source":                "meta_thread",
				"assistant_response":    truncateImprovementText(strings.TrimSpace(assistantText), 240),
				"explicit_user_request": explicit,
			},
		}))
	}
	return records
}

func (s *Service) recordImprovementSignals(ctx context.Context, signals []SlackImprovementSignal) error {
	if s == nil || s.improvements == nil || len(signals) == 0 {
		return nil
	}
	now := timeNow().UTC()
	clusters := map[string]struct{}{}
	for _, signal := range signals {
		record, err := s.improvements.InsertSignal(ctx, signal)
		if err != nil {
			return err
		}
		if record != nil && record.ClusterKey != "" {
			clusters[record.ClusterKey] = struct{}{}
		}
	}
	for clusterKey := range clusters {
		if _, err := s.syncImprovementCluster(ctx, clusterKey, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) syncImprovementCluster(ctx context.Context, clusterKey string, now time.Time) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.improvements == nil || s.followups == nil {
		return nil, nil
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	signals, err := s.improvements.ListSignalsForCluster(ctx, clusterKey, []string{improvementSignalStatusOpen, improvementSignalStatusAbsorbed}, now.Add(-7*24*time.Hour), 200)
	if err != nil || len(signals) == 0 {
		return nil, err
	}
	summary := summarizeImprovementCluster(clusterKey, signals, now)
	if len(summary.Topics) == 0 {
		return nil, nil
	}
	followup, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        heartbeatFollowupKindSelfImprovement,
		Title:       summary.Title,
		Summary:     summary.Summary,
		SourceKind:  summary.LatestSourceKind,
		ChannelID:   summary.LatestChannelID,
		ThreadTS:    summary.LatestThreadTS,
		SourceRef:   "improvement_cluster:" + clusterKey,
		Priority:    summary.Priority,
		NextCheckAt: summary.NextCheckAt.Format(time.RFC3339Nano),
		Metadata:    improvementClusterMetadata(summary),
	})
	if err != nil {
		return nil, err
	}
	if len(summary.OpenSignalIDs) > 0 {
		if err := s.improvements.UpdateSignalStatus(ctx, summary.OpenSignalIDs, improvementSignalStatusAbsorbed); err != nil {
			return nil, err
		}
	}
	s.syncImprovementArtifacts(summary, signals)
	return followup, nil
}

func selfGrowthTopicSpecs(text string) []improvementTopicSpec {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return nil
	}
	seen := map[string]struct{}{}
	var specs []improvementTopicSpec
	for _, spec := range improvementTopicCatalog {
		if len(spec.Keywords) == 0 || !containsAnyImprovement(normalized, spec.Keywords...) {
			continue
		}
		if _, ok := seen[spec.Topic]; ok {
			continue
		}
		seen[spec.Topic] = struct{}{}
		specs = append(specs, spec)
	}
	return specs
}

func explicitlyRequestsSelfImprovement(text string) bool {
	text = strings.ToLower(strings.TrimSpace(text))
	if text == "" {
		return false
	}
	return containsAnyImprovement(text,
		"please fix", "please improve", "should improve", "should fix", "改一改", "修一下", "优化一下", "内化",
		"要", "应该", "希望", "尽量", "自动", "不要人工", "自我成长", "自己改", "做梦", "记下来",
	)
}

func containsAnyImprovement(text string, candidates ...string) bool {
	for _, candidate := range candidates {
		if candidate != "" && strings.Contains(text, strings.ToLower(candidate)) {
			return true
		}
	}
	return false
}

func selectImprovementSignalSummary(userText, transcript, assistantText string) string {
	candidates := make([]string, 0, 8)
	if text := sanitizeImprovementSummaryCandidate(userText); text != "" {
		candidates = append(candidates, text)
	}
	candidates = append(candidates, transcriptImprovementSummaryCandidates(transcript)...)
	if summary := pickBestImprovementSummary(candidates); summary != "" {
		return summary
	}
	if text := sanitizeImprovementSummaryCandidate(assistantText); text != "" {
		return text
	}
	return ""
}

func transcriptImprovementSummaryCandidates(transcript string) []string {
	if strings.TrimSpace(transcript) == "" {
		return nil
	}
	var candidates []string
	for _, line := range strings.Split(transcript, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "[ts:") {
			continue
		}
		idx := strings.Index(line, "]")
		if idx == -1 || idx+1 >= len(line) {
			continue
		}
		body := strings.TrimSpace(line[idx+1:])
		colon := strings.Index(body, ":")
		if colon == -1 || colon+1 >= len(body) {
			continue
		}
		speaker := strings.TrimSpace(body[:colon])
		text := sanitizeImprovementSummaryCandidate(body[colon+1:])
		if text == "" || strings.Contains(strings.ToLower(speaker), "[assistant]") {
			continue
		}
		candidates = append(candidates, text)
	}
	return candidates
}

func sanitizeImprovementSummaryCandidate(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	best := ""
	bestScore := -1 << 30
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = strings.TrimPrefix(line, "User <@U09KNU8QD1V> says:")
		line = strings.TrimPrefix(line, "---")
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Thread metadata:") ||
			strings.HasPrefix(line, "Durable context:") ||
			strings.HasPrefix(line, "Thread ledger:") ||
			strings.HasPrefix(line, "Thread context:") {
			continue
		}
		line = strings.Join(strings.Fields(line), " ")
		score := scoreImprovementSummary(line)
		if score > bestScore {
			bestScore = score
			best = line
		}
	}
	if bestScore <= 0 {
		return ""
	}
	return truncateImprovementText(best, 180)
}

func scoreImprovementSummary(text string) int {
	text = strings.TrimSpace(strings.ToLower(text))
	if text == "" {
		return -1000
	}
	switch text {
	case "test", "testing", "ping", "ok", "okay", "hello", "hi", "test @onee_sama", "@onee_sama test":
		return -100
	}
	score := len([]rune(text))
	shortChinese := containsNonASCII(text) && len([]rune(text)) >= 2
	if len([]rune(text)) < 4 && !shortChinese {
		score -= 40
	}
	if len([]rune(text)) < 8 && !shortChinese {
		score -= 20
	}
	if containsAnyImprovement(text, "heartbeat", "心跳", "memory", "记忆", "lesson", "内化", "做梦", "梦", "进度", "噪音", "bash", "python", "主动", "follow-up", "followup", "跟进", "tool", "工具") {
		score += 60
	}
	if containsAnyImprovement(text, "应该是完成了", "完成了", "done", "resolved") {
		score -= 15
	}
	if strings.HasPrefix(text, ">") {
		score -= 8
	}
	return score
}

func containsNonASCII(text string) bool {
	for _, r := range text {
		if r > 127 {
			return true
		}
	}
	return false
}

func pickBestImprovementSummary(candidates []string) string {
	best := ""
	bestScore := -1 << 30
	for _, candidate := range compactUniqueStrings(candidates) {
		score := scoreImprovementSummary(candidate)
		if score > bestScore {
			bestScore = score
			best = candidate
		}
	}
	if bestScore <= 0 {
		return ""
	}
	return truncateImprovementText(best, 180)
}

type improvementSignalOptions struct {
	SignalType string
	Summary    string
	ChannelID  string
	ThreadTS   string
	MsgTS      string
	SessionID  string
	Metadata   map[string]any
}

func newImprovementSignal(spec improvementTopicSpec, opts improvementSignalOptions) SlackImprovementSignal {
	return SlackImprovementSignal{
		Topic:           spec.Topic,
		SignalType:      opts.SignalType,
		Summary:         opts.Summary,
		DesiredBehavior: spec.DesiredBehavior,
		Severity:        spec.Severity,
		Confidence:      0.9,
		ChannelID:       strings.TrimSpace(opts.ChannelID),
		ThreadTS:        strings.TrimSpace(opts.ThreadTS),
		MsgTS:           strings.TrimSpace(opts.MsgTS),
		SessionID:       strings.TrimSpace(opts.SessionID),
		ClusterKey:      spec.ClusterKey,
		Status:          improvementSignalStatusOpen,
		Metadata:        opts.Metadata,
	}
}

func summarizeImprovementCluster(clusterKey string, signals []SlackImprovementSignal, now time.Time) improvementClusterSummary {
	summary := improvementClusterSummary{
		ClusterKey:  clusterKey,
		Priority:    heartbeatFollowupPriorityNormal,
		NextCheckAt: now.Add(2 * time.Hour),
	}
	if len(signals) == 0 {
		return summary
	}
	topicCounts := map[string]int{}
	distinctThreads := map[string]struct{}{}
	desired := []string{}
	lessonCandidates := []string{}
	threadEvidence := map[string]*improvementThreadEvidence{}
	var latest *SlackImprovementSignal
	explicit := false
	openIDs := make([]int64, 0, len(signals))
	for _, signal := range signals {
		if latest == nil || signal.CreatedAt > latest.CreatedAt {
			copy := signal
			latest = &copy
		}
		topicCounts[signal.Topic]++
		if signal.ChannelID != "" && signal.ThreadTS != "" {
			threadKey := signal.ChannelID + "/" + signal.ThreadTS
			distinctThreads[threadKey] = struct{}{}
			evidence := threadEvidence[threadKey]
			if evidence == nil {
				evidence = &improvementThreadEvidence{ChannelID: signal.ChannelID, ThreadTS: signal.ThreadTS}
				threadEvidence[threadKey] = evidence
			}
			evidence.SignalCount++
			if signal.Topic != "" && !stringSliceContains(evidence.Topics, signal.Topic) {
				evidence.Topics = append(evidence.Topics, signal.Topic)
			}
			if candidate := sanitizeImprovementSummaryCandidate(signal.Summary); candidate != "" {
				if current := sanitizeImprovementSummaryCandidate(evidence.RepresentativeSummary); scoreImprovementSummary(candidate) > scoreImprovementSummary(current) {
					evidence.RepresentativeSummary = candidate
				}
			}
		}
		if signal.Status == improvementSignalStatusOpen {
			openIDs = append(openIDs, signal.ID)
		}
		if signal.DesiredBehavior != "" && !stringSliceContains(desired, signal.DesiredBehavior) {
			desired = append(desired, signal.DesiredBehavior)
		}
		if spec, ok := selfGrowthTopicSpecByTopic(signal.Topic); ok {
			if !stringSliceContains(summary.Topics, spec.Topic) {
				summary.Topics = append(summary.Topics, spec.Topic)
			}
			summary.Priority = maxHeartbeatPriority(summary.Priority, severityToHeartbeatPriority(signal.Severity))
		}
		if raw, ok := signal.Metadata["explicit_user_request"].(bool); ok && raw {
			explicit = true
		}
		if slug := lessonCandidateSlugForTopic(signal.Topic); slug != "" {
			path := filepath.ToSlash(filepath.Join("memory", "lessons", "candidates", slug+".md"))
			if !stringSliceContains(lessonCandidates, path) {
				lessonCandidates = append(lessonCandidates, path)
			}
		}
	}
	summary.OpenSignalIDs = openIDs
	summary.SignalCount = len(signals)
	summary.DistinctThreads7d = len(distinctThreads)
	summary.ExplicitUserRequest = explicit
	summary.EligibleForMemory = explicit || summary.DistinctThreads7d >= 2
	summary.EligibleForRepoPR = summary.EligibleForMemory
	summary.LessonCandidates = lessonCandidates
	for topic, count := range topicCounts {
		summary.TopicCounts = append(summary.TopicCounts, SlackImprovementTopicCount{Topic: topic, Count: count})
	}
	sort.SliceStable(summary.TopicCounts, func(i, j int) bool {
		if summary.TopicCounts[i].Count == summary.TopicCounts[j].Count {
			return summary.TopicCounts[i].Topic < summary.TopicCounts[j].Topic
		}
		return summary.TopicCounts[i].Count > summary.TopicCounts[j].Count
	})
	if latest != nil {
		summary.LatestSourceKind = normalizeImprovementSourceKind(latest.ChannelID, latest.ThreadTS)
		summary.LatestChannelID = latest.ChannelID
		summary.LatestThreadTS = latest.ThreadTS
	}
	summary.EvidenceSummaries = improvementSignalSummaries(signals, 3)
	for _, evidence := range threadEvidence {
		sort.Strings(evidence.Topics)
		summary.EvidenceThreads = append(summary.EvidenceThreads, *evidence)
	}
	sort.SliceStable(summary.EvidenceThreads, func(i, j int) bool {
		if summary.EvidenceThreads[i].SignalCount != summary.EvidenceThreads[j].SignalCount {
			return summary.EvidenceThreads[i].SignalCount > summary.EvidenceThreads[j].SignalCount
		}
		if summary.EvidenceThreads[i].ChannelID != summary.EvidenceThreads[j].ChannelID {
			return summary.EvidenceThreads[i].ChannelID < summary.EvidenceThreads[j].ChannelID
		}
		return summary.EvidenceThreads[i].ThreadTS < summary.EvidenceThreads[j].ThreadTS
	})
	switch clusterKey {
	case improvementClusterBotCapability:
		summary.Title = "Improve bot execution capabilities"
	case improvementClusterBotExperience:
		summary.Title = "Improve bot conversation experience"
	default:
		summary.Title = "Improve bot autonomy and follow-through"
	}
	var topicLabels []string
	for _, item := range summary.TopicCounts {
		topicLabels = append(topicLabels, fmt.Sprintf("%s×%d", item.Topic, item.Count))
	}
	evidenceText := ""
	if len(summary.EvidenceSummaries) > 0 {
		evidenceText = fmt.Sprintf(" Recent evidence: %s.", truncateImprovementText(strings.Join(summary.EvidenceSummaries, " | "), 220))
	}
	summary.Summary = fmt.Sprintf("Recent self-growth signals: %s. Desired behavior: %s.%s",
		strings.Join(topicLabels, ", "),
		truncateImprovementText(strings.Join(compactUniqueStrings(desired), " "), 220),
		evidenceText,
	)
	return summary
}

func improvementClusterMetadata(summary improvementClusterSummary) map[string]any {
	return map[string]any{
		"cluster_key":           summary.ClusterKey,
		"topics":                summary.Topics,
		"topic_counts":          summary.TopicCounts,
		"open_signal_ids":       summary.OpenSignalIDs,
		"signal_count_7d":       summary.SignalCount,
		"distinct_threads_7d":   summary.DistinctThreads7d,
		"explicit_user_request": summary.ExplicitUserRequest,
		"eligible_for_memory":   summary.EligibleForMemory,
		"eligible_for_repo_pr":  summary.EligibleForRepoPR,
		"lesson_candidates":     summary.LessonCandidates,
		"evidence_summaries":    summary.EvidenceSummaries,
		"evidence_threads":      summary.EvidenceThreads,
		"cluster_kind":          "self_growth",
	}
}

func selfGrowthTopicSpecByTopic(topic string) (improvementTopicSpec, bool) {
	for _, spec := range improvementTopicCatalog {
		if spec.Topic == topic {
			return spec, true
		}
	}
	return improvementTopicSpec{}, false
}

func severityToHeartbeatPriority(severity string) string {
	switch normalizeImprovementSignalSeverity(severity) {
	case improvementSignalSeverityCritical:
		return heartbeatFollowupPriorityUrgent
	case improvementSignalSeverityHigh:
		return heartbeatFollowupPriorityHigh
	default:
		return heartbeatFollowupPriorityNormal
	}
}

func maxHeartbeatPriority(a, b string) string {
	rank := map[string]int{
		heartbeatFollowupPriorityUrgent: 0,
		heartbeatFollowupPriorityHigh:   1,
		heartbeatFollowupPriorityNormal: 2,
		heartbeatFollowupPriorityLow:    3,
	}
	if rank[b] < rank[a] {
		return b
	}
	return a
}

func lessonCandidateSlugForTopic(topic string) string {
	if strings.TrimSpace(topic) == "" {
		return ""
	}
	return normalizeMemoryTag("bot-self-growth-" + topic)
}

func (s *Service) syncImprovementArtifacts(summary improvementClusterSummary, signals []SlackImprovementSignal) {
	if s == nil || strings.TrimSpace(s.workspaceDir) == "" {
		return
	}
	topicSignals := map[string][]SlackImprovementSignal{}
	for _, signal := range signals {
		topicSignals[signal.Topic] = append(topicSignals[signal.Topic], signal)
	}
	var memoryLines []string
	for topic, items := range topicSignals {
		spec, ok := selfGrowthTopicSpecByTopic(topic)
		if !ok {
			continue
		}
		lines := improvementSignalSummaries(items, 3)
		if err := recordLessonCandidate(s.workspaceDir, lessonCandidate{
			Slug:      lessonCandidateSlugForTopic(topic),
			Scope:     "self_growth",
			Title:     spec.Title,
			SourceRef: "improvement_cluster:" + summary.ClusterKey,
			Impact:    improvementLessonImpact(spec, lines),
			WhatHappened: fmt.Sprintf("Recent bot feedback threads repeatedly surfaced topic %q across %d signals in cluster %q.",
				topic, len(items), summary.ClusterKey),
			Guardrail: spec.DesiredBehavior,
		}); err != nil {
			s.logger.Warn("slack improvement lesson candidate write failed", "topic", topic, "error", err)
		}
		if summary.EligibleForMemory {
			memoryLines = append(memoryLines, fmt.Sprintf("- %s: %s", topic, spec.DesiredBehavior))
		}
	}
	if summary.EligibleForMemory && len(memoryLines) > 0 {
		if err := upsertSelfGrowthMemoryBlock(s.workspaceDir, compactUniqueStrings(memoryLines)); err != nil {
			s.logger.Warn("slack self-growth memory block update failed", "error", err)
		}
	}
}

func improvementSignalSummaries(items []SlackImprovementSignal, limit int) []string {
	if len(items) == 0 || limit == 0 {
		return nil
	}
	lines := make([]string, 0, len(items))
	for _, item := range items {
		if summary := sanitizeImprovementSummaryCandidate(item.Summary); summary != "" {
			lines = append(lines, summary)
		}
	}
	lines = compactUniqueStrings(lines)
	sort.SliceStable(lines, func(i, j int) bool {
		scoreI := scoreImprovementSummary(lines[i])
		scoreJ := scoreImprovementSummary(lines[j])
		if scoreI == scoreJ {
			return lines[i] < lines[j]
		}
		return scoreI > scoreJ
	})
	if limit < 0 || limit > len(lines) {
		limit = len(lines)
	}
	return lines[:limit]
}

func improvementLessonImpact(spec improvementTopicSpec, lines []string) string {
	var good []string
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), ">") {
			continue
		}
		if scoreImprovementSummary(line) < 40 {
			continue
		}
		good = append(good, line)
	}
	if len(good) > 0 {
		return truncateImprovementText(strings.Join(good, " | "), 280)
	}
	return defaultImprovementImpact(spec.Topic)
}

func defaultImprovementImpact(topic string) string {
	switch topic {
	case improvementTopicHeartbeatTasking:
		return "Recent feedback shows heartbeat follow-through is still not being turned into durable queued work."
	case improvementTopicMemoryInternal:
		return "Recent feedback shows bot lessons are still too easy to leave in daily notes instead of promoting into stable memory."
	case improvementTopicProgressNoise:
		return "Recent feedback shows repetitive progress chatter still hurts the thread experience."
	case improvementTopicToolCapability:
		return "Recent feedback shows the bot still underuses available execution tools when it should verify things directly."
	case improvementTopicProactivity:
		return "Recent feedback shows the bot still skips too often when it could add concrete value."
	case improvementTopicActionSuggestion:
		return "Recent feedback shows action suggestions still need to learn from user acceptance and rejection."
	case improvementTopicReplyQuality:
		return "Recent feedback shows reply feedback should more directly shape future behavior."
	case improvementTopicPendingActionHygiene:
		return "Recent feedback shows stale pending-action reminders can still pollute the heartbeat queue."
	default:
		return "Recent feedback shows this bot behavior still needs durable improvement."
	}
}

func upsertSelfGrowthMemoryBlock(workspaceDir string, lines []string) error {
	if strings.TrimSpace(workspaceDir) == "" || len(lines) == 0 {
		return nil
	}
	target, err := safeWorkspaceMemoryPath(workspaceDir, "MEMORY.md")
	if err != nil {
		return err
	}
	existing, _ := os.ReadFile(target)
	content := string(existing)
	lines = mergeSelfGrowthMemoryLines(content, lines)
	block := "## Bot Self-Growth\n\n" + selfGrowthMemoryStart + "\n" + strings.Join(lines, "\n") + "\n" + selfGrowthMemoryEnd
	switch {
	case strings.Contains(content, selfGrowthMemoryStart) && strings.Contains(content, selfGrowthMemoryEnd):
		start := strings.Index(content, selfGrowthMemoryStart)
		end := strings.Index(content, selfGrowthMemoryEnd)
		if start >= 0 && end >= start {
			headingStart := selfGrowthHeadingStart(content, start)
			prefix := strings.TrimRight(content[:headingStart], "\n")
			suffix := strings.TrimLeft(content[end+len(selfGrowthMemoryEnd):], "\n")
			content = strings.TrimSpace(strings.Join([]string{prefix, block, suffix}, "\n\n")) + "\n"
		}
	case strings.TrimSpace(content) == "":
		content = block + "\n"
	default:
		content = strings.TrimSpace(content) + "\n\n" + block + "\n"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func mergeSelfGrowthMemoryLines(content string, lines []string) []string {
	lines = mergeSelfGrowthLinesByTopic(nil, lines)
	start := strings.Index(content, selfGrowthMemoryStart)
	end := strings.Index(content, selfGrowthMemoryEnd)
	if start == -1 || end == -1 || end < start {
		return lines
	}
	var existing []string
	body := content[start+len(selfGrowthMemoryStart) : end]
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "- ") {
			existing = append(existing, line)
		}
	}
	return mergeSelfGrowthLinesByTopic(existing, lines)
}

func mergeSelfGrowthLinesByTopic(existing, incoming []string) []string {
	merged := map[string]string{}
	var order []string
	record := func(line string) {
		line = strings.TrimSpace(strings.Join(strings.Fields(line), " "))
		if !strings.HasPrefix(line, "- ") {
			return
		}
		key := strings.ToLower(line)
		if idx := strings.Index(line[2:], ":"); idx >= 0 {
			key = strings.ToLower(strings.TrimSpace(line[2 : 2+idx]))
		}
		if _, ok := merged[key]; !ok {
			order = append(order, key)
		}
		merged[key] = line
	}
	for _, line := range existing {
		record(line)
	}
	for _, line := range incoming {
		record(line)
	}
	out := make([]string, 0, len(order))
	for _, key := range order {
		if line := merged[key]; line != "" {
			out = append(out, line)
		}
	}
	return compactUniqueStrings(out)
}

func selfGrowthHeadingStart(content string, markerStart int) int {
	if markerStart <= 0 || markerStart > len(content) {
		return markerStart
	}
	heading := "## Bot Self-Growth"
	start := markerStart
	for start > 0 {
		lineStart := strings.LastIndex(content[:start-1], "\n")
		if lineStart == -1 {
			lineStart = 0
		} else {
			lineStart++
		}
		line := strings.TrimSpace(content[lineStart:start])
		if line == "" || line == heading {
			start = lineStart
			continue
		}
		break
	}
	return start
}

func normalizeImprovementSourceKind(channelID, threadTS string) string {
	switch {
	case strings.TrimSpace(channelID) == "":
		return "dm"
	case strings.TrimSpace(threadTS) != "":
		return "thread"
	default:
		return "slack_channel"
	}
}

func truncateImprovementText(value string, maxLen int) string {
	value = strings.TrimSpace(value)
	if maxLen <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxLen {
		return value
	}
	if maxLen <= 1 {
		return string(runes[:maxLen])
	}
	return strings.TrimSpace(string(runes[:maxLen-1])) + "…"
}
