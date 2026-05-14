//go:build cueboardparity

package slackagent

import (
	"testing"
	"time"
)

func TestCueboardParitySlackMentionHistoryForwarderObserveHistoryMessageFlushesOnNextMessage(t *testing.T) {
	forwarder := newSlackMentionHistoryForwarder(nil, "C123", "123.456", "sess-1")

	first := slackHistoryMessage{
		ID:   "msg-1",
		Type: slackHistoryMessageTypeMessage,
		Role: slackHistoryRoleAssistant,
		Content: []slackHistoryMessageContent{{
			Type: slackHistoryContentTypeText,
			Text: "先看一下这个问题。",
		}},
	}
	if got := forwarder.observeHistoryMessage(first); got != nil {
		t.Fatalf("first assistant message should stay pending, got %+v", got)
	}

	updatedFirst := first
	updatedFirst.Content[0].Text = "先看一下这个问题，我先查日志。"
	if got := forwarder.observeHistoryMessage(updatedFirst); got != nil {
		t.Fatalf("same message ID should only update pending content, got %+v", got)
	}

	second := slackHistoryMessage{
		ID:   "msg-2",
		Type: slackHistoryMessageTypeMessage,
		Role: slackHistoryRoleAssistant,
		Content: []slackHistoryMessageContent{{
			Type: slackHistoryContentTypeText,
			Text: "我已经定位到原因了。",
		}},
	}
	flushed := forwarder.observeHistoryMessage(second)
	if flushed == nil {
		t.Fatal("new assistant message should flush previous pending content")
	}
	if got := historyMessageText(*flushed); got != "先看一下这个问题，我先查日志。" {
		t.Fatalf("flushed text = %q, want updated first message", got)
	}
}

func TestCueboardParityShouldForwardSlackMentionHistoryMessage(t *testing.T) {
	tests := []struct {
		name string
		msg  slackHistoryMessage
		want bool
	}{
		{
			name: "assistant text message",
			msg: slackHistoryMessage{
				Type: slackHistoryMessageTypeMessage,
				Role: slackHistoryRoleAssistant,
				Content: []slackHistoryMessageContent{{
					Type: slackHistoryContentTypeText,
					Text: "在看了。",
				}},
			},
			want: true,
		},
		{
			name: "assistant error message",
			msg: slackHistoryMessage{
				Type:      slackHistoryMessageTypeMessage,
				Role:      slackHistoryRoleAssistant,
				ErrorType: "loop_result",
				Error:     "boom",
				Content: []slackHistoryMessageContent{{
					Type: slackHistoryContentTypeText,
					Text: "Error: boom",
				}},
			},
			want: false,
		},
		{
			name: "user message",
			msg: slackHistoryMessage{
				Type: slackHistoryMessageTypeMessage,
				Role: slackHistoryRoleUser,
				Content: []slackHistoryMessageContent{{
					Type: slackHistoryContentTypeText,
					Text: "hello",
				}},
			},
			want: false,
		},
		{
			name: "empty assistant message",
			msg: slackHistoryMessage{
				Type:    slackHistoryMessageTypeMessage,
				Role:    slackHistoryRoleAssistant,
				Content: []slackHistoryMessageContent{{Type: slackHistoryContentTypeText}},
			},
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldForwardSlackMentionHistoryMessage(tc.msg); got != tc.want {
				t.Fatalf("shouldForwardSlackMentionHistoryMessage() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCueboardParitySlackMentionHistoryForwarderObserveAssistantStateExecutionProgress(t *testing.T) {
	forwarder := newSlackMentionHistoryForwarder(nil, "C123", "123.456", "sess-1")
	forwarder.startedAt = time.Now().Add(-30 * time.Second)

	state := slackAssistantState{
		Phase: slackAssistantPhaseExecution,
		Tools: []slackAssistantToolCallState{{
			CallID:   "call-1",
			ToolName: "bash",
		}},
	}

	if got := forwarder.observeAssistantState(state); got != "" {
		t.Fatalf("observeAssistantState() = %q, want empty because visible progress is disabled", got)
	}
}

func TestCueboardParitySlackMentionHistoryForwarderOnlyPostsOneVisibleProgressAcrossToolChanges(t *testing.T) {
	forwarder := newSlackMentionHistoryForwarder(nil, "C123", "123.456", "sess-1")
	forwarder.startedAt = time.Now().Add(-30 * time.Second)

	bashState := slackAssistantState{
		Phase: slackAssistantPhaseExecution,
		Tools: []slackAssistantToolCallState{{
			CallID:   "call-1",
			ToolName: "bash",
		}},
	}
	if got := forwarder.observeAssistantState(bashState); got != "" {
		t.Fatalf("expected no visible progress text, got %q", got)
	}
	pythonState := slackAssistantState{
		Phase: slackAssistantPhaseExecution,
		Tools: []slackAssistantToolCallState{{
			CallID:   "call-2",
			ToolName: "python",
		}},
	}
	if got := forwarder.observeAssistantState(pythonState); got != "" {
		t.Fatalf("expected no visible progress after tool switch, got %q", got)
	}
}
