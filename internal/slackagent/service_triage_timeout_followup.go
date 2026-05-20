package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	slackTriageTimeoutFollowupKind  = "triage_timeout_retry"
	slackTriageTimeoutFollowupDelay = 15 * time.Minute

	slackTriageEmptyFinalFollowupKind  = "triage_empty_final_retry"
	slackTriageEmptyFinalFollowupDelay = 15 * time.Minute
)

func (s *Service) maybeRecordTriageTimeoutFollowup(ctx context.Context, workspaceID string, channelID string, threadTS string, run *SlackTriageContext, job agentrunner.Job, messages []SlackInboundMessage) {
	if s == nil || s.followups == nil || run == nil || !slackTriageJobTimedOut(job) {
		return
	}
	channelID = strings.TrimSpace(firstNonEmpty(channelID, firstMessageChannelID(messages)))
	threadTS = strings.TrimSpace(firstNonEmpty(threadTS, lastMessageThreadTS(messages)))
	if channelID == "" || threadTS == "" || threadTS == "channel-root" {
		return
	}
	language := "en"
	messageText := strings.TrimSpace(joinSlackMessageTexts(messages))
	if containsCJK(messageText) {
		language = "zh"
	}
	templateData := triageReplyTemplateData{
		Classification: "triage_timeout_needs_retry",
		ChannelID:      channelID,
		ThreadTS:       threadTS,
		MessageText:    messageText,
		Snippet:        truncateSlackContextText(firstNonEmpty(messageText, run.Summary, run.Digest), 240),
		Language:       language,
	}
	title := renderTriageTimeoutTemplate("triage_timeout_title", language, templateData, mapBool(language == "zh", "补看这条长讨论", "Retry this long thread"))
	summary := renderTriageTimeoutTemplate("triage_timeout_summary", language, templateData, mapBool(language == "zh", "这条讨论上下文很长，上一轮没有完整判断；如果线程没有继续推进，我会补一次轻量判断。", "This thread had enough context to time out the last triage pass. If it stays unanswered, re-check it with a lighter context."))
	now := timeNow().UTC()
	metadata := map[string]any{
		"source":         "slack_triage",
		"classification": "triage_timeout_needs_retry",
		"triage_run_id":  run.ID,
		"triage_session": run.SessionID,
		"workspace_id":   firstNonEmpty(workspaceID, "workspace"),
		"job_id":         strings.TrimSpace(job.ID),
		"job_status":     string(job.Status),
		"one_shot":       true,
	}
	if errText := truncateSlackContextText(firstNonEmpty(job.Error, job.Result), 400); errText != "" {
		metadata["error"] = errText
	}
	for _, key := range []string{"input_context_chars", "message_count", "thread_context_count", "thread_context_messages", "context_fetch_reason"} {
		if value, ok := run.Metadata[key]; ok {
			metadata[key] = value
		}
	}
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
		s.logger.Warn("slack triage timeout followup create failed", "channel", channelID, "thread_ts", threadTS, "error", err)
	}
}

func slackTriageJobTimedOut(job agentrunner.Job) bool {
	if job.Status == agentrunner.StatusTimeout {
		return true
	}
	text := strings.ToLower(strings.Join([]string{string(job.Status), job.Error, job.Result, job.Debug}, "\n"))
	return strings.Contains(text, "timed out") || strings.Contains(text, "timeout")
}

func (s *Service) maybeRecordTriageEmptyFinalFollowup(ctx context.Context, workspaceID string, channelID string, threadTS string, run *SlackTriageContext, messages []SlackInboundMessage, details map[string]any) {
	if s == nil || s.followups == nil || run == nil {
		return
	}
	channelID = strings.TrimSpace(firstNonEmpty(channelID, firstMessageChannelID(messages)))
	threadTS = strings.TrimSpace(firstNonEmpty(threadTS, lastMessageThreadTS(messages)))
	if channelID == "" || threadTS == "" || threadTS == "channel-root" {
		return
	}
	language := "en"
	messageText := strings.TrimSpace(joinSlackMessageTexts(messages))
	if containsCJK(messageText) {
		language = "zh"
	}
	templateData := triageReplyTemplateData{
		Classification: "triage_empty_final_needs_retry",
		ChannelID:      channelID,
		ThreadTS:       threadTS,
		MessageText:    messageText,
		Snippet:        truncateSlackContextText(firstNonEmpty(messageText, run.Summary, run.Digest), 240),
		Language:       language,
	}
	title := renderTriageTimeoutTemplate("triage_empty_final_title", language, templateData, mapBool(language == "zh", "补看这条未完成判断", "Retry incomplete triage"))
	summary := renderTriageTimeoutTemplate("triage_empty_final_summary", language, templateData, mapBool(language == "zh", "上一轮 triage 没有产出可用判断；如果线程没有继续推进，我会补一次轻量判断。", "The last triage pass returned no usable final response. If the thread stays unanswered, re-check it instead of dropping it."))
	metadata := map[string]any{
		"source":         "slack_triage",
		"classification": "triage_empty_final_needs_retry",
		"triage_run_id":  run.ID,
		"triage_session": run.SessionID,
		"workspace_id":   firstNonEmpty(workspaceID, "workspace"),
		"one_shot":       true,
	}
	for key, value := range details {
		if strings.TrimSpace(key) == "" || value == nil {
			continue
		}
		metadata[key] = value
	}
	for _, key := range []string{"input_context_chars", "message_count", "thread_context_count", "thread_context_messages", "context_fetch_reason"} {
		if value, ok := run.Metadata[key]; ok {
			metadata[key] = value
		}
	}
	now := timeNow().UTC()
	if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        slackTriageEmptyFinalFollowupKind,
		Title:       title,
		Summary:     summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   channelID,
		ThreadTS:    threadTS,
		SourceRef:   fmt.Sprintf("triage_empty_final_retry:%s:%s", channelID, threadTS),
		Priority:    heartbeatFollowupPriorityNormal,
		NextCheckAt: now.Add(slackTriageEmptyFinalFollowupDelay).Format(time.RFC3339Nano),
		Metadata:    metadata,
	}); err != nil {
		s.logger.Warn("slack triage empty final followup create failed", "channel", channelID, "thread_ts", threadTS, "error", err)
	}
}

func (s *Service) resolveTriageRetryFollowups(ctx context.Context, channelID string, threadTS string, resolution string) {
	if s == nil || s.followups == nil {
		return
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" || threadTS == "" || threadTS == "channel-root" {
		return
	}
	for _, kind := range []string{slackTriageTimeoutFollowupKind, slackTriageEmptyFinalFollowupKind} {
		sourceRef := fmt.Sprintf("%s:%s:%s", kind, channelID, threadTS)
		if _, err := s.followups.ResolveFollowupBySourceRef(ctx, sourceRef, "done", resolution); err != nil {
			s.logger.Warn("slack triage retry followup resolve failed", "source_ref", sourceRef, "error", err)
		}
	}
}

func slackTriageJobEmptyFinal(job agentrunner.Job) bool {
	text := strings.ToLower(strings.Join([]string{job.Error, job.Result, job.Debug}, "\n"))
	return strings.Contains(text, "empty final response with no mutations")
}

func renderTriageTimeoutTemplate(name string, language string, data triageReplyTemplateData, fallback string) string {
	if rendered, err := renderTriageReplyTemplate(name, language, data); err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return fallback
}
