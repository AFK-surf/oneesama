package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type recordingReactions struct {
	mu    sync.Mutex
	calls []reactionCall
}

type reactionCall struct {
	Method    string
	Channel   string
	Timestamp string
	Name      string
}

func (r *recordingReactions) AddReaction(_ context.Context, input SlackReactionInput) SlackReactionResult {
	r.record("add", input)
	return SlackReactionResult{OK: true, Method: "reactions.add"}
}

func (r *recordingReactions) RemoveReaction(_ context.Context, input SlackReactionInput) SlackReactionResult {
	r.record("remove", input)
	return SlackReactionResult{OK: true, Method: "reactions.remove"}
}

func (r *recordingReactions) record(method string, input SlackReactionInput) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, reactionCall{
		Method:    method,
		Channel:   input.Channel,
		Timestamp: input.Timestamp,
		Name:      input.Name,
	})
}

func (r *recordingReactions) Calls() []reactionCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reactionCall(nil), r.calls...)
}

func TestHandleEventsHelpFlipsMentionReactionToCheck(t *testing.T) {
	reactions := &recordingReactions{}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Poster:    &recordingPoster{},
		Reactions: reactions,
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvHelpReaction","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "add", Channel: "C123", Timestamp: "123.456", Name: slackReactionEyes},
		{Method: "remove", Channel: "C123", Timestamp: "123.456", Name: slackReactionEyes},
		{Method: "add", Channel: "C123", Timestamp: "123.456", Name: slackReactionOK},
	})
}

func TestHandleEventsRunningDelegateKeepsEyesUntilTerminal(t *testing.T) {
	reactions := &recordingReactions{}
	router := newTestRouter(t, Config{
		Slack:     appconfig.SlackConfig{SigningSecret: "secret"},
		Poster:    &recordingPoster{callCh: make(chan struct{}, 1)},
		Reactions: reactions,
		Runner: &fakeRunner{job: agentrunner.Job{
			ID:       "job_reaction_running",
			Provider: "codex",
			Status:   agentrunner.StatusRunning,
			Task:     "work",
		}},
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvRunningReaction","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> work","channel":"C123","ts":"123.456","thread_ts":"123.000"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Posted != nil {
		t.Fatalf("posted = %#v, want nil for running delegate", payload.Posted)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "add", Channel: "C123", Timestamp: "123.456", Name: slackReactionEyes},
	})
}

func TestWorkerTerminalFlipsMentionReaction(t *testing.T) {
	reactions := &recordingReactions{}
	service := NewService(Config{
		Poster:    &recordingPoster{callCh: make(chan struct{}, 1)},
		Assistant: &recordingAssistant{},
		Reactions: reactions,
	})

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:       "job_reaction_done",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   "Done",
		Context: map[string]any{
			"slack": map[string]any{
				"channel_id":  "C123",
				"thread_ts":   "123.000",
				"reaction_ts": "123.456",
			},
		},
	})

	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "remove", Channel: "C123", Timestamp: "123.456", Name: slackReactionEyes},
		{Method: "add", Channel: "C123", Timestamp: "123.456", Name: slackReactionOK},
	})
}

func assertReactionCalls(t *testing.T, got []reactionCall, want []reactionCall) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("reaction calls = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("reaction call[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
}
