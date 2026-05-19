package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) RunAvatarCommand(ctx context.Context, input AvatarCommandInput) AvatarCommandResponse {
	parsed := parseAvatarCommand(input.Text)
	if parsed.Action == "join" {
		return s.runJoinCommand(ctx, input, parsed)
	}
	if parsed.Action == "status" {
		return s.runStatusCommand(ctx, input, parsed)
	}
	if parsed.Action == "stop" {
		return s.runStopCommand(ctx, input, parsed)
	}

	if parsed.Action == "help" {
		return AvatarCommandResponse{
			OK:           true,
			ResponseType: "ephemeral",
			Text:         avatarCommandUsage(),
			Metadata: map[string]any{
				"allowed_commands": allowedAvatarCommands(),
			},
		}
	}

	if parsed.Action == "work" {
		return s.runWorkCommand(ctx, input, parsed)
	}

	if !isHiddenAvatarCommand(parsed.Action) && strings.TrimSpace(input.Text) != "" {
		parsed.Action = "work"
		parsed.Task = strings.TrimSpace(input.Text)
		return s.runWorkCommand(ctx, input, parsed)
	}

	return AvatarCommandResponse{
		OK:           false,
		ResponseType: "ephemeral",
		Text:         avatarUnknownCommandText(parsed.Action),
		Metadata: map[string]any{
			"allowed_commands": allowedAvatarCommands(),
		},
	}
}

func (s *Service) runScheduleCommand(ctx context.Context, input AvatarCommandInput, action string) AvatarCommandResponse {
	result := ExecuteAssistantScheduleTool(ctx, ExecuteAssistantScheduleToolArgs{
		Action:    action,
		ChannelID: input.ChannelID,
		ThreadTS:  input.ThreadTS,
	}, ExecuteAssistantScheduleToolOptions{
		ChannelID:       input.ChannelID,
		ThreadTS:        input.ThreadTS,
		ScheduleManager: s.scheduleManager,
	})
	metadata := cloneMetadata(result.Metadata)
	if result.Error != "" {
		metadata["error"] = result.Error
	}
	return AvatarCommandResponse{
		OK:           result.OK,
		ResponseType: "ephemeral",
		Text:         result.Text,
		Metadata:     metadata,
	}
}

func (s *Service) runWorkCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	if parsed.Task == "" {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Usage error: missing task.\n\n" + avatarCommandUsage(),
		}
	}
	if s.runner == nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "I am not ready to handle that yet: " + runnerErrorText(s.runnerErr),
		}
	}

	slackContext := s.rememberSlackCommand(ctx, input, parsed, nil)
	startInput := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             parsed.Task,
		Mode:             parsed.RequestedMode,
		AllowCodeChanges: parsed.AllowCodeChanges,
		Context:          s.buildAgentRunnerContext(input, parsed, slackContext),
	}, agentrunner.SessionKindSlack)
	job, err := s.runner.StartTask(ctx, startInput)
	if err != nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "I could not start that task: " + err.Error(),
		}
	}
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         "我来处理，完成后会发回这个线程。",
		Metadata: metadataWithSlackContext(slackContext, map[string]any{
			"job": job,
		}),
	}
}

func (s *Service) runJobsCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	if s.runner == nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Agent runner is not ready: " + runnerErrorText(s.runnerErr),
		}
	}
	jobs, err := s.runner.ListJobs(ctx)
	if err != nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "List jobs failed: " + err.Error(),
		}
	}
	slackContext := s.rememberSlackCommand(ctx, input, parsed, nil)
	meetingJobs, meetingJobsErr := s.getMeetingWorkerJobs(ctx)
	readyForSlack, readyErr := s.pollMeetingWorkerResults(ctx, 10, true)
	text := formatCombinedJobList(jobs, meetingJobs, readyForSlack)
	metadata := metadataWithSlackContext(slackContext, map[string]any{
		"jobs":            jobs,
		"meeting_jobs":    meetingJobs,
		"ready_for_slack": readyForSlack,
	})
	if meetingJobsErr != nil {
		metadata["meeting_jobs_error"] = meetingJobsErr.Error()
	}
	if readyErr != nil {
		metadata["ready_for_slack_error"] = readyErr.Error()
	}
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         text,
		Metadata:     metadata,
	}
}

