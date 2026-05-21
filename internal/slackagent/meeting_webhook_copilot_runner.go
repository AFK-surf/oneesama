package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const meetingCopilotMinChatInterval = 2 * time.Minute

type meetingCopilotState struct {
	MeetingID      string
	LastDigest     string
	LastChatDigest string
	LastChatAt     time.Time
	PriorActions   []string
	Generation     int
	UpdatedAt      time.Time
}

type meetingCopilotRunResult struct {
	Queued          bool             `json:"queued"`
	SkippedReason   string           `json:"skipped_reason,omitempty"`
	TranscriptDelta string           `json:"transcript_delta,omitempty"`
	ChatDelta       string           `json:"chat_delta,omitempty"`
	Job             *agentrunner.Job `json:"job,omitempty"`
}

func (s *Service) handleMeetingWebhookDigest(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingWebhookResponse {
	result, err := s.enqueueMeetingCopilot(ctx, payload)
	if err != nil {
		return MeetingWebhookResponse{OK: false, Accepted: true, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_copilot_agent_failed", Detail: err.Error()}
	}
	return MeetingWebhookResponse{OK: true, Accepted: true, Event: payload.Event, MeetingID: payload.MeetingID, Copilot: result}
}

func (s *Service) enqueueMeetingCopilot(ctx context.Context, payload NormalizedMeetingWebhookPayload) (*meetingCopilotRunResult, error) {
	meetingID := meetingCopilotMeetingID(payload)
	now := timeNow().UTC()
	state := s.meetingCopilotState(meetingID)

	s.meetingCopilotMu.Lock()
	transcriptDelta := incrementalTranscript(state.LastDigest, payload.Transcript)
	chatDelta := incrementalTranscript(state.LastChatDigest, payload.ChatTranscript)
	if transcriptDelta == "" && chatDelta == "" {
		state.UpdatedAt = now
		s.meetingCopilotMu.Unlock()
		return &meetingCopilotRunResult{Queued: false, SkippedReason: "no_new_delta"}, nil
	}
	state.LastDigest = strings.TrimSpace(payload.Transcript)
	state.LastChatDigest = strings.TrimSpace(payload.ChatTranscript)
	if !state.LastChatAt.IsZero() && now.Sub(state.LastChatAt) < meetingCopilotMinChatInterval && !containsExplicitMeetingFollowUp(strings.Join([]string{transcriptDelta, chatDelta}, "\n")) {
		state.UpdatedAt = now
		s.meetingCopilotMu.Unlock()
		return &meetingCopilotRunResult{Queued: false, SkippedReason: "chat_cooldown", TranscriptDelta: transcriptDelta, ChatDelta: chatDelta}, nil
	}
	priorActions := append([]string(nil), state.PriorActions...)
	generation := state.Generation
	state.UpdatedAt = now
	s.meetingCopilotMu.Unlock()

	if s.runner == nil {
		return nil, fmt.Errorf("agent runner unavailable")
	}
	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             buildMeetingCopilotTask(payload, transcriptDelta, chatDelta, priorActions, now),
		Context:          meetingCopilotContext(payload, transcriptDelta, chatDelta, priorActions, generation),
		Mode:             "analysis",
		AllowCodeChanges: false,
	}, agentrunner.SessionKindMeetingCopilot))
	if err != nil {
		s.meetingCopilotMu.Lock()
		state.Generation++
		s.meetingCopilotMu.Unlock()
		return nil, err
	}
	return &meetingCopilotRunResult{
		Queued:          true,
		TranscriptDelta: transcriptDelta,
		ChatDelta:       chatDelta,
		Job:             &job,
	}, nil
}

func (s *Service) meetingCopilotState(meetingID string) *meetingCopilotState {
	s.meetingCopilotMu.Lock()
	defer s.meetingCopilotMu.Unlock()
	if s.meetingCopilotStates == nil {
		s.meetingCopilotStates = make(map[string]*meetingCopilotState)
	}
	state := s.meetingCopilotStates[meetingID]
	if state == nil {
		state = &meetingCopilotState{MeetingID: meetingID}
		s.meetingCopilotStates[meetingID] = state
	}
	return state
}

func meetingCopilotMeetingID(payload NormalizedMeetingWebhookPayload) string {
	if payload.MeetingID > 0 {
		return fmt.Sprintf("%d", payload.MeetingID)
	}
	return firstNonEmpty(payload.Title, "unknown")
}

