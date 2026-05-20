package slackagent

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

var slackDigestMessageTSPattern = regexp.MustCompile(`msg_ts:([0-9]+\.[0-9]+)`)

func (s *Service) recoverOrphanedPersonaForegroundTriage(ctx context.Context) {
	if s == nil || s.triage == nil {
		return
	}
	runs, err := s.triage.ListRuns(ctx, 0)
	if err != nil {
		s.logger.Warn("persona foreground orphan recovery list failed", "error", err)
		return
	}
	var recovered int
	for _, run := range runs {
		if !s.recoverOneOrphanedPersonaForegroundTriage(ctx, run) {
			continue
		}
		recovered++
	}
	if recovered > 0 {
		s.logger.Warn("persona foreground orphaned triage recovered", "count", recovered)
	}
}

func (s *Service) recoverOneOrphanedPersonaForegroundTriage(ctx context.Context, run SlackTriageContext) bool {
	if !boolFromAny(run.Metadata["persona_foreground_queued"], false) {
		return false
	}
	if _, ok := mapFromAny(run.Metadata["persona_foreground"]); ok {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(run.Status), "pending") {
		return false
	}
	startedAt := s.startedAt.UTC()
	timestamp := parseTriageTimestamp(run.Timestamp).UTC()
	if startedAt.IsZero() || timestamp.IsZero() || !timestamp.Before(startedAt) {
		return false
	}
	channelID := slackTriageRunChannelID(run)
	threadTS := slackTriageRunThreadTS(run)
	workspaceID := firstNonEmpty(stringFromAny(run.Metadata["workspace_id"]), stringFromAny(run.Metadata["workspaceId"]), "workspace")
	errText := "persona foreground orphaned after slack-agent restart before completion"
	result := SlackPersonaShadowResult{
		RequestID:  firstNonEmpty(strings.TrimSpace(run.SessionID), fmt.Sprintf("triage:%d", run.ID)),
		Source:     "triage",
		ChannelID:  channelID,
		ThreadTS:   threadTS,
		Decision:   persona.DecisionStaySilent,
		Success:    false,
		ShadowOnly: false,
		Error:      errText,
		Reason:     "Slack agent restarted while Pi-first foreground triage was in flight; fail-closed and schedule a retry instead of leaving the run queued.",
	}
	patch := run
	patch.Status = "failed"
	patch.Error = errText
	patch.Failures = maxInt(patch.Failures, 1)
	patch.ToolCalls = replacePersonaRuntimeToolCall(patch.ToolCalls, "foreground_triage", slackPersonaForegroundToolCall(result))
	patch.Metadata = mergeStringAnyMaps(run.Metadata, map[string]any{
		"persona_foreground":                        result,
		"persona_foreground_queued":                 false,
		"persona_foreground_done_at":                nowRFC3339(),
		"persona_foreground_orphaned_after_restart": true,
		"persona_foreground_orphan_needs_retry":     true,
		"pi_first_decision":                         persona.DecisionStaySilent,
	})
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		s.logger.Warn("persona foreground orphan recovery update failed", "triage_run_id", run.ID, "error", err)
		return false
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
		s.maybeRecordTriageEmptyFinalFollowup(ctx, workspaceID, channelID, threadTS, updated, nil, map[string]any{
			"failure_source": "persona_foreground_orphan",
			"error":          errText,
		})
	}
	return true
}

func slackTriageRunChannelID(run SlackTriageContext) string {
	if value := strings.TrimSpace(firstNonEmpty(stringFromAny(run.Metadata["channel_id"]), stringFromAny(run.Metadata["channelId"]))); value != "" {
		return value
	}
	if len(run.Channels) > 0 {
		return strings.TrimSpace(run.Channels[0])
	}
	return ""
}

func slackTriageRunThreadTS(run SlackTriageContext) string {
	if value := strings.TrimSpace(firstNonEmpty(stringFromAny(run.Metadata["thread_ts"]), stringFromAny(run.Metadata["threadTs"]))); value != "" {
		return value
	}
	matches := slackDigestMessageTSPattern.FindStringSubmatch(run.Digest)
	if len(matches) == 2 {
		return strings.TrimSpace(matches[1])
	}
	return ""
}

func slackPersonaForegroundTimedOut(result SlackPersonaShadowResult) bool {
	text := strings.ToLower(strings.Join([]string{result.Error, result.Reason}, "\n"))
	return strings.Contains(text, "context deadline exceeded") ||
		strings.Contains(text, "timed out") ||
		strings.Contains(text, "timeout")
}

func (s *Service) maybeRecordPersonaForegroundTimeoutFollowup(ctx context.Context, workspaceID string, channelID string, threadTS string, run *SlackTriageContext, result SlackPersonaShadowResult) {
	if s == nil || s.followups == nil || run == nil || !slackPersonaForegroundTimedOut(result) {
		return
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" || threadTS == "" || threadTS == "channel-root" {
		return
	}
	language := "en"
	if containsCJK(run.Digest) || containsCJK(run.Summary) {
		language = "zh"
	}
	templateData := triageReplyTemplateData{
		Classification: "triage_timeout_needs_retry",
		ChannelID:      channelID,
		ThreadTS:       threadTS,
		Snippet:        truncateSlackContextText(firstNonEmpty(run.Summary, run.Digest), 240),
		Language:       language,
	}
	title := renderTriageTimeoutTemplate("triage_timeout_title", language, templateData, mapBool(language == "zh", "补看这条 Pi foreground 超时判断", "Retry this Pi foreground triage"))
	summary := renderTriageTimeoutTemplate("triage_timeout_summary", language, templateData, mapBool(language == "zh", "上一轮 Pi foreground 判断超时；如果线程没有继续推进，我会补一次轻量判断。", "The last Pi foreground triage timed out. If the thread stays unanswered, re-check it with a lighter context."))
	metadata := map[string]any{
		"source":         "slack_triage",
		"classification": "triage_timeout_needs_retry",
		"triage_run_id":  run.ID,
		"triage_session": run.SessionID,
		"workspace_id":   firstNonEmpty(workspaceID, "workspace"),
		"failure_source": "persona_foreground",
		"error":          truncateSlackContextText(firstNonEmpty(result.Error, result.Reason), 400),
		"one_shot":       true,
	}
	now := timeNow().UTC()
	if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        slackTriageTimeoutFollowupKind,
		Title:       title,
		Summary:     summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   channelID,
		ThreadTS:    threadTS,
		SourceRef:   fmt.Sprintf("triage_timeout_retry:%s:%s", channelID, threadTS),
		Priority:    heartbeatFollowupPriorityNormal,
		NextCheckAt: now.Add(slackTriageTimeoutFollowupDelay).Format(time.RFC3339Nano),
		Metadata:    metadata,
	}); err != nil {
		s.logger.Warn("slack persona foreground timeout followup create failed", "channel", channelID, "thread_ts", threadTS, "error", err)
	}
}
