package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	slackDelayedNoReplyFollowupKind  = "delayed_no_reply"
	slackDelayedNoReplyFollowupDelay = 90 * time.Minute
)

type slackDelayedNoReplyCandidate struct {
	Classification string
	Title          string
	Summary        string
}

func (s *Service) maybeRecordDelayedNoReplyFollowup(ctx context.Context, workspaceID string, channelID string, threadTS string, run *SlackTriageContext, decision SlackTriageDecision, messages []SlackInboundMessage) {
	if s == nil || s.followups == nil || run == nil {
		return
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = firstNonEmpty(threadTS, lastMessageThreadTS(messages))
	if channelID == "" || threadTS == "" || threadTS == "channel-root" {
		return
	}
	candidate, ok := slackDelayedNoReplyCandidateFor(decision, messages)
	if !ok {
		return
	}
	now := timeNow().UTC()
	if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       candidate.Title,
		Summary:     candidate.Summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   channelID,
		ThreadTS:    threadTS,
		SourceRef:   fmt.Sprintf("delayed_no_reply:%s:%s", channelID, threadTS),
		Priority:    heartbeatFollowupPriorityNormal,
		NextCheckAt: now.Add(slackDelayedNoReplyFollowupDelay).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"source":         "slack_triage",
			"classification": candidate.Classification,
			"triage_run_id":  run.ID,
			"triage_session": run.SessionID,
			"workspace_id":   firstNonEmpty(workspaceID, "workspace"),
			"one_shot":       true,
		},
	}); err != nil {
		s.logger.Warn("slack delayed no-reply followup create failed", "channel", channelID, "thread_ts", threadTS, "error", err)
	}
}

func slackDelayedNoReplyCandidateFor(decision SlackTriageDecision, messages []SlackInboundMessage) (slackDelayedNoReplyCandidate, bool) {
	messageText := strings.TrimSpace(joinSlackMessageTexts(messages))
	if messageText == "" || slackDelayedNoReplyLooksLowSignal(messageText) {
		return slackDelayedNoReplyCandidate{}, false
	}
	summary := strings.TrimSpace(decision.Summary)
	if !slackTriageDecisionLooksDeferred(summary) &&
		!slackMessagesLookLikeUnansweredQuestion(messages) &&
		!slackMessagesLookLikeStuckHelp(messages) &&
		!slackMessagesHaveArticleOrDocumentLinks(messages) {
		return slackDelayedNoReplyCandidate{}, false
	}
	classification := slackDelayedNoReplyClassification(summary, messages)
	title := buildDelayedNoReplyTitle(classification, messageText)
	summary = buildDelayedNoReplySummary(classification, messageText)
	if strings.TrimSpace(summary) == "" {
		return slackDelayedNoReplyCandidate{}, false
	}
	return slackDelayedNoReplyCandidate{
		Classification: classification,
		Title:          title,
		Summary:        summary,
	}, true
}

func slackTriageDecisionLooksDeferred(summary string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(summary)), " "))
	if normalized == "" {
		return false
	}
	for _, phrase := range loadTriageKeywordListTemplate("delayed_no_reply_deferred_keywords", []string{
		"wait for human",
		"wait for humans",
		"waiting for human",
		"let others reply",
		"see if anyone",
		"monitor",
		"no action for now",
		"no action needed yet",
		"先等",
		"等人",
		"等其他人",
		"暂时不用回",
		"暂不回复",
		"先观察",
		"看看有没有人",
	}) {
		if strings.Contains(normalized, phrase) {
			return true
		}
	}
	return false
}

func slackDelayedNoReplyClassification(summary string, messages []SlackInboundMessage) string {
	if slackTriageDecisionLooksDeferred(summary) {
		return "stale_wait_for_human"
	}
	if slackMessagesLookLikeStuckHelp(messages) {
		return "stuck_or_handoff"
	}
	if slackMessagesLookLikeUnansweredQuestion(messages) {
		return "unanswered_question"
	}
	if slackMessagesHaveArticleOrDocumentLinks(messages) {
		return "link_followup_candidate"
	}
	return "synthesis_eligible_thread"
}

func slackMessagesLookLikeUnansweredQuestion(messages []SlackInboundMessage) bool {
	text := strings.ToLower(joinSlackMessageTexts(messages))
	if strings.ContainsAny(text, "?？") {
		return true
	}
	for _, phrase := range loadTriageKeywordListTemplate("delayed_no_reply_question_keywords", []string{
		"要不要",
		"是不是",
		"能不能",
		"怎么办",
		"怎么做",
		"怎么看",
		"有没有",
		"why",
		"how should",
		"should we",
		"can we",
		"any thoughts",
		"wdyt",
	}) {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func slackMessagesLookLikeStuckHelp(messages []SlackInboundMessage) bool {
	text := strings.ToLower(joinSlackMessageTexts(messages))
	for _, phrase := range loadTriageKeywordListTemplate("delayed_no_reply_stuck_keywords", []string{
		"卡住",
		"没反应",
		"失败",
		"报错",
		"挂了",
		"help",
		"stuck",
		"blocked",
		"failed",
		"broken",
		"error",
		"handoff",
	}) {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func slackMessagesHaveArticleOrDocumentLinks(messages []SlackInboundMessage) bool {
	for _, rawURL := range extractSlackExternalLinkURLs(messages) {
		if looksLikeArticleOrDocumentURL(rawURL) {
			return true
		}
	}
	return false
}

func slackDelayedNoReplyLooksLowSignal(text string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(text)), " "))
	if normalized == "" {
		return true
	}
	for _, phrase := range loadTriageKeywordListTemplate("delayed_no_reply_low_signal_keywords", []string{"哈哈", "lol", "lgtm", "+1", "收到", "ack", "ok", "thanks", "谢谢"}) {
		if normalized == phrase {
			return true
		}
	}
	return len([]rune(normalized)) < 12 && !strings.ContainsAny(normalized, "?？")
}

func buildDelayedNoReplyTitle(classification string, messageText string) string {
	language := "en"
	if containsCJK(messageText) {
		language = "zh"
	}
	if rendered, err := renderTriageReplyTemplate("delayed_no_reply_title", language, triageReplyTemplateData{
		Classification: classification,
		MessageText:    messageText,
		Language:       language,
	}); err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return strings.ReplaceAll(strings.TrimSpace(classification), "_", " ")
}

func buildDelayedNoReplySummary(classification string, messageText string) string {
	snippet := truncateSlackContextText(strings.Join(strings.Fields(messageText), " "), 180)
	language := "en"
	if containsCJK(messageText) {
		language = "zh"
	}
	if rendered, err := renderTriageReplyTemplate(delayedNoReplyTemplateName(classification), language, triageReplyTemplateData{
		Classification: classification,
		MessageText:    messageText,
		Snippet:        snippet,
		Language:       language,
	}); err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return ""
}

func delayedNoReplyTemplateName(classification string) string {
	switch strings.TrimSpace(classification) {
	case "link_followup_candidate":
		return "delayed_no_reply_link"
	case "stuck_or_handoff":
		return "delayed_no_reply_stuck"
	default:
		return "delayed_no_reply_default"
	}
}
