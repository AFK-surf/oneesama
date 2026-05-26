package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

func personaRequestContextText(items []persona.ContextItem, kind string) string {
	for _, item := range items {
		if item.Kind == kind {
			return item.Text
		}
	}
	return ""
}

func slackTextContainsSecretaryLookupQuestion(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"这是谁", "是谁", "这是什么", "这是啥", "什么鬼", "啥意思", "什么情况", "靠不靠谱", "靠谱吗", "真假", "谁知道", "有人知道",
		"干啥", "干嘛", "做什么", "做啥", "是干啥", "是干嘛",
		"who is", "what is this", "what's this", "what does this mean", "anyone know", "is this real", "is this legit",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func slackMessagesHaveReadableMedia(messages []SlackInboundMessage) bool {
	for _, message := range normalizeSlackInboundMessages(messages) {
		for _, file := range message.Files {
			if strings.TrimSpace(firstNonEmpty(file.ID, file.Name, file.Title, file.Permalink, file.URL, file.URLPrivate, file.ImageURL)) != "" {
				return true
			}
		}
	}
	return false
}

func buildSecretaryLookupWorkerPrompt(request persona.Request) string {
	parts := []string{
		"Bounded Oneesama secretary lookup. Read the linked public source and the Slack thread context, then cross-check workspace Memory/person context if available.",
		"Do not stop at the first profile/article excerpt. If the source exposes submissions, comments, favorites, repository, author, or source links, follow those read-only leads before answering.",
		"Use available read-only tools such as exa_search, exa_contents, person_memory, memory_search, and slack_api fetch/read methods when the provided excerpt is not enough.",
		"Only return a Slack-visible answer when you have concrete evidence. Include 2-3 short evidence anchors such as URL ownership, profile details, repo links, previous workspace mentions, or memory/person records.",
		`Return only JSON matching {"visible_text":"Slack-visible answer","evidence_anchors":[{"kind":"fetched_link|workspace_memory|person_memory|slack_thread|file|image|worker_result|explicit_user_command","source_ref":"stable source ref or URL","quote":"short quoted source fact"}],"reason":"private audit reason"}.`,
		`If evidence is insufficient, return {"visible_text":"","evidence_anchors":[],"reason":"insufficient_evidence"} instead of guessing or posting a routing/refusal template.`,
	}
	if digest := strings.TrimSpace(personaRequestContextText(request.Context, "triage_digest")); digest != "" {
		parts = append(parts, "\nTriage digest:\n"+digest)
	}
	if thread := strings.TrimSpace(personaRequestContextText(request.Context, "slack_thread_context")); thread != "" {
		parts = append(parts, "\nSlack thread context:\n"+thread)
	}
	if external := strings.TrimSpace(personaRequestContextText(request.Context, "external_link_context")); external != "" {
		parts = append(parts, "\nFetched external link context:\n"+external)
	}
	if memory := personaRequestMemoryEvidence(request, 5); memory != "" {
		parts = append(parts, "\nWorkspace Memory/person evidence:\n"+memory)
	}
	return strings.Join(parts, "\n")
}

func buildMediaLookupWorkerPrompt(request persona.Request) string {
	parts := []string{
		"Bounded Oneesama secretary media lookup. Inspect the Slack thread and attached file/image evidence, then answer only if the media evidence is concrete enough.",
		"Use available read-only tools such as slack_api fetch/read methods, slack.fetchImage, slack.fetchFile, person_memory, and memory_search when needed.",
		"Do not answer from filename or thumbnail vibes alone. If the question asks what a screenshot/image/file is, fetch and inspect the content first.",
		"Only return a Slack-visible answer when you have concrete evidence. Include 2-3 short evidence anchors from the image/file/thread or workspace Memory/person records.",
		`Return only JSON matching {"visible_text":"Slack-visible answer","evidence_anchors":[{"kind":"fetched_link|workspace_memory|person_memory|slack_thread|file|image|worker_result|explicit_user_command","source_ref":"stable source ref or Slack file_id","quote":"short quoted source fact"}],"reason":"private audit reason"}.`,
		`If evidence is insufficient, return {"visible_text":"","evidence_anchors":[],"reason":"insufficient_evidence"} instead of guessing.`,
	}
	if digest := strings.TrimSpace(personaRequestContextText(request.Context, "triage_digest")); digest != "" {
		parts = append(parts, "\nTriage digest:\n"+digest)
	}
	if thread := strings.TrimSpace(personaRequestContextText(request.Context, "slack_thread_context")); thread != "" {
		parts = append(parts, "\nSlack thread context:\n"+thread)
	}
	if memory := personaRequestMemoryEvidence(request, 5); memory != "" {
		parts = append(parts, "\nWorkspace Memory/person evidence:\n"+memory)
	}
	return strings.Join(parts, "\n")
}

func personaRequestMemoryEvidence(request persona.Request, limit int) string {
	if limit <= 0 || len(request.Memory.Items) == 0 {
		return ""
	}
	lines := make([]string, 0, limit)
	for _, record := range request.Memory.Items {
		if len(lines) >= limit {
			break
		}
		text := truncateSlackContextText(strings.TrimSpace(sanitizeSlackVisibleText(record.Text)), 420)
		if text == "" {
			continue
		}
		source := strings.TrimSpace(record.SourceRef)
		kind := strings.TrimSpace(record.Kind)
		label := firstNonEmpty(source, kind, "memory")
		if kind != "" && source != "" {
			label += " [" + kind + "]"
		}
		lines = append(lines, fmt.Sprintf("%d. %s: %s", len(lines)+1, label, text))
	}
	return strings.Join(lines, "\n")
}

func personaDelegateBlockShouldStaySilent(result SlackPersonaShadowResult) bool {
	for _, request := range result.workerRecords {
		scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
			stringFromAny(request.Context["delegation_scope"]),
			stringFromAny(request.Context["scope"]),
			stringFromAny(request.Context["worker_scope"]),
		)))
		text := strings.TrimSpace(strings.Join([]string{
			request.Kind,
			request.Prompt,
			personaWorkerRequestContextText(request.Context),
			result.Reason,
		}, "\n"))
		if scope == "secretary_lookup" || scope == "workspace_memory" || personaDelegatedWorkerLooksLikeReadOnlySecretaryLookup(text) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerLooksLikeReadOnlySecretaryLookup(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"memory lookup", "workspace memory", "person_memory", "person memory", "fetch url", "read link", "linked source", "profile", "identify", "who is",
		"查 memory", "查一下 memory", "查记忆", "查人", "识别", "这是谁", "链接内容", "读链接", "发推",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerAllowedBySecretaryPolicy(request persona.WorkerRequest) (bool, string) {
	scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["delegation_scope"]),
		stringFromAny(request.Context["scope"]),
		stringFromAny(request.Context["worker_scope"]),
	)))
	switch scope {
	case "oneesama_system", "oneesama_code", "explicit_human_authorized_code":
		return true, ""
	case "external_project_code", "project_code", "project_debugging", "secretary_route":
		return false, fmt.Sprintf("delegation_scope %q is outside Oneesama secretary worker scope", scope)
	}

	text := strings.TrimSpace(strings.Join([]string{
		request.Kind,
		request.Prompt,
		personaWorkerRequestContextText(request.Context),
	}, "\n"))
	if personaDelegatedWorkerLooksLikeProjectDebugging(text) && !personaDelegatedWorkerMentionsOneesamaSystem(text) && !personaDelegatedWorkerExplicitlyAuthorized(text) {
		return false, "external project debugging should be secretary-routed instead of delegated to Codex"
	}
	switch scope {
	case "secretary_lookup", "workspace_memory":
		return true, ""
	}
	return true, ""
}

