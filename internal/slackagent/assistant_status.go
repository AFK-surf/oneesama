package slackagent

import (
	"context"
	"strings"
	"time"
)

const assistantStatusMinInterval = 2 * time.Second

type assistantThreadStatusState struct {
	lastStatus    string
	lastStatusSet bool
	lastCallAt    time.Time
	pendingTimer  *time.Timer
	pendingStatus string
}

func (s *Service) scheduleAssistantThreadStatus(ctx context.Context, ref AssistantThreadRef, status string, immediate bool) AssistantAPIResult {
	channelID := strings.TrimSpace(ref.ChannelID)
	threadTS := strings.TrimSpace(ref.ThreadTS)
	status = strings.TrimSpace(status)
	if channelID == "" || threadTS == "" {
		return AssistantAPIResult{OK: false, Skipped: true, Reason: "missing_assistant_thread_ref", Error: "missing_assistant_thread_ref"}
	}

	key := assistantStatusKey(channelID, threadTS)
	now := time.Now()

	s.assistantMu.Lock()
	state := s.assistantStatusByThread[key]
	if state == nil {
		state = &assistantThreadStatusState{}
		s.assistantStatusByThread[key] = state
	}

	if state.lastStatusSet && status == state.lastStatus {
		s.assistantMu.Unlock()
		return AssistantAPIResult{
			OK:      true,
			Method:  "assistant.threads.setStatus",
			Skipped: true,
			Reason:  "duplicate_assistant_status",
			Payload: map[string]any{
				"channel_id": channelID,
				"thread_ts":  threadTS,
				"status":     status,
			},
		}
	}

	if status == "" || immediate {
		if state.pendingTimer != nil {
			state.pendingTimer.Stop()
		}
		state.pendingTimer = nil
		state.pendingStatus = ""
		s.assistantMu.Unlock()
		return s.setAssistantThreadStatus(ctx, channelID, threadTS, status)
	}

	elapsed := now.Sub(state.lastCallAt)
	if state.lastCallAt.IsZero() || elapsed >= assistantStatusMinInterval || shouldBypassAssistantStatusThrottle(status) {
		s.assistantMu.Unlock()
		return s.setAssistantThreadStatus(ctx, channelID, threadTS, status)
	}

	if state.pendingStatus == "" || assistantStatusPriority(status) >= assistantStatusPriority(state.pendingStatus) {
		state.pendingStatus = status
	}
	if state.pendingTimer == nil {
		delay := assistantStatusMinInterval - elapsed
		state.pendingTimer = time.AfterFunc(delay, func() {
			s.flushPendingAssistantStatus(channelID, threadTS)
		})
	}
	s.assistantMu.Unlock()

	return AssistantAPIResult{
		OK:     true,
		Method: "assistant.threads.setStatus",
		Queued: true,
		Payload: map[string]any{
			"channel_id": channelID,
			"thread_ts":  threadTS,
			"status":     status,
		},
	}
}

func (s *Service) flushPendingAssistantStatus(channelID string, threadTS string) {
	key := assistantStatusKey(channelID, threadTS)

	s.assistantMu.Lock()
	state := s.assistantStatusByThread[key]
	if state == nil {
		s.assistantMu.Unlock()
		return
	}
	pending := state.pendingStatus
	state.pendingStatus = ""
	state.pendingTimer = nil
	if pending == "" || (state.lastStatusSet && pending == state.lastStatus) {
		s.assistantMu.Unlock()
		return
	}
	s.assistantMu.Unlock()

	s.setAssistantThreadStatus(context.Background(), channelID, threadTS, pending)
}

func (s *Service) setAssistantThreadStatus(ctx context.Context, channelID string, threadTS string, status string) AssistantAPIResult {
	result := s.assistant.SetStatus(ctx, AssistantStatusInput{
		ChannelID: channelID,
		ThreadTS:  threadTS,
		Status:    status,
	})
	if result.OK {
		s.assistantMu.Lock()
		state := s.assistantStatusByThread[assistantStatusKey(channelID, threadTS)]
		if state == nil {
			state = &assistantThreadStatusState{}
			s.assistantStatusByThread[assistantStatusKey(channelID, threadTS)] = state
		}
		state.lastStatus = strings.TrimSpace(status)
		state.lastStatusSet = true
		state.lastCallAt = time.Now()
		s.assistantMu.Unlock()
	} else {
		s.logger.Warn("slack assistant status update failed", "channel", channelID, "thread_ts", threadTS, "status", status, "error", result.Error, "detail", result.Detail)
	}
	return result
}

func (s *Service) setAssistantSuggestedPrompts(ctx context.Context, ref AssistantThreadRef) AssistantAPIResult {
	if strings.TrimSpace(ref.ChannelID) == "" || strings.TrimSpace(ref.ThreadTS) == "" {
		return AssistantAPIResult{OK: false, Skipped: true, Reason: "missing_assistant_thread_ref", Error: "missing_assistant_thread_ref"}
	}
	result := s.assistant.SetSuggestedPrompts(ctx, AssistantSuggestedPromptsInput{
		ChannelID: ref.ChannelID,
		ThreadTS:  ref.ThreadTS,
	})
	if !result.OK {
		s.logger.Warn("slack assistant suggested prompts failed", "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", result.Error, "detail", result.Detail)
	}
	return result
}

func assistantStatusKey(channelID string, threadTS string) string {
	return strings.TrimSpace(channelID) + ":" + strings.TrimSpace(threadTS)
}

func shouldBypassAssistantStatusThrottle(status string) bool {
	return assistantStatusPriority(status) >= 4
}

func assistantStatusPriority(status string) int {
	trimmed := strings.TrimSpace(status)
	switch trimmed {
	case "":
		return 0
	case "Thinking...", "Working on it...":
		return 1
	case "Starting Codex...", "Planning...":
		return 2
	case "Composing reply...":
		return 3
	}
	for _, prefix := range []string{"Running", "Using", "Editing", "Inspecting", "Delegating", "Waiting", "Messaging", "Checking"} {
		if strings.HasPrefix(trimmed, prefix) {
			return 4
		}
	}
	return 1
}