func buildMeetingCopilotTask(payload NormalizedMeetingWebhookPayload, transcriptDelta string, chatDelta string, priorActions []string, now time.Time) string {
	sections := []string{
		cueboardMeetingCopilotSystemPrompt,
		"## Dispatcher contract",
		"If you need to act, output ONLY this block and no prose:",
		`<oneesama_tool_request>
{"calls":[{"tool":"send_meeting_chat","args":{"meeting_id":` + fmt.Sprintf("%d", payload.MeetingID) + `,"text":"<short Chinese message>"}}],"reason":"meeting chat reply"}
</oneesama_tool_request>`,
		`Use notify_meeting_slack only when the meeting explicitly asks to notify the linked Slack thread. If no action is needed, output exactly: No action needed`,
		fmt.Sprintf("## Meeting: %s", firstNonEmpty(payload.Title, "Meeting")),
	}
	if len(priorActions) > 0 {
		sections = append(sections, "## Prior actions this meeting (do NOT repeat)", "- "+strings.Join(priorActions, "\n- "))
	}
	if strings.TrimSpace(transcriptDelta) != "" {
		sections = append(sections, fmt.Sprintf("## New transcript lines (%s - %s)", payload.TimeFrom, payload.TimeTo), strings.TrimSpace(transcriptDelta))
	}
	if strings.TrimSpace(chatDelta) != "" {
		sections = append(sections, fmt.Sprintf("## New in-meeting chat messages (%s - %s)", payload.TimeFrom, payload.TimeTo), strings.TrimSpace(chatDelta))
	}
	sections = append(sections, "Generated at: "+now.Format(time.RFC3339Nano))
	return strings.TrimSpace(strings.Join(sections, "\n\n"))
}

func meetingCopilotContext(payload NormalizedMeetingWebhookPayload, transcriptDelta string, chatDelta string, priorActions []string, generation int) map[string]any {
	return map[string]any{
		"source":    "meeting-copilot",
		"meetingId": meetingCopilotMeetingID(payload),
		"meeting": map[string]any{
			"id":       meetingCopilotMeetingID(payload),
			"title":    firstNonEmpty(payload.Title, "Meeting"),
			"timeFrom": payload.TimeFrom,
			"timeTo":   payload.TimeTo,
		},
		"meetingCopilot": map[string]any{
			"transcriptDelta":   transcriptDelta,
			"chatDelta":         chatDelta,
			"priorActions":      priorActions,
			"sessionGeneration": generation,
		},
	}
}

func isMeetingCopilotJob(job agentrunner.Job) bool {
	return agentrunner.NormalizeSessionKind(stringFromContext(job.Context, "session_kind", "sessionKind")) == agentrunner.SessionKindMeetingCopilot ||
		strings.TrimSpace(stringFromContext(job.Context, "source")) == "meeting-copilot"
}

func (s *Service) handleMeetingCopilotToolRequest(ctx context.Context, job agentrunner.Job) bool {
	if !isMeetingCopilotJob(job) || job.Status != agentrunner.StatusCompleted {
		return false
	}
	request, ok := parseSlackWorkerToolBridgeRequest(job.Result)
	if !ok {
		return false
	}
	effects := meetingCopilotToolEffects{}
	for _, call := range request.Calls {
		call.Tool = firstNonEmpty(call.Tool, call.Name)
		switch call.Tool {
		case "send_meeting_chat", "notify_meeting_slack":
		default:
			continue
		}
		response, err := s.ExecuteSlackTool(ctx, call)
		result := meetingCopilotToolResult{Success: response.OK && err == nil, Text: firstNonEmpty(response.Text, stringFromAny(response.Result))}
		recordMeetingCopilotToolExecution(&effects, call.Tool, call.Args, result)
	}
	if effects.hasSideEffects() {
		s.recordMeetingCopilotEffects(job, effects)
	}
	return true
}

func (s *Service) recordMeetingCopilotEffects(job agentrunner.Job, effects meetingCopilotToolEffects) {
	meetingID := stringFromContext(job.Context, "meetingId", "meeting_id")
	if strings.TrimSpace(meetingID) == "" {
		return
	}
	now := timeNow().UTC()
	s.meetingCopilotMu.Lock()
	defer s.meetingCopilotMu.Unlock()
	state := s.meetingCopilotStates[meetingID]
	if state == nil {
		state = &meetingCopilotState{MeetingID: meetingID}
		s.meetingCopilotStates[meetingID] = state
	}
	if strings.TrimSpace(effects.sentMeetingChatText) != "" {
		state.PriorActions = append(state.PriorActions, fmt.Sprintf("[%s] %s", now.Format("15:04:05"), truncateSlackContextText(effects.sentMeetingChatText, 160)))
		state.LastChatAt = now
	}
	for _, sideEffect := range effects.otherSideEffects {
		state.PriorActions = append(state.PriorActions, fmt.Sprintf("[%s] %s", now.Format("15:04:05"), truncateSlackContextText(sideEffect, 160)))
	}
	if len(state.PriorActions) > 10 {
		state.PriorActions = state.PriorActions[len(state.PriorActions)-10:]
	}
	state.UpdatedAt = now
}
