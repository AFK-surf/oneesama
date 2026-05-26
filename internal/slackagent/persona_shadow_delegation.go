package slackagent

import (
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

type personaDelegatedWorkerStartResult struct {
	JobIDs    []string
	Errors    []string
	ToolCalls []SlackTriageToolCall
	Failures  int
}

func (s *Service) applyPersonaSecretaryDelegationPolicy(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	allowed := make([]persona.WorkerRequest, 0, len(result.workerRecords))
	toolCalls := make([]SlackTriageToolCall, 0)
	for _, request := range result.workerRecords {
		ok, reason := personaDelegatedWorkerAllowedBySecretaryPolicy(request)
		if ok {
			allowed = append(allowed, request)
			continue
		}
		toolCalls = append(toolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker_blocked_scope",
			Args:    marshalTriageArgs(firstNonEmpty(strings.TrimSpace(request.Kind), "worker"), strings.TrimSpace(request.ID), false),
			Success: true,
			Brief:   "Persona delegate_worker blocked by secretary routing policy",
			Result:  reason,
		})
	}
	if len(toolCalls) == 0 {
		return result, nil
	}
	blockedShouldStaySilent := len(allowed) == 0 && personaDelegateBlockShouldStaySilent(result)
	result.workerRecords = allowed
	result.WorkerRequests = personaWorkerRequestSummaries(allowed)
	if len(allowed) == 0 && strings.TrimSpace(result.VisibleText) == "" {
		if blockedShouldStaySilent {
			result.Decision = persona.DecisionStaySilent
			result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker blocked; no safe visible reply"))
			toolCalls = append(toolCalls, SlackTriageToolCall{
				Tool:    "agent_runner",
				Action:  "delegate_worker_blocked_silent",
				Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
				Success: true,
				Brief:   "Persona delegate_worker block downgraded to silence",
				Result:  "blocked secretary lookup produced no safe visible reply",
			})
			return result, toolCalls
		}
		result.Decision = persona.DecisionReply
		result.VisibleText = slackPersonaSecretaryRoutingText()
		result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker blocked by secretary routing policy"))
		if result.Confidence < 0.7 {
			result.Confidence = 0.7
		}
	}
	return result, toolCalls
}

func applyPersonaWorkerReturnNoDelegateDisposition(result SlackPersonaShadowResult, request persona.Request) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !personaRequestIsWorkerReturn(request) || !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "worker-result second pass cannot recursively delegate"))
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "worker_result_delegate_blocked_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona worker-result second pass cannot delegate again",
		Result:  "worker_return_second_pass",
	}}
}

func applyPersonaCompletedDelegationDisposition(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	marker := personaCompletedDelegationMarker(result)
	if marker == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker suppressed because the thread is already handled"))
	return result, []SlackTriageToolCall{{
		Tool:    "agent_runner",
		Action:  "delegate_worker_already_handled_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona delegate_worker suppressed because reason says no further action",
		Result:  marker,
	}}
}

func personaCompletedDelegationMarker(result SlackPersonaShadowResult) string {
	text := strings.Join([]string{
		strings.TrimSpace(result.Reason),
		strings.TrimSpace(result.VisibleText),
	}, "\n")
	if strings.TrimSpace(text) == "" {
		return ""
	}
	if marker := triageQualityRunIsHandledByOther(text); marker != "" {
		return marker
	}
	lower := strings.ToLower(text)
	for _, marker := range []string{
		"no further triage action needed",
		"no further action needed",
		"no further action is needed",
		"no additional action needed",
		"no action needed",
		"nothing for me to add",
		"nothing to add",
		"fully handled",
		"already completed",
		"completed workflow thread",
		"no open human request",
		"already determined this thread is handled",
		"无需进一步处理",
		"无需进一步动作",
		"不需要进一步处理",
		"不需要再处理",
		"无需再处理",
		"无需介入",
		"不用介入",
		"这轮 review 已完成",
	} {
		if strings.Contains(lower, strings.ToLower(marker)) {
			return marker
		}
	}
	return ""
}

func applyPersonaAmbientDelegationDisposition(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	reason := personaAmbientDelegationSilentReason(result, messages, botUserID)
	if reason == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker suppressed because the Slack item was not addressed to Oneesama"))
	return result, []SlackTriageToolCall{{
		Tool:    "agent_runner",
		Action:  "delegate_worker_ambient_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona delegate_worker suppressed for ambient/non-addressed triage",
		Result:  reason,
	}}
}