func personaWorkerRequestContextText(contextMap map[string]any) string {
	if len(contextMap) == 0 {
		return ""
	}
	payload, err := json.Marshal(contextMap)
	if err != nil {
		return fmt.Sprint(contextMap)
	}
	return string(payload)
}

func personaDelegatedWorkerLooksLikeProjectDebugging(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"staging", "production", "deploy", "deployment", "infra", "infrastructure",
		"database", "api latency", "latency", "performance", "perf", "slow", "timeout",
		"build failure", "test failure", "regression", "incident", "debug", "fix bug", "bug",
		"codebase", "source code", "recent deployments",
		"源码", "代码库", "仓库", "组件", "触发条件", "排查", "修复", "报错", "日志",
		"线上", "生产", "部署", "接口", "性能", "延迟", "超时",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerMentionsOneesamaSystem(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"oneesama", "onee sama", "onee-sama", "slack agent", "slack-agent", "meeting agent",
		"meeting-agent", "meet-runner", "agentrunner", "persona foreground", "pi foreground",
		"workspace triage", "triage policy", "daily report", "custom emoji", "memory provider",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerExplicitlyAuthorized(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	return strings.Contains(lower, "explicit_human_authorized_code") ||
		strings.Contains(lower, "explicitly human-authorized") ||
		strings.Contains(lower, "human explicitly asked") ||
		strings.Contains(lower, "peng explicitly asked")
}

func slackPersonaSecretaryRoutingText() string {
	return "这看起来是具体项目代码/环境问题，我先不直接下场查 repo。更适合走项目 owner 处理；我可以帮忙把现象、链接和影响面整理成 brief，或者在你明确授权我查 Oneesama 自身/指定代码时再派 worker。"
}

func (s *Service) startPersonaDelegatedWorkerJobs(ctx context.Context, workspaceID string, runID int64, result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) personaDelegatedWorkerStartResult {
	out := personaDelegatedWorkerStartResult{}
	if s == nil || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return out
	}
	if s.runner == nil {
		errText := "agent runner is not ready: " + runnerErrorText(s.runnerErr)
		out.Errors = append(out.Errors, errText)
		out.Failures = 1
		out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker",
			Success: false,
			Brief:   "Persona delegate_worker could not start Codex worker",
			Result:  errText,
		})
		return out
	}
	for index, workerRequest := range result.workerRecords {
		if index >= 3 {
			out.Errors = append(out.Errors, "delegate_worker_limit_exceeded")
			break
		}
		sessionKind := personaDelegatedWorkerSessionKind(workerRequest)
		if sessionKind == agentrunner.SessionKindSecretaryLookup {
			workerRequest = enrichPersonaSecretaryLookupWorkerRequest(workerRequest, request)
		}
		prompt := strings.TrimSpace(workerRequest.Prompt)
		if prompt == "" {
			prompt = "Handle the delegated Slack task from Pi foreground triage."
		}
		workerID := firstNonEmpty(strings.TrimSpace(workerRequest.ID), fmt.Sprintf("%s:worker:%d", result.RequestID, index+1))
		handoff := personaDelegatedWorkerHandoff(workerRequest, sessionKind, workerID, result, request, messages)
		contextMap := mergeStringAnyMaps(workerRequest.Context, map[string]any{
			"source":        "persona_delegate_worker",
			"sessionId":     firstNonEmpty(strings.TrimSpace(result.RequestID), fmt.Sprintf("triage:%d", runID)),
			"session_id":    firstNonEmpty(strings.TrimSpace(result.RequestID), fmt.Sprintf("triage:%d", runID)),
			"workspaceId":   workspaceID,
			"workspace_id":  workspaceID,
			"triageRunId":   runID,
			"triage_run_id": runID,
			"handoff":       handoff,
			"slack": map[string]any{
				"workspaceId": workspaceID,
				"channelId":   strings.TrimSpace(result.ChannelID),
				"channel_id":  strings.TrimSpace(result.ChannelID),
				"threadTs":    strings.TrimSpace(result.ThreadTS),
				"thread_ts":   strings.TrimSpace(result.ThreadTS),
			},
			"persona": map[string]any{
				"request_id": result.RequestID,
				"decision":   result.Decision,
				"reason":     result.Reason,
				"confidence": result.Confidence,
				"worker_id":  workerID,
			},
		}, personaDelegatedWorkerSlackContext(result.ChannelID, result.ThreadTS, messages))
		job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
			Task:             prompt,
			Context:          contextMap,
			Mode:             "analysis",
			AllowCodeChanges: false,
		}, sessionKind))
		if err != nil {
			errText := err.Error()
			out.Errors = append(out.Errors, errText)
			out.Failures = 1
			out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
				Tool:    "agent_runner",
				Action:  "delegate_worker",
				Args:    marshalTriageArgs("persona", workerID, false),
				Success: false,
				Brief:   "Persona delegate_worker start failed",
				Result:  errText,
			})
			continue
		}
		out.JobIDs = append(out.JobIDs, job.ID)
		out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker",
			Args:    marshalTriageArgs(job.Provider, job.ID, true),
			Success: true,
			Brief:   "Persona delegated worker started",
			Result:  prompt,
		})
	}
	if len(out.Errors) > 0 && len(out.JobIDs) == 0 {
		out.Failures = 1
	}
	return out
}

