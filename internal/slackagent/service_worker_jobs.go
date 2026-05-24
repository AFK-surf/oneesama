package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

func (s *Service) handleAgentRunnerProgress(ctx context.Context, job agentrunner.Job) {
	if isSlackTriageJob(job) {
		return
	}
	if isPersonaDelegatedWorkerJob(job) {
		return
	}
	if job.Status != agentrunner.StatusRunning {
		return
	}
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return
	}
	s.scheduleAssistantThreadStatus(ctx, ref, assistantStatusTextForJob(job), false)
}

func (s *Service) handleAgentRunnerUpdate(ctx context.Context, job agentrunner.Job) {
	if isSlackTriageJob(job) {
		if isTerminalJobStatus(job.Status) {
			if _, err := s.finalizeSlackTriageJob(ctx, job); err != nil {
				s.logger.Warn("slack triage finalization failed", "job_id", job.ID, "error", err)
			}
		}
		return
	}
	if !isTerminalJobStatus(job.Status) || !s.claimFinalizedWorkerJob(job.ID) {
		return
	}
	if s.handleMeetingCopilotToolRequest(ctx, job) {
		return
	}
	if s.handleSlackWorkerToolRequest(ctx, job) {
		return
	}
	if isPersonaDelegatedWorkerJob(job) {
		s.reportWorkerJobToMeetingAgent(ctx, job)
		handled := s.handlePersonaDelegatedWorkerResult(ctx, job)
		if ref, ok := slackRefForWorkerJob(job); ok {
			s.scheduleAssistantThreadStatus(ctx, ref, "", true)
			if job.Status == agentrunner.StatusCompleted && handled {
				s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
			} else if job.Status == agentrunner.StatusCompleted && slackWorkerResultText(job) == "" {
				s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
			} else {
				s.finishMentionReaction(ctx, ref, slackReactionWarn)
			}
		}
		return
	}
	s.reportWorkerJobToMeetingAgent(ctx, job)
	delivered := s.postSlackWorkerResult(ctx, job)
	if ref, ok := slackRefForWorkerJob(job); ok {
		s.scheduleAssistantThreadStatus(ctx, ref, "", true)
		if job.Status == agentrunner.StatusCompleted && delivered {
			s.finishMentionReaction(ctx, ref, slackReactionOK)
		} else if job.Status == agentrunner.StatusCompleted && isPersonaDelegatedWorkerJob(job) && slackWorkerResultText(job) == "" {
			s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
		} else {
			s.finishMentionReaction(ctx, ref, slackReactionWarn)
		}
	}
}

func (s *Service) handlePersonaDelegatedWorkerResult(ctx context.Context, job agentrunner.Job) bool {
	if job.Status != agentrunner.StatusCompleted {
		return false
	}
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return false
	}
	request, messages, ok := buildPersonaDelegatedWorkerReturnRequest(job)
	if !ok {
		return false
	}
	if !s.foregroundPersonaRuntimeEnabled() {
		s.logger.Warn("persona delegated worker result skipped because foreground runtime is not ready", "job_id", job.ID)
		return false
	}
	workspaceID := firstNonEmpty(stringFromContext(job.Context, "workspaceId", "workspace_id"), "workspace")
	runID := int64FromContext(job.Context, "triageRunId", "triage_run_id")
	callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
	defer cancel()
	result := callPersonaShadow(callCtx, s.personaRuntime, "worker_return", request)
	disposition := s.applySlackPersonaForegroundDispositions(result, request, messages)
	result = disposition.Result
	actions := slackTriageVisibleReplyActionsAfterGate(slackPersonaForegroundActions(ref.ChannelID, ref.ThreadTS, result, request))
	toolCalls := []SlackTriageToolCall{personaDelegatedWorkerReturnToolCall(job, result)}
	toolCalls = append(toolCalls, disposition.ToolCalls...)
	directToolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, ref.ChannelID, ref.ThreadTS, runID, actions, slackTriageDirectActionOptions{
		SnapshotMessages: messages,
	})
	toolCalls = append(toolCalls, directToolCalls...)
	pending := s.insertSlackTriagePendingActions(ctx, workspaceID, ref.ChannelID, ref.ThreadTS, job.ID, &SlackTriageContext{ID: runID}, actions)
	toolCalls = append(toolCalls, personaTriageApprovalToolCalls(pending)...)
	if err := s.recordSlackTriagePersonaForegroundResult(ctx, workspaceID, runID, result, actions, toolCalls, failures, mutations); err != nil {
		s.logger.Warn("persona delegated worker second-pass record failed", "job_id", job.ID, "triage_run_id", runID, "error", err)
	}
	return result.Success && failures == 0
}

