package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const meetingCopilotDisabledReason = "meeting_copilot_disabled_realtime_foreground"

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
	Queued                  bool             `json:"queued"`
	SkippedReason           string           `json:"skipped_reason,omitempty"`
	TranscriptDelta         string           `json:"transcript_delta,omitempty"`
	ChatDelta               string           `json:"chat_delta,omitempty"`
	FilteredSelfLines       int              `json:"filtered_self_lines,omitempty"`
	FilteredSelfEchoLines   int              `json:"filtered_self_echo_lines,omitempty"`
	FilteredTranscriptLines int              `json:"filtered_transcript_lines,omitempty"`
	Job                     *agentrunner.Job `json:"job,omitempty"`
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

	// Realtime owns live meeting voice, screen-share, and app-control turns.
	// Keep digest bookkeeping for duplicate suppression, but never spawn the
	// legacy Cueboard meeting-copilot worker from live meeting digests.
	s.meetingCopilotMu.Lock()
	state.LastDigest = strings.TrimSpace(payload.Transcript)
	state.LastChatDigest = strings.TrimSpace(payload.ChatTranscript)
	state.UpdatedAt = now
	s.meetingCopilotMu.Unlock()
	return &meetingCopilotRunResult{
		Queued:        false,
		SkippedReason: meetingCopilotDisabledReason,
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

func isMeetingCopilotJob(job agentrunner.Job) bool {
	return agentrunner.NormalizeSessionKind(stringFromContext(job.Context, "session_kind", "sessionKind")) == agentrunner.SessionKindMeetingCopilot ||
		strings.TrimSpace(stringFromContext(job.Context, "source")) == "meeting-copilot"
}

func (s *Service) handleMeetingCopilotToolRequest(ctx context.Context, job agentrunner.Job) bool {
	if !isMeetingCopilotJob(job) || job.Status != agentrunner.StatusCompleted {
		return false
	}
	// Mark handled so persisted legacy meeting-copilot jobs cannot execute
	// send_meeting_chat / notify_meeting_slack side effects after the foreground
	// Realtime agent has taken ownership of live meeting turns.
	return true
}
