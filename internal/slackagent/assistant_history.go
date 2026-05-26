//go:build cueboardparity

package slackagent

import (
	"strings"
	"sync"
	"time"
)

type slackHistoryMessageType string

const (
	slackHistoryMessageTypeMessage slackHistoryMessageType = "message"
)

type slackHistoryRole string

const (
	slackHistoryRoleUser      slackHistoryRole = "user"
	slackHistoryRoleAssistant slackHistoryRole = "assistant"
)

type slackHistoryContentType string

const (
	slackHistoryContentTypeText slackHistoryContentType = "text"
)

type slackHistoryMessageContent struct {
	Type slackHistoryContentType
	Text string
}

type slackHistoryMessage struct {
	ID        string
	Type      slackHistoryMessageType
	Role      slackHistoryRole
	Timestamp time.Time
	Content   []slackHistoryMessageContent
	ErrorType string
	Error     string
}

type slackAssistantPhase string

const (
	slackAssistantPhaseExecution slackAssistantPhase = "execution"
)

type slackAssistantToolCallState struct {
	CallID   string
	ToolName string
}

type slackAssistantState struct {
	Phase slackAssistantPhase
	Tools []slackAssistantToolCallState
}

type slackMentionHistoryForwarder struct {
	mu        sync.Mutex
	pending   *slackHistoryMessage
	startedAt time.Time
}

func newSlackMentionHistoryForwarder(_ any, _, _, _ string) *slackMentionHistoryForwarder {
	return &slackMentionHistoryForwarder{
		startedAt: time.Now(),
	}
}

func (l *slackMentionHistoryForwarder) observeHistoryMessage(msg slackHistoryMessage) *slackHistoryMessage {
	if !shouldForwardSlackMentionHistoryMessage(msg) {
		return nil
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	cloned := msg
	if l.pending == nil {
		l.pending = &cloned
		return nil
	}

	if cloned.ID != "" && l.pending.ID == cloned.ID {
		l.pending = &cloned
		return nil
	}

	toPost := *l.pending
	l.pending = &cloned
	return &toPost
}

func (l *slackMentionHistoryForwarder) observeAssistantState(_ slackAssistantState) string {
	return ""
}

func shouldForwardSlackMentionHistoryMessage(msg slackHistoryMessage) bool {
	if msg.Type != slackHistoryMessageTypeMessage {
		return false
	}
	if msg.Role != slackHistoryRoleAssistant {
		return false
	}
	if strings.TrimSpace(msg.ErrorType) != "" || strings.TrimSpace(msg.Error) != "" {
		return false
	}
	return strings.TrimSpace(historyMessageText(msg)) != ""
}

func historyMessageText(msg slackHistoryMessage) string {
	var parts []string
	for _, part := range msg.Content {
		if part.Type != slackHistoryContentTypeText {
			continue
		}
		if strings.TrimSpace(part.Text) == "" {
			continue
		}
		parts = append(parts, part.Text)
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func latestAssistantTextSince(history []slackHistoryMessage, since time.Time) string {
	for i := len(history) - 1; i >= 0; i-- {
		msg := history[i]
		if msg.Type != slackHistoryMessageTypeMessage || msg.Role != slackHistoryRoleAssistant {
			continue
		}
		if !msg.Timestamp.IsZero() && msg.Timestamp.Before(since) {
			break
		}
		text := historyMessageText(msg)
		if strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}