func buildPersonaDelegatedWorkerReturnRequest(job agentrunner.Job) (persona.Request, []SlackInboundMessage, bool) {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return persona.Request{}, nil, false
	}
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	workerText := agentrunner.WorkerResultEnvelopeCompletedText(envelope)
	if strings.TrimSpace(workerText) == "" {
		return persona.Request{}, nil, false
	}
	visibleText, anchors, reason := workerText, []SlackVisibleEvidenceAnchor{{
		Kind:      slackVisibleEvidenceKindWorkerResult,
		SourceRef: firstNonEmpty(strings.TrimSpace(job.ID), "persona_delegate_worker"),
		Quote:     workerText,
	}}, ""
	if isPersonaSecretaryLookupWorkerJob(job) {
		if parsedText, parsedAnchors, parsedReason, ok := slackSecretaryLookupWorkerVisibleResult(workerText); ok {
			visibleText, anchors, reason = parsedText, parsedAnchors, parsedReason
		}
	}
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	messages := personaDelegatedWorkerReturnMessages(job, ref)
	contextItems := []persona.ContextItem{
		{
			Kind: "worker_return_instruction",
			Text: "The delegated worker result is evidence only, not a message to post. Re-read the original Slack request and the worker evidence, then decide the next Oneesama action. If replying, rewrite in Oneesama's own concise human-facing voice with typed evidence_anchors. If the thread is already handled or the worker adds no value, choose stay_silent or react.",
		},
		{
			Kind:      "worker_result_context",
			SourceRef: strings.TrimSpace(job.ID),
			Text:      formatPersonaDelegatedWorkerReturnContext(job, visibleText, reason, anchors),
		},
	}
	if transcript := personaDelegatedWorkerReturnTranscript(job.Context); transcript != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "slack_thread_context", Text: transcript})
	}
	if external := firstNonEmpty(stringFromContext(job.Context, "external_link_context"), stringFromContext(job.Context, "externalLinkContext")); external != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "external_link_context", Text: truncateSlackContextText(external, slackExternalLinkContextBudgetChars)})
	}
	if memory := stringFromContext(job.Context, "workspace_memory_evidence", "workspaceMemoryEvidence"); memory != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "workspace_memory_evidence", Text: truncateSlackContextText(memory, slackPreviousTriageContextBudgetChars)})
	}
	originalText := firstNonEmpty(slackWorkerTurnUserContent(job), latestSlackInboundMessageText(messages), strings.TrimSpace(job.Task))
	citations := personaDelegatedWorkerReturnCitations(anchors)
	return persona.Request{
		ID:   fmt.Sprintf("worker-return:%s", firstNonEmpty(strings.TrimSpace(job.ID), "unknown")),
		Mode: persona.ModeLive,
		Event: persona.Event{
			Kind: "slack_worker_result_return",
			Text: originalText,
		},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			MessageTS: ref.ReactionTS,
		},
		Context: contextItems,
		Evidence: persona.EvidenceBundle{
			Summary:   truncateSlackContextText(visibleText, 800),
			Citations: citations,
		},
		Safety: persona.SafetyConstraints{
			AllowVisibleReply:  true,
			AllowSpeech:        false,
			AllowWorkerRequest: false,
			AllowReactions:     true,
			MaxVisibleChars:    600,
		},
		Metadata: map[string]any{
			"worker_return_second_pass": true,
			"worker_job_id":             strings.TrimSpace(job.ID),
			"worker_session_kind":       stringFromContext(job.Context, "session_kind", "sessionKind"),
			"triage_run_id":             int64FromContext(job.Context, "triageRunId", "triage_run_id"),
		},
	}, messages, true
}

func personaDelegatedWorkerReturnToolCall(job agentrunner.Job, result SlackPersonaShadowResult) SlackTriageToolCall {
	return SlackTriageToolCall{
		Tool:    "persona_runtime",
		Action:  "worker_result_second_pass",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(job.ID), result.Success),
		Success: result.Success,
		Brief:   "Persona chewed delegated worker result before any visible Slack action",
		Result:  firstNonEmpty(result.VisibleText, result.Reason, result.Error),
	}
}