func (s *Service) buildAgentRunnerContext(input AvatarCommandInput, parsed parsedAvatarCommand, slackContext *SlackContextRecord) map[string]any {
	context := map[string]any{
		"slack": map[string]any{
			"workspaceId": input.TeamID,
			"teamDomain":  input.TeamDomain,
			"channelId":   input.ChannelID,
			"channelName": input.ChannelName,
			"threadTs":    input.ThreadTS,
			"reactionTs":  input.ReactionTS,
			"eventTs":     input.ReactionTS,
			"userId":      input.UserID,
			"userName":    input.UserName,
			"command":     firstNonEmpty(input.Command, "app_mention"),
			"action":      parsed.Action,
		},
		"source":      "slack-agent",
		"requestedBy": input.UserID,
	}
	if parsed.SessionID != "" {
		context["sessionId"] = parsed.SessionID
		context["session_id"] = parsed.SessionID
	}
	if parsed.MeetURL != "" {
		context["meetUrl"] = parsed.MeetURL
	}
	if slackContext != nil {
		context["slackContext"] = slackContext
		context["workspaceContext"] = map[string]any{
			"commandCount":   slackContext.CommandCount,
			"recentCommands": slackContext.RecentCommands,
			"channelBrain":   slackContext.ChannelBrain,
			"threadLedger":   slackContext.ThreadLedger,
			"provenance":     "Legacy Slack Agent D inspired: channel/thread workspace context is collected here, while private workspace memory stays behind adapters.",
		}
	}
	if input.RichThreadContext != nil {
		context["slackAppMention"] = input.RichThreadContext
		if strings.TrimSpace(input.RichThreadContext.Prompt) != "" {
			context["slackAssistantPrompt"] = input.RichThreadContext.Prompt
		}
		query := strings.Join([]string{
			input.RichThreadContext.MentionText,
			input.RichThreadContext.Transcript,
			input.ChannelName,
			input.UserName,
		}, " ")
		query = strings.TrimSpace(query)
		context["localSlackMemory"] = s.buildLocalSlackMemoryContext(query, 5)
		relatedMemory := s.SearchRelatedMemory(query, SlackRelatedMemorySearchOptions{Limit: 5})
		context["relatedMemory"] = relatedMemory
		if evidence := formatSlackRelatedMemoryEvidence(relatedMemory.Results, 5); evidence != "" {
			context["relatedMemoryEvidence"] = evidence
		}
	}
	return context
}

func avatarCommandUsage() string {
	return strings.Join([]string{
		`Onee-sama commands:`,
		`join <meet-url> [--bot-name name] [--dry-run false]`,
		`status [session-id]`,
		`stop [session-id] [--reason text]`,
		`help`,
		`Or just mention me with what you need.`,
	}, "\n")
}

func allowedAvatarCommands() []string {
	return []string{"join", "status", "stop", "help"}
}

func avatarUnknownCommandText(action string) string {
	action = strings.TrimSpace(action)
	if isHiddenAvatarCommand(action) {
		return "I don't understand that command.\n\n" + avatarCommandUsage()
	}
	return fmt.Sprintf("Unknown command: %s\n\n%s", action, avatarCommandUsage())
}

func isHiddenAvatarCommand(action string) bool {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "delegate", "jobs", "cancel", "schedule":
		return true
	default:
		return false
	}
}

func formatCombinedJobList(localJobs []agentrunner.Job, meetingJobs []meetingWorkerJob, ready meetingWorkerPollResponse) string {
	lines := []string{fmt.Sprintf("Background tasks: local=%d, meeting=%d", len(localJobs), len(meetingJobs))}
	if len(ready.Messages) > 0 {
		lines = append(lines, "", strings.Join(ready.Messages, "\n\n"))
	}
	for _, job := range localJobs {
		lines = append(lines, fmt.Sprintf("- %s | %s | %s | %s", job.ID, job.Status, job.Provider, job.Task))
	}
	return strings.Join(lines, "\n")
}

func (s *Service) rememberSlackCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand, session *meetingAgentSession) *SlackContextRecord {
	record, err := s.slackContext.Remember(ctx, input, parsed, session)
	if err != nil {
		s.logger.Warn("remember slack command failed", "error", err)
	}
	return record
}

func metadataWithSlackContext(record *SlackContextRecord, metadata map[string]any) map[string]any {
	if metadata == nil {
		metadata = make(map[string]any)
	}
	if record != nil {
		metadata["slack_context"] = record
	}
	return metadata
}

func runnerErrorText(err error) string {
	if err == nil {
		return "agent runner is unavailable"
	}
	return err.Error()
}
