package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackTriageSummarizesOversizedThreadContextBeforeRunner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/conversations.replies" {
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		messages := make([]SlackMessage, 0, maxAppMentionThreadMessages)
		longText := strings.Repeat("long migration context with unresolved memory and persona decisions ", 8)
		for i := 0; i < maxAppMentionThreadMessages; i++ {
			ts := fmt.Sprintf("1779090000.%06d", i+1)
			messages = append(messages, SlackMessage{
				Type:     "message",
				User:     fmt.Sprintf("U%03d", i%4),
				Text:     fmt.Sprintf("message %02d %s", i, longText),
				TS:       ts,
				ThreadTS: "1779090000.000001",
			})
		}
		_ = json.NewEncoder(w).Encode(slackRepliesResponse{OK: true, Messages: messages})
	}))
	defer server.Close()
	oldBase := slackThreadFetchAPIBaseURL
	slackThreadFetchAPIBaseURL = server.URL
	t.Cleanup(func() { slackThreadFetchAPIBaseURL = oldBase })

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_summarized_context",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"summarized context reached runner","actions":[]}`,
	}}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Persona summary: the thread is deciding whether Pi should own memory, with unresolved asks around worker delegation and citations.",
		ShadowOnly:  true,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			Triage:   appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{Provider: persona.ProviderPi, Mode: persona.ModeShadow, ShadowOnly: true, Timeout: time.Second},
		Runner:         runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:     "T123",
		ChannelID:  "C123",
		UserID:     "U123",
		Text:       "请看这个长 thread 的 memory 迁移问题",
		TS:         "1779090000.000001",
		ReplyCount: maxAppMentionThreadMessages - 1,
	}}, "#meeting-avatar: 请看这个长 thread 的 memory 迁移问题")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized triage run", started)
	}
	if got := len(runtime.requests); got < 1 {
		t.Fatalf("persona requests = %d, want at least one context summary request", got)
	}
	request := runtime.requests[0]
	if request.Event.Kind != "slack_context_summary" || request.Metadata["purpose"] != "internal_context_summary" {
		t.Fatalf("persona request = %#v, want internal slack_context_summary", request)
	}
	if !strings.Contains(request.Event.Text, "long migration context") || request.Safety.AllowSpeech || request.Safety.AllowWorkerRequest {
		t.Fatalf("persona request = %#v, want raw context text with no speech/worker side effects", request)
	}
	task := runner.startInput.Task
	if !strings.Contains(task, "Persona summary: the thread is deciding whether Pi should own memory") {
		t.Fatalf("runner task missing persona summary:\n%s", task)
	}
	if strings.Contains(task, "message 49 long migration context") {
		t.Fatalf("runner task still contains raw oversized thread transcript:\n%s", task)
	}
	threadContexts, ok := runner.startInput.Context["threadContexts"].([]SlackTriageThreadContext)
	if !ok || len(threadContexts) != 1 || len(threadContexts[0].Messages) != 0 {
		t.Fatalf("threadContexts = %#v, want one compact summary context without raw messages", runner.startInput.Context["threadContexts"])
	}
	run := started.Finalization.Run
	if run.Metadata["triage_context_summary_applied"] != true || run.Metadata["triage_context_summary_runtime"] != persona.ProviderPi {
		t.Fatalf("metadata = %#v, want applied persona summary", run.Metadata)
	}
	if intFromAny(run.Metadata["triage_context_summary_raw_chars"]) <= slackTriageLongContextCharThreshold {
		t.Fatalf("metadata = %#v, want raw context above threshold", run.Metadata)
	}
}

func TestSlackTriageKeepsRawOversizedContextWhenPersonaSummaryUnavailable(t *testing.T) {
	longText := strings.Repeat("raw long context ", 900)
	contexts := []SlackTriageThreadContext{{
		ChannelID:    "C123",
		ThreadTS:     "1779090000.000001",
		FetchOK:      true,
		MessageCount: 2,
		Transcript:   longText,
	}}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	got, metadata := service.maybeSummarizeOversizedSlackTriageThreadContexts(context.Background(), "C123", "1779090000.000001", nil, "digest", contexts)
	if len(got) != 1 || got[0].Transcript != longText {
		t.Fatalf("contexts = %#v, want raw context preserved when persona runtime is unavailable", got)
	}
	if metadata["triage_context_summary_attempted"] != true || metadata["triage_context_summary_applied"] != false || metadata["triage_context_summary_error"] != "persona_runtime_unavailable" {
		t.Fatalf("metadata = %#v, want unavailable summary audit", metadata)
	}
}