func enrichPersonaSecretaryLookupWorkerRequest(worker persona.WorkerRequest, request persona.Request) persona.WorkerRequest {
	if worker.Context == nil {
		worker.Context = map[string]any{}
	}
	if value := personaRequestContextText(request.Context, "external_link_context"); strings.TrimSpace(value) != "" && strings.TrimSpace(stringFromAny(worker.Context["external_link_context"])) == "" {
		worker.Context["external_link_context"] = value
	}
	if value := personaRequestContextText(request.Context, "triage_digest"); strings.TrimSpace(value) != "" && strings.TrimSpace(stringFromAny(worker.Context["triage_digest"])) == "" {
		worker.Context["triage_digest"] = value
	}
	if value := personaRequestMemoryEvidence(request, 5); value != "" && strings.TrimSpace(stringFromAny(worker.Context["workspace_memory_evidence"])) == "" {
		worker.Context["workspace_memory_evidence"] = value
	}
	prompt := strings.TrimSpace(worker.Prompt)
	var additions []string
	if !strings.Contains(prompt, "Do not stop at the first profile/article excerpt") {
		additions = append(additions,
			"Secretary lookup evidence rules:",
			"- Do not stop at the first profile/article excerpt. If the source exposes submissions, comments, favorites, repository, author, or source links, follow those read-only leads before answering.",
			"- Use available read-only tools such as exa_search, exa_contents, person_memory, memory_search, and slack_api fetch/read methods when the provided excerpt is not enough.",
			`- Only return a Slack-visible answer when you have concrete evidence. If evidence is insufficient, return {"visible_text":"","evidence_anchors":[],"reason":"insufficient_evidence"} instead of guessing or posting a routing/refusal template.`,
			`- Return only JSON matching {"visible_text":"Slack-visible answer","evidence_anchors":[{"kind":"fetched_link|workspace_memory|person_memory|slack_thread|file|image|worker_result|explicit_user_command","source_ref":"stable source ref or URL","quote":"short quoted source fact"}],"reason":"private audit reason"}.`,
		)
	}
	if external := strings.TrimSpace(stringFromAny(worker.Context["external_link_context"])); external != "" && !strings.Contains(prompt, "Fetched external link context:") {
		additions = append(additions, "Fetched external link context:\n"+external)
	}
	if memory := strings.TrimSpace(stringFromAny(worker.Context["workspace_memory_evidence"])); memory != "" && !strings.Contains(prompt, "Workspace Memory/person evidence:") {
		additions = append(additions, "Workspace Memory/person evidence:\n"+memory)
	}
	if len(additions) > 0 {
		if prompt != "" {
			prompt += "\n\n"
		}
		prompt += strings.Join(additions, "\n")
		worker.Prompt = prompt
	}
	return worker
}