func formatPersonaDelegatedWorkerReturnContext(job agentrunner.Job, visibleText string, reason string, anchors []SlackVisibleEvidenceAnchor) string {
	var b strings.Builder
	if task := strings.TrimSpace(job.Task); task != "" {
		fmt.Fprintf(&b, "Original delegated task:\n%s\n\n", truncateSlackContextText(task, 1000))
	}
	fmt.Fprintf(&b, "Worker visible candidate (not approved for direct posting):\n%s", truncateSlackContextText(visibleText, 1800))
	if reason = strings.TrimSpace(reason); reason != "" {
		fmt.Fprintf(&b, "\n\nWorker private reason:\n%s", truncateSlackContextText(reason, 800))
	}
	if len(anchors) > 0 {
		b.WriteString("\n\nWorker evidence anchors:")
		for _, anchor := range normalizeSlackVisibleEvidenceAnchors(anchors) {
			fmt.Fprintf(&b, "\n- %s %s", anchor.Kind, anchor.SourceRef)
			if quote := strings.TrimSpace(anchor.Quote); quote != "" {
				fmt.Fprintf(&b, ": %s", quote)
			}
		}
	}
	return strings.TrimSpace(b.String())
}

func personaDelegatedWorkerReturnCitations(anchors []SlackVisibleEvidenceAnchor) []persona.Citation {
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	out := make([]persona.Citation, 0, len(anchors))
	for _, anchor := range anchors {
		out = append(out, persona.Citation{
			Kind:      anchor.Kind,
			Source:    anchor.SourceRef,
			SourceRef: anchor.SourceRef,
			Snippet:   anchor.Quote,
		})
	}
	return out
}

func personaDelegatedWorkerReturnTranscript(context map[string]any) string {
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return ""
		}
		return truncateSlackContextText(firstNonEmpty(typed.Transcript, typed.Prompt), slackThreadContextBudgetChars)
	case SlackAppMentionContext:
		return truncateSlackContextText(firstNonEmpty(typed.Transcript, typed.Prompt), slackThreadContextBudgetChars)
	case map[string]any:
		return truncateSlackContextText(firstNonEmpty(stringFromAny(typed["transcript"]), stringFromAny(typed["prompt"])), slackThreadContextBudgetChars)
	default:
		return ""
	}
}

func personaDelegatedWorkerReturnMessages(job agentrunner.Job, ref AssistantThreadRef) []SlackInboundMessage {
	if messages := messagesFromContext(job.Context["messages"]); len(messages) > 0 {
		return messages
	}
	switch typed := job.Context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return nil
		}
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    typed.UserID,
			Text:      firstNonEmpty(typed.MentionText, typed.RawMentionText),
			TS:        ref.ReactionTS,
		}})
	case SlackAppMentionContext:
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    typed.UserID,
			Text:      firstNonEmpty(typed.MentionText, typed.RawMentionText),
			TS:        ref.ReactionTS,
		}})
	case map[string]any:
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    stringFromAny(typed["userId"]),
			Text:      firstNonEmpty(stringFromAny(typed["mentionText"]), stringFromAny(typed["rawMentionText"])),
			TS:        ref.ReactionTS,
		}})
	default:
		return nil
	}
}

func (s *Service) reportWorkerJobToMeetingAgent(ctx context.Context, job agentrunner.Job) {
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	var result map[string]any
	err := s.postMeetingAgentJSON(ctx, "/worker/report", map[string]any{
		"id":               job.ID,
		"status":           job.Status,
		"provider":         job.Provider,
		"mode":             job.Mode,
		"task":             job.Task,
		"context":          job.Context,
		"allowCodeChanges": job.AllowCodeChanges,
		"result":           envelope.Result,
		"error":            envelope.Error,
		"resultEnvelope":   envelope,
	}, &result)
	if err != nil {
		s.logger.Warn("meeting worker report failed", "job_id", job.ID, "error", err)
	}
}

