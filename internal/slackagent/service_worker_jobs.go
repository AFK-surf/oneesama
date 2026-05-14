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
	result := s.PostMessage(ctx, PostMessageInput{
		Channel:  ref.ChannelID,
		ThreadTS: ref.ThreadTS,
		Text:     text,
		DedupKey: fmt.Sprintf("slack-worker-result:%s:%s:%s", job.ID, ref.ChannelID, firstNonEmpty(ref.ThreadTS, "root")),
	})
	if !result.OK {
		s.logger.Warn("slack worker result post failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", result.Error, "detail", result.Detail)
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
	switch strings.ToLower(strings.TrimSpace(job.Provider)) {
	case "codex":
		return "Starting Codex..."
	case "claude", "claude-code":
		return "Starting Claude..."
	case "ollama", "ollama-http", "local-ollama":
		return "Using Ollama..."
	default:
		return "Working on it..."
	}
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