func personaDelegatedWorkerSessionKind(request persona.WorkerRequest) string {
	if value := strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["session_kind"]),
		stringFromAny(request.Context["sessionKind"]),
	)); value != "" {
		return agentrunner.NormalizeSessionKind(value)
	}
	scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["delegation_scope"]),
		stringFromAny(request.Context["scope"]),
		stringFromAny(request.Context["worker_scope"]),
	)))
	if scope == "secretary_lookup" {
		return agentrunner.SessionKindSecretaryLookup
	}
	if scope == "demo_execution" || scope == "demo-execution" {
		return agentrunner.SessionKindDemoExecution
	}
	if !personaDelegatedWorkerExplicitlyAuthorized(strings.TrimSpace(request.Prompt) + " " + personaWorkerRequestContextText(request.Context)) {
		return agentrunner.SessionKindSecretaryLookup
	}
	return agentrunner.SessionKindSlack
}

func personaDelegatedWorkerSlackContext(channelID string, threadTS string, messages []SlackInboundMessage) map[string]any {
	messages = normalizeSlackInboundMessages(messages)
	if len(messages) == 0 {
		return nil
	}
	slackMessages := make([]SlackMessage, 0, len(messages))
	latestUserID := ""
	latestText := ""
	for _, message := range messages {
		ts := firstNonEmpty(message.TS, message.EventTS)
		slackMessages = append(slackMessages, SlackMessage{
			TS:         ts,
			EventTS:    firstNonEmpty(message.EventTS, ts),
			User:       message.UserID,
			UserID:     message.UserID,
			BotID:      message.BotID,
			Subtype:    message.Subtype,
			Text:       message.Text,
			Channel:    firstNonEmpty(message.ChannelID, channelID),
			ThreadTS:   firstNonEmpty(message.ThreadTS, threadTS),
			ReplyCount: message.ReplyCount,
			ReplyUsers: append([]string(nil), message.ReplyUsers...),
			Files:      append([]SlackFile(nil), message.Files...),
			Reactions:  append([]SlackReaction(nil), message.Reactions...),
		})
		if message.UserID != "" {
			latestUserID = message.UserID
		}
		if text := strings.TrimSpace(message.Text); text != "" {
			latestText = text
		}
	}
	transcriptMessages, omitted := compactSlackThreadTranscriptMessages(slackMessages, true, mentionRecentThreadTail)
	transcript := formatSlackThreadTranscript(transcriptMessages)
	transcript = annotateCompactedSlackTranscript(transcript, channelID, threadTS, omitted)
	media := extractSlackThreadMedia(slackMessages)
	mentionText := strings.TrimSpace(firstNonEmpty(latestText, joinSlackMessageTexts(messages)))
	rich := &SlackAppMentionContext{
		Kind:           "slack_persona_delegate_worker_context",
		Source:         "persona_delegate_worker",
		ChannelID:      channelID,
		ThreadTS:       threadTS,
		UserID:         latestUserID,
		MessageCount:   len(messages),
		Transcript:     transcript,
		RawMentionText: mentionText,
		MentionText:    mentionText,
		ParentInfo:     slackParentInfo(firstSlackMessage(slackMessages)),
		CanvasFiles:    append([]SlackThreadFile(nil), media.CanvasFiles...),
		Files:          append([]SlackThreadFile(nil), media.Files...),
		ImageParts:     append([]SlackThreadImage(nil), media.Images...),
		FetchOK:        true,
		FetchedAt:      nowRFC3339(),
	}
	prompt := buildSlackAssistantThreadMessage(rich)
	if len(media.Images) > 0 {
		prompt += "\n\n---\nImage reading rule:\nThis delegated Slack task includes image attachment file_ids. If the answer depends on image contents, request them with slack_api(method=\"slack.fetchImage\", params={\"file_id\":\"F...\"}) before answering, then inspect the returned local_path. The Slack URL in the tool result is protected and requires a bot token; do not curl it directly. If image evidence cannot be fetched or remains insufficient, return no visible result instead of guessing."
	}
	if delegatedSlackFilesIncludeNonImageMedia(media.Files) {
		prompt += "\n\n---\nFile reading rule:\nThis delegated Slack task includes non-image media/file attachments. If the answer depends on video, audio, PDF, archive, or other file contents, request the file with slack_api(method=\"slack.fetchFile\", params={\"file_id\":\"F...\"}) before answering. The result may include a local_path for a worker-side reader. Do not answer by saying you cannot view the media. If file evidence cannot be fetched or remains insufficient, return no visible result instead of guessing."
	}
	rich.Prompt = prompt
	out := map[string]any{
		"slackAssistantPrompt": prompt,
		"slackAppMention":      rich,
	}
	if len(media.Files) > 0 {
		out["slack_files"] = append([]SlackThreadFile(nil), media.Files...)
	}
	if len(media.Images) > 0 {
		out["slack_image_files"] = append([]SlackThreadImage(nil), media.Images...)
	}
	return out
}

func delegatedSlackFilesIncludeNonImageMedia(files []SlackThreadFile) bool {
	for _, file := range files {
		if isSlackImageFile(file) || isSlackCanvasFile(file) {
			continue
		}
		if isSlackVideoFile(file) || strings.TrimSpace(file.ID) != "" || strings.TrimSpace(file.Name) != "" {
			return true
		}
	}
	return false
}