func (s *Service) postSlackWorkerResult(ctx context.Context, job agentrunner.Job) bool {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return false
	}
	text := slackWorkerResultText(job)
	if strings.TrimSpace(text) == "" {
		return false
	}
	dedupKey := fmt.Sprintf("slack-worker-result:%s:%s:%s", job.ID, ref.ChannelID, firstNonEmpty(ref.ThreadTS, "root"))
	snapshotTS := slackWorkerFreshnessSnapshotTS(job, ref)
	if delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceWorkerFreshnessProbe,
		SurfaceKind:   slackPublicReplySurfaceThreadReply,
		ChannelID:     ref.ChannelID,
		ThreadTS:      ref.ThreadTS,
		Message:       text,
		SnapshotTS:    snapshotTS,
		FreshnessOnly: true,
	}); delivery.Blocked {
		return false
	}
	if shouldPublishWorkerResultAsCanvas(job, text) {
		manifest, err := s.PublishCanvas(ctx, workerResultCanvasInput(job, ref, text, dedupKey))
		if err == nil && manifest.OK {
			s.syncSlackWorkerMemoryTurn(ctx, job, ref, text, "canvas")
			return true
		}
		if err != nil {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", err)
		} else {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "surface", manifest.Surface)
		}
	}
	delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceWorkerResult,
		SurfaceKind:   slackPublicReplySurfaceThreadReply,
		WorkspaceID:   "workspace",
		ChannelID:     ref.ChannelID,
		ThreadTS:      ref.ThreadTS,
		Message:       text,
		Blocks:        buildSlackThreadReplyBlocks(text, "", nil),
		DedupKey:      dedupKey,
		SnapshotTS:    snapshotTS,
		LedgerSummary: "worker_result: " + firstTextLine(text),
	})
	result := delivery.Post
	if delivery.Blocked {
		return false
	}
	if !result.OK {
		s.logger.Warn("slack worker result post failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", result.Error, "detail", result.Detail)
		return false
	}
	s.syncSlackWorkerMemoryTurn(ctx, job, ref, text, "thread_reply")
	return true
}

func slackWorkerFreshnessSnapshotTS(job agentrunner.Job, ref AssistantThreadRef) string {
	slack, _ := mapFromAny(job.Context["slack"])
	return firstNonEmpty(
		stringFromAny(slack["freshnessSnapshotTS"]),
		stringFromAny(slack["freshness_snapshot_ts"]),
		stringFromAny(slack["snapshotTS"]),
		stringFromAny(slack["snapshot_ts"]),
		ref.ReactionTS,
		ref.ThreadTS,
	)
}

func (s *Service) syncSlackWorkerMemoryTurn(ctx context.Context, job agentrunner.Job, ref AssistantThreadRef, assistantText string, delivery string) {
	if job.Status != agentrunner.StatusCompleted {
		return
	}
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	userContent := slackWorkerTurnUserContent(job)
	if strings.TrimSpace(userContent) == "" && strings.TrimSpace(assistantText) == "" {
		return
	}
	s.syncMemoryProvidersTurn(ctx, SlackMemoryProviderTurn{
		SessionID:        firstNonEmpty(stringFromContext(job.Context, "sessionId", "session_id"), job.ID),
		UserContent:      userContent,
		AssistantContent: assistantText,
		Metadata: map[string]any{
			"source":                           "slack_worker_result",
			"job_id":                           strings.TrimSpace(job.ID),
			"channel_id":                       strings.TrimSpace(ref.ChannelID),
			"thread_ts":                        strings.TrimSpace(ref.ThreadTS),
			"delivery":                         strings.TrimSpace(delivery),
			"worker_result_envelope_schema":    envelope.Schema,
			"worker_result_envelope_truncated": envelope.Truncated,
			"worker_result_chars":              envelope.ResultChars,
		},
	})
}

func slackWorkerTurnUserContent(job agentrunner.Job) string {
	texts := slackAppMentionRequestTexts(job.Context)
	for _, text := range texts {
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	return strings.TrimSpace(job.Task)
}

func shouldPublishWorkerResultAsCanvas(job agentrunner.Job, text string) bool {
	if job.Status != agentrunner.StatusCompleted {
		return false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	if len([]rune(trimmed)) > 1800 {
		return true
	}
	if slackWorkerJobRequestsCanvas(job) && (len([]rune(trimmed)) > 20 || looksLikeLongFormMarkdown(trimmed)) {
		return true
	}
	if len(slackAppMentionCanvasFiles(job.Context)) > 0 && (len([]rune(trimmed)) > 700 || looksLikeLongFormMarkdown(trimmed)) {
		return true
	}
	return false
}

func looksLikeLongFormMarkdown(text string) bool {
	normalized := strings.TrimSpace(text)
	return strings.HasPrefix(normalized, "# ") ||
		strings.Contains(normalized, "\n# ") ||
		strings.Contains(normalized, "\n## ") ||
		strings.Count(normalized, "\n\n") >= 4
}

func workerResultCanvasInput(job agentrunner.Job, ref AssistantThreadRef, text string, dedupKey string) CanvasPublishInput {
	files := slackAppMentionCanvasFiles(job.Context)
	revision := len(files) > 0
	title := workerResultCanvasTitle(text, files)
	input := CanvasPublishInput{
		ArtifactID:       "slack-worker-" + firstNonEmpty(job.ID, "result"),
		Title:            title,
		SummaryMarkdown:  text,
		Channel:          ref.ChannelID,
		ThreadTS:         ref.ThreadTS,
		DedupKey:         "slack-worker-canvas:" + dedupKey,
		WorkspaceID:      "workspace",
		SnapshotTS:       slackWorkerFreshnessSnapshotTS(job, ref),
		NotificationText: workerResultCanvasNotification(title, revision),
		ForceSlackCanvas: true,
	}
	if revision {
		input.CanvasID = strings.TrimSpace(files[0].ID)
		input.Operation = "insert_at_end"
	}
	return input
}

func workerResultCanvasTitle(text string, files []SlackThreadFile) string {
	for _, file := range files {
		if title := firstNonEmpty(file.Title, file.Name, file.ID); title != "" {
			return title
		}
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			title := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if title != "" {
				return title
			}
		}
	}
	return "Slack thread notes"
}

func workerResultCanvasNotification(title string, revision bool) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "文档"
	}
	if revision {
		return "新版 " + title + " 已更新：{{canvas_link}}"
	}
	return title + " 已写成 Canvas：{{canvas_link}}"
}

