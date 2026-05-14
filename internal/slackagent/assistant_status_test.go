package slackagent

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type assistantCall struct {
	Method string
	Status string
	Input  any
}

type recordingAssistant struct {
	mu    sync.Mutex
	calls []assistantCall
}

func (a *recordingAssistant) SetStatus(_ context.Context, input AssistantStatusInput) AssistantAPIResult {
	a.mu.Lock()
	a.calls = append(a.calls, assistantCall{Method: "assistant.threads.setStatus", Status: input.Status, Input: input})
	a.mu.Unlock()
	return AssistantAPIResult{OK: true, Mock: true, Status: http.StatusOK, Method: "assistant.threads.setStatus"}
}

func (a *recordingAssistant) SetSuggestedPrompts(_ context.Context, input AssistantSuggestedPromptsInput) AssistantAPIResult {
	a.mu.Lock()
	a.calls = append(a.calls, assistantCall{Method: "assistant.threads.setSuggestedPrompts", Input: input})
	a.mu.Unlock()
	return AssistantAPIResult{OK: true, Mock: true, Status: http.StatusOK, Method: "assistant.threads.setSuggestedPrompts"}
}

func (a *recordingAssistant) Calls() []assistantCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]assistantCall(nil), a.calls...)
}

func TestHandleEventsHelpSetsAndClearsAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Poster:    poster,
		Assistant: assistant,
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvHelpStatus","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	poster.WaitForCalls(t, 1)

	calls := assistant.Calls()
	assertStatusCalls(t, calls, []string{"Thinking...", ""})
}

func TestHandleEventsRunningDelegateKeepsAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Poster:    poster,
		Assistant: assistant,
		Runner: &fakeRunner{
			job: agentrunner.Job{
				ID:       "job_running_123",
				Provider: "codex",
				Status:   agentrunner.StatusRunning,
				Task:     "summarize this",
			},
		},
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvDelegateStatus","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> summarize this","channel":"C123","ts":"123.456"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want 0", got)
	}

	calls := assistant.Calls()
	assertStatusCalls(t, calls, []string{"Thinking..."})
}

func TestHandleEventsFailedDelegateClearsAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Poster:    poster,
		Assistant: assistant,
		Runner: &fakeRunner{
			job: agentrunner.Job{
				ID:       "job_failed_123",
				Provider: "codex",
				Status:   agentrunner.StatusFailed,
				Task:     "summarize this",
			},
		},
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvDelegateFailedStatus","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> summarize this","channel":"C123","ts":"123.456"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	poster.WaitForCalls(t, 1)

	calls := assistant.Calls()
	assertStatusCalls(t, calls, []string{"Thinking...", ""})
	if calls := poster.Calls(); calls[0].Text != slackImmediateWorkerFailureText {
		t.Fatalf("posted text = %q, want failed fallback", calls[0].Text)
	}
}

func TestHandleEventsAssistantThreadStartedSetsSuggestedPrompts(t *testing.T) {
	assistant := &recordingAssistant{}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Assistant: assistant,
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvAssistantPrompts","team_id":"T123","event":{"type":"assistant_thread_started","channel":"C123","ts":"123.999","assistant_thread":{"channel_id":"C123","thread_ts":"123.999","user_id":"U123"}}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	calls := assistant.Calls()
	if len(calls) != 1 || calls[0].Method != "assistant.threads.setSuggestedPrompts" {
		t.Fatalf("assistant calls = %#v, want one suggested-prompts call", calls)
	}
	input, ok := calls[0].Input.(AssistantSuggestedPromptsInput)
	if !ok || input.ChannelID != "C123" || input.ThreadTS != "123.999" {
		t.Fatalf("suggested prompt input = %#v", calls[0].Input)
	}
}

func TestAssistantStatusDedupeDebounceAndPriority(t *testing.T) {
	assistant := &recordingAssistant{}
	service := NewService(Config{Assistant: assistant})
	ref := AssistantThreadRef{ChannelID: "C123", ThreadTS: "123.456"}

	first := service.scheduleAssistantThreadStatus(context.Background(), ref, "Thinking...", true)
	if !first.OK {
		t.Fatalf("first status = %#v, want ok", first)
	}
	duplicate := service.scheduleAssistantThreadStatus(context.Background(), ref, "Thinking...", true)
	if !duplicate.OK || !duplicate.Skipped || duplicate.Reason != "duplicate_assistant_status" {
		t.Fatalf("duplicate = %#v, want duplicate skip", duplicate)
	}
	queued := service.scheduleAssistantThreadStatus(context.Background(), ref, "Working on it...", false)
	if !queued.OK || !queued.Queued {
		t.Fatalf("queued = %#v, want queued debounce", queued)
	}
	service.scheduleAssistantThreadStatus(context.Background(), ref, "Planning...", false)
	if got := len(assistant.Calls()); got != 1 {
		t.Fatalf("assistant calls before flush = %d, want 1", got)
	}
	service.flushPendingAssistantStatus(ref.ChannelID, ref.ThreadTS)

	priority := service.scheduleAssistantThreadStatus(context.Background(), ref, "Running code search...", false)
	if !priority.OK {
		t.Fatalf("priority = %#v, want ok", priority)
	}
	assertStatusCalls(t, assistant.Calls(), []string{"Thinking...", "Planning...", "Running code search..."})
}

func TestWorkerCallbacksPostTerminalResultAndClearAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	service := NewService(Config{
		Poster:    poster,
		Assistant: assistant,
	})
	job := agentrunner.Job{
		ID:       "job_done_123",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Task:     "summarize this",
		Result:   "Done summary",
		Context: map[string]any{
			"slack": map[string]any{
				"channel_id": "C123",
				"thread_ts":  "123.456",
			},
		},
	}

	service.handleAgentRunnerUpdate(context.Background(), job)
	poster.WaitForCalls(t, 1)
	service.handleAgentRunnerUpdate(context.Background(), job)

	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want deduped single terminal post", len(calls))
	}
	if calls[0].Text != "Done summary" {
		t.Fatalf("posted text = %q, want job result", calls[0].Text)
	}
	assertStatusCalls(t, assistant.Calls(), []string{""})
}

func TestWorkerProgressUpdatesAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	service := NewService(Config{Assistant: assistant})
	service.handleAgentRunnerProgress(context.Background(), agentrunner.Job{
		ID:       "job_progress_123",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
		Context: map[string]any{
			"slack": map[string]any{
				"channel_id": "C123",
				"thread_ts":  "123.456",
			},
		},
	})

	calls := assistant.Calls()
	assertStatusCalls(t, calls, []string{"Starting Codex..."})
}

func assertStatusCalls(t *testing.T, calls []assistantCall, want []string) {
	t.Helper()
	got := make([]string, 0, len(calls))
	for _, call := range calls {
		if call.Method == "assistant.threads.setStatus" {
			got = append(got, call.Status)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("status calls = %q, want %q (all calls %#v)", strings.Join(got, ","), strings.Join(want, ","), calls)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("status call %d = %q, want %q (all %q)", index, got[index], want[index], strings.Join(got, ","))
		}
	}
}
