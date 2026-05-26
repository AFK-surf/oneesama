package slackagent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) claimFinalizedWorkerJob(id string) bool {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return false
	}
	s.workerReportMu.Lock()
	defer s.workerReportMu.Unlock()
	if _, exists := s.finalizedWorkerJobIDs[trimmed]; exists {
		return false
	}
	s.finalizedWorkerJobIDs[trimmed] = struct{}{}
	return true
}

func slackRefForWorkerJob(job agentrunner.Job) (AssistantThreadRef, bool) {
	slack, ok := mapFromAny(job.Context["slack"])
	if !ok {
		return AssistantThreadRef{}, false
	}
	ref := AssistantThreadRef{
		ChannelID: firstNonEmpty(
			stringFromAny(slack["channel_id"]),
			stringFromAny(slack["channelId"]),
			stringFromAny(slack["channel"]),
		),
		ThreadTS: firstNonEmpty(
			stringFromAny(slack["thread_ts"]),
			stringFromAny(slack["threadTs"]),
		),
		ReactionTS: firstNonEmpty(
			stringFromAny(slack["reaction_ts"]),
			stringFromAny(slack["reactionTs"]),
			stringFromAny(slack["event_ts"]),
			stringFromAny(slack["eventTs"]),
		),
		UserID: firstNonEmpty(
			stringFromAny(slack["user_id"]),
			stringFromAny(slack["userId"]),
		),
	}
	if ref.ChannelID == "" {
		return AssistantThreadRef{}, false
	}
	return ref, true
}

func isPersonaDelegatedWorkerJob(job agentrunner.Job) bool {
	return strings.EqualFold(stringFromContext(job.Context, "source"), "persona_delegate_worker")
}

func isDirectMentionWorkerJob(job agentrunner.Job) bool {
	slack, _ := mapFromAny(job.Context["slack"])
	command := firstNonEmpty(
		stringFromAny(slack["command"]),
		stringFromAny(slack["mode"]),
	)
	if isSlackMentionCommandMode(command) {
		return true
	}
	if _, ok := job.Context["slackAppMention"]; ok {
		return true
	}
	if _, ok := job.Context["slack_app_mention"]; ok {
		return true
	}
	return false
}

// slackWorkerResultText returns the model's actual completed result for posting
// to Slack. Every non-completed state (failed / timeout / auth / canceled), any
// completed-with-empty-result, and any completed-result containing an internal
// gateway leak returns the empty string so that postSlackWorkerResult silently
// skips the post. Status is conveyed via the mention reaction, not via
// hardcoded user-facing template strings.
func slackWorkerResultText(job agentrunner.Job) string {
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	text := agentrunner.WorkerResultEnvelopeCompletedText(envelope)
	if text == "" {
		return ""
	}
	if isPersonaSecretaryLookupWorkerJob(job) {
		visibleText, anchors, _, ok := slackSecretaryLookupWorkerVisibleResult(text)
		if !ok || !slackVisibleReplyHasAllowListEvidenceAnchor(anchors, visibleText) {
			return ""
		}
		text = visibleText
	}
	if slackVisibleTextContainsInternalLeak(text) {
		return ""
	}
	if slackVisibleTextIsTransitionalAnnouncement(text) {
		return ""
	}
	if slackVisibleTextIsUnverifiableSecretaryLookupSpeculation(job, text) {
		return ""
	}
	return text
}

func slackSecretaryLookupWorkerVisibleResult(text string) (string, []SlackVisibleEvidenceAnchor, string, bool) {
	var mapped map[string]any
	if err := json.Unmarshal([]byte(stripSlackWorkerResultJSONFence(text)), &mapped); err != nil {
		return "", nil, "", false
	}
	visibleText := strings.TrimSpace(firstNonEmpty(
		stringFromAny(mapped["visible_text"]),
		stringFromAny(mapped["visibleText"]),
		stringFromAny(mapped["message"]),
		stringFromAny(mapped["text"]),
		stringFromAny(mapped["summary"]),
	))
	anchors := slackVisibleEvidenceAnchorsFromAny(firstNonEmptyAny(
		mapped["evidence_anchors"],
		mapped["evidenceAnchors"],
		mapped["evidence"],
	))
	if visibleText == "" || len(anchors) == 0 {
		return "", anchors, "", false
	}
	reason := strings.TrimSpace(firstNonEmpty(
		stringFromAny(mapped["reason"]),
		stringFromAny(mapped["why"]),
		stringFromAny(mapped["summary_reason"]),
	))
	return visibleText, anchors, reason, true
}

func stripSlackWorkerResultJSONFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "```") {
		trimmed = strings.TrimPrefix(trimmed, "```json")
		trimmed = strings.TrimPrefix(trimmed, "```JSON")
		trimmed = strings.TrimPrefix(trimmed, "```")
		trimmed = strings.TrimSuffix(trimmed, "```")
	}
	return strings.TrimSpace(trimmed)
}

func slackVisibleTextContainsInternalLeak(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	for _, marker := range []string{
		"127.0.0.1:8780",
		"localhost:8780",
		"/slack/tools/call",
		"x-oneesama-internal-key",
		"local slack tool gateway",
		"the persona",
		"persona already",
		"persona classified",
		"persona has classified",
		"persona determined",
		"persona decided",
		"根据 persona",
		"persona 分析",
		"persona 判定",
		"persona 已判定",
		"persona 已经判定",
		"foreground triage",
		"pi-first foreground",
		"delegate_worker",
		"post_thread_reply",
		"agent_runner",
		"<｜｜dsml｜｜",
		"</｜｜dsml｜｜",
		"<tool_calls>",
		"</tool_calls>",
		"<|im_start|>",
		"<|im_end|>",
		"<|tool_call|>",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return (strings.Contains(lower, "127.0.0.1") || strings.Contains(lower, "localhost")) &&
		strings.Contains(lower, "curl") &&
		(strings.Contains(lower, "connection refused") ||
			strings.Contains(lower, "failed to connect") ||
			strings.Contains(lower, "could not connect") ||
			strings.Contains(lower, "exit status 7"))
}

func slackVisibleTextIsTransitionalAnnouncement(text string) bool {
	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)
	if lower == "" {
		return false
	}
	if len([]rune(trimmed)) > 180 {
		return false
	}
	for _, marker := range []string{
		"让我找找",
		"让我找一下",
		"让我查查",
		"让我查一下",
		"我找找",
		"我来找",
		"我先找",
		"我查一下",
		"我看一下",
		"我先看",
		"我去定位",
		"我开始修",
		"下一步我会",
		"let me check",
		"let me look",
		"i'll check",
		"i will check",
		"i'm going to check",
		"working on it",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func slackVisibleTextIsUnverifiableSecretaryLookupSpeculation(job agentrunner.Job, text string) bool {
	if !isPersonaSecretaryLookupWorkerJob(job) {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	if !slackVisibleTextContainsAny(lower, []string{
		"loading shared chat",
		"shared chat…",
		"没加载出来",
		"没法直接看到",
		"无法直接看到",
		"无法看到",
		"无法访问",
		"访问不了",
		"看不到实际",
		"看不到正文",
		"没拿到正文",
		"could not access",
		"couldn't access",
		"could not verify",
		"couldn't verify",
		"could not see",
		"couldn't see",
		"insufficient evidence",
		"not enough evidence",
	}) {
		return false
	}
	return slackVisibleTextContainsAny(lower, []string{
		"可以拼出",
		"拼出概况",
		"结合 repo",
		"结合 memory",
		"结合历史",
		"结合上下文",
		"推断",
		"猜测",
		"猜一下",
		"可能",
		"很可能",
		"大概率",
		"像是",
		"应该是",
		"speculate",
		"speculation",
		"guess",
		"likely",
		"probably",
		"based on memory",
		"based on context",
	})
}

func isPersonaSecretaryLookupWorkerJob(job agentrunner.Job) bool {
	if agentrunner.NormalizeSessionKind(stringFromContext(job.Context, "session_kind", "sessionKind")) == agentrunner.SessionKindSecretaryLookup {
		return true
	}
	scope := strings.ToLower(stringFromContext(job.Context, "delegation_scope", "delegationScope"))
	if scope == "secretary_lookup" {
		return true
	}
	if nested, ok := mapFromAny(job.Context["worker_context"]); ok {
		scope = strings.ToLower(firstNonEmpty(
			stringFromAny(nested["delegation_scope"]),
			stringFromAny(nested["delegationScope"]),
			stringFromAny(nested["session_kind"]),
			stringFromAny(nested["sessionKind"]),
		))
		return scope == "secretary_lookup"
	}
	return false
}

func slackVisibleTextContainsAny(text string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func assistantStatusTextForJob(job agentrunner.Job) string {
	if job.Status != agentrunner.StatusRunning {
		return ""
	}
	return "Working on it..."
}

func isTerminalJobStatus(status agentrunner.JobStatus) bool {
	return status == agentrunner.StatusCompleted || status == agentrunner.StatusFailed || status == agentrunner.StatusTimeout
}

func mapFromAny(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		return typed, true
	case map[string]string:
		mapped := make(map[string]any, len(typed))
		for key, item := range typed {
			mapped[key] = item
		}
		return mapped, true
	default:
		return nil, false
	}
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}