func slackWorkerJobRequestsCanvas(job agentrunner.Job) bool {
	var texts []string
	if task := strings.TrimSpace(job.Task); task != "" {
		texts = append(texts, task)
	}
	texts = append(texts, slackAppMentionRequestTexts(job.Context)...)
	for _, text := range texts {
		if slackTextRequestsCanvasOutput(text) {
			return true
		}
	}
	return false
}

func slackTextRequestsCanvasOutput(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	for _, marker := range []string{
		"write canvas",
		"write a canvas",
		"write to canvas",
		"write into canvas",
		"put in canvas",
		"put into canvas",
		"publish canvas",
		"create canvas",
		"make a canvas",
		"update canvas",
		"edit canvas",
		"canvas 里",
		"canvas里",
		"canvas 中",
		"canvas中",
		"写 canvas",
		"写进 canvas",
		"写到 canvas",
		"放到 canvas",
		"放进 canvas",
		"生成 canvas",
		"创建 canvas",
		"更新 canvas",
		"编辑 canvas",
		"写画布",
		"写进画布",
		"写到画布",
		"放到画布",
		"放进画布",
		"生成画布",
		"创建画布",
		"更新画布",
		"编辑画布",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func slackAppMentionRequestTexts(context map[string]any) []string {
	if len(context) == 0 {
		return nil
	}
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return nil
		}
		return []string{typed.MentionText, typed.RawMentionText}
	case SlackAppMentionContext:
		return []string{typed.MentionText, typed.RawMentionText}
	case map[string]any:
		return []string{stringFromAny(typed["mentionText"]), stringFromAny(typed["rawMentionText"])}
	case map[string]string:
		return []string{typed["mentionText"], typed["rawMentionText"]}
	}
	return nil
}

func slackAppMentionCanvasFiles(context map[string]any) []SlackThreadFile {
	if len(context) == 0 {
		return nil
	}
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		return append([]SlackThreadFile(nil), typed.CanvasFiles...)
	case SlackAppMentionContext:
		return append([]SlackThreadFile(nil), typed.CanvasFiles...)
	case map[string]any:
		return slackThreadFilesFromAny(typed["canvasFiles"])
	case map[string]string:
		if id := strings.TrimSpace(typed["canvasFileID"]); id != "" {
			return []SlackThreadFile{{ID: id, Title: typed["canvasFileTitle"]}}
		}
	}
	return nil
}

func slackThreadFilesFromAny(value any) []SlackThreadFile {
	switch typed := value.(type) {
	case []SlackThreadFile:
		return append([]SlackThreadFile(nil), typed...)
	case []any:
		files := make([]SlackThreadFile, 0, len(typed))
		for _, item := range typed {
			switch file := item.(type) {
			case SlackThreadFile:
				files = append(files, file)
			case map[string]any:
				files = append(files, SlackThreadFile{
					ID:        stringFromAny(file["id"]),
					Name:      stringFromAny(file["name"]),
					Title:     stringFromAny(file["title"]),
					Filetype:  stringFromAny(file["filetype"]),
					Mimetype:  stringFromAny(file["mimetype"]),
					Permalink: stringFromAny(file["permalink"]),
				})
			}
		}
		return files
	default:
		return nil
	}
}

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