func applyPersonaAmbientDirectReplyDisposition(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		return result, nil
	}
	reason := personaAmbientDirectReplySilentReason(result, messages, botUserID)
	if reason == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "direct reply suppressed because the Slack item was not addressed to Oneesama"))
	return result, []SlackTriageToolCall{{
		Tool:    "slack_api",
		Action:  "persona_reply_ambient_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona direct reply suppressed for ambient/non-addressed triage",
		Result:  reason,
	}}
}

func applyPersonaVisibleReplyQualityDisposition(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		return result, nil
	}
	reason := slackVisibleReplyQualityBlockReason(result.VisibleText)
	if reason == "" {
		return result, nil
	}
	if reason == "reading_process_narration" && personaVisibleReplyIsSourceBackedLinkSynthesis(result) {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "visible reply suppressed by Slack-visible quality gate"))
	return result, []SlackTriageToolCall{{
		Tool:    "slack_api",
		Action:  "persona_reply_quality_gate_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona direct reply suppressed by Slack-visible quality gate",
		Result:  reason,
	}}
}

func personaVisibleReplyIsSourceBackedLinkSynthesis(result SlackPersonaShadowResult) bool {
	if !strings.Contains(strings.ToLower(strings.TrimSpace(result.Reason)), "synthesis-eligible") {
		return false
	}
	for _, anchor := range normalizeSlackVisibleEvidenceAnchors(result.EvidenceAnchors) {
		if strings.TrimSpace(anchor.Kind) != slackVisibleEvidenceKindFetchedLink {
			continue
		}
		if slackVisibleEvidenceAnchorLooksLikeReaderFailure(anchor) {
			continue
		}
		return true
	}
	return false
}

func personaAmbientDirectReplySilentReason(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) string {
	if slackMessagesMentionOtherUsersWithoutBot(messages, botUserID) {
		return "mentioned_other_user_without_bot"
	}
	if personaMessagesAddressBot(messages, botUserID) {
		return ""
	}
	if slackMessagesHaveFetchableExternalLinks(messages) {
		return ""
	}
	text := strings.Join([]string{
		strings.TrimSpace(result.VisibleText),
		strings.TrimSpace(result.Reason),
	}, "\n")
	if personaDirectReplyLooksSpeculative(text) {
		return "ambient_speculative_direct_reply"
	}
	if slackTriageDirectRepliesShouldStaySilent(messages, botUserID) {
		return "ambient_direct_reply_without_bot_mention"
	}
	return ""
}

func personaMessagesAddressBot(messages []SlackInboundMessage, botUserID string) bool {
	if strings.TrimSpace(botUserID) == "" {
		return false
	}
	for _, message := range messages {
		if slackTextMentionsUser(message.Text, botUserID) {
			return true
		}
	}
	return false
}

func personaDirectReplyLooksSpeculative(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	return slackVisibleTextContainsAny(lower, []string{
		"可能",
		"很可能",
		"大概率",
		"像是",
		"应该是",
		"要不要看看",
		"看看最近",
		"推断",
		"猜测",
		"speculate",
		"guess",
		"likely",
		"probably",
		"maybe",
		"might be",
		"could be",
	})
}

func personaAmbientDelegationSilentReason(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) string {
	if slackMessagesMentionOtherUsersWithoutBot(messages, botUserID) {
		return "mentioned_other_user_without_bot"
	}
	reason := strings.ToLower(strings.TrimSpace(result.Reason))
	if reason == "" {
		return ""
	}
	noExplicitAskMarkers := []string{
		"no explicit question",
		"no explicit ask",
		"no explicit request",
		"no @oneesama",
		"no @mention",
		"没有明确问题",
		"没有明确请求",
		"没有 @oneesama",
		"未 @oneesama",
	}
	var sawMarker bool
	for _, marker := range noExplicitAskMarkers {
		if strings.Contains(reason, strings.ToLower(marker)) {
			sawMarker = true
			break
		}
	}
	if !sawMarker {
		return ""
	}
	if slackMessagesHaveFetchableExternalLinks(messages) || personaMessagesContainExplicitQuestion(messages, botUserID) {
		return ""
	}
	return "no_explicit_question_or_bot_mention"
}

func personaMessagesContainExplicitQuestion(messages []SlackInboundMessage, botUserID string) bool {
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		return false
	}
	if botUserID != "" && slackTextMentionsUser(text, botUserID) {
		return true
	}
	lower := strings.ToLower(text)
	if strings.ContainsAny(text, "?？") {
		return true
	}
	for _, marker := range []string{"什么", "怎么", "咋", "为啥", "为什么", "吗", "么", "啥", "看看", "查一下", "看一下", "帮我", "how", "what", "why", "can you", "could you"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
