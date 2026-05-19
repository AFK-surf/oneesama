package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) handleAgentRunnerProgress(ctx context.Context, job agentrunner.Job) {
	if isSlackTriageJob(job) {
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
	s.reportWorkerJobToMeetingAgent(ctx, job)
	s.postSlackWorkerResult(ctx, job)
	if ref, ok := slackRefForWorkerJob(job); ok {
		s.scheduleAssistantThreadStatus(ctx, ref, "", true)
		if job.Status == agentrunner.StatusCompleted {
			s.finishMentionReaction(ctx, ref, slackReactionOK)
		} else {
			s.finishMentionReaction(ctx, ref, slackReactionWarn)
		}
	}
}

func (s *Service) reportWorkerJobToMeetingAgent(ctx context.Context, job agentrunner.Job) {
	var result map[string]any
	err := s.postMeetingAgentJSON(ctx, "/worker/report", map[string]any{
		"id":               job.ID,
		"status":           job.Status,
		"provider":         job.Provider,
		"mode":             job.Mode,
		"task":             job.Task,
		"context":          job.Context,
		"allowCodeChanges": job.AllowCodeChanges,
		"result":           job.Result,
		"error":            job.Error,
	}, &result)
	if err != nil {
		s.logger.Warn("meeting worker report failed", "job_id", job.ID, "error", err)
	}
}

func (s *Service) postSlackWorkerResult(ctx context.Context, job agentrunner.Job) {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return
	}
	text := slackWorkerResultText(job)
	if strings.TrimSpace(text) == "" {
		return
	}
	dedupKey := fmt.Sprintf("slack-worker-result:%s:%s:%s", job.ID, ref.ChannelID, firstNonEmpty(ref.ThreadTS, "root"))
	if shouldPublishWorkerResultAsCanvas(job, text) {
		manifest, err := s.PublishCanvas(ctx, workerResultCanvasInput(job, ref, text, dedupKey))
		if err == nil && manifest.OK {
			return
		}
		if err != nil {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", err)
		} else {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "surface", manifest.Surface)
		}
	}
	postInput := PostMessageInput{
		Channel:  ref.ChannelID,
		ThreadTS: ref.ThreadTS,
		Text:     markdownToSlackFallbackText(text),
		Blocks:   buildSlackThreadReplyBlocks(text, "", nil),
		DedupKey: dedupKey,
	}
	result := s.PostMessage(ctx, postInput)
	if !result.OK {
		s.logger.Warn("slack worker result post failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", result.Error, "detail", result.Detail)
		return
	}
	s.recordSlackOutboundLedger(ctx, "workspace", postInput, result, "worker_result: "+firstTextLine(text))
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
	return CanvasPublishInput{
		ArtifactID:       "slack-worker-" + firstNonEmpty(job.ID, "result"),
		Title:            title,
		SummaryMarkdown:  text,
		Channel:          ref.ChannelID,
		ThreadTS:         ref.ThreadTS,
		DedupKey:         "slack-worker-canvas:" + dedupKey,
		NotificationText: workerResultCanvasNotification(title, revision),
		ForceSlackCanvas: true,
	}
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
		normalized := strings.ToLower(strings.TrimSpace(text))
		if strings.Contains(normalized, "canvas") || strings.Contains(normalized, "画布") {
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

func slackWorkerResultText(job agentrunner.Job) string {
	if job.Status == agentrunner.StatusCompleted {
		return firstNonEmpty(strings.TrimSpace(job.Result), "我这边处理完了。")
	}
	return "我这边处理失败了：" + firstNonEmpty(strings.TrimSpace(job.Error), strings.TrimSpace(job.Result), "unknown error")
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
