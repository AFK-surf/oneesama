package slackagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleTriageRunDoesNotInventFallbackActionCards(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				PostActions:       false,
				HeuristicFallback: true,
			},
		},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "dry-run", DryRun: true},
	})

	body := `{"team_id":"T123","channel_id":"C123","user_id":"U123","text":"need follow up on the blocked deploy","ts":"123.456"}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/triage/run", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"source":"slack-triage"`) || strings.Contains(response.Body.String(), `"action_type":"follow_up"`) {
		t.Fatalf("body = %s, want triage job without invented pending follow_up", response.Body.String())
	}

	status := httptest.NewRecorder()
	statusRequest := httptest.NewRequest(http.MethodGet, "/slack/triage/status", nil)
	statusRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(status, statusRequest)
	if status.Code != http.StatusOK {
		t.Fatalf("status route = %d, want 200: %s", status.Code, status.Body.String())
	}
	if strings.Contains(status.Body.String(), `"pendingActions"`) || !strings.Contains(status.Body.String(), `"channelBrains"`) {
		t.Fatalf("status body = %s, want no pending actions and channel brain", status.Body.String())
	}
}

func TestHandleTriageRunRecordsModelRequestedPendingAction(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				PostActions:       false,
				HeuristicFallback: true,
			},
		},
		Runner: &fakeRunner{job: agentrunner.Job{
			ID:       "job_triage_followup",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"summary":"owner follow-up needed","actions":[{"type":"follow_up","title":"Follow up with owner","message":"请确认 owner 并跟进 blocked deploy。","confidence":0.82,"requiresConfirmation":true}]}`,
		}},
	})

	body := `{"team_id":"T123","channel_id":"C123","user_id":"U123","text":"need follow up on the blocked deploy","ts":"123.456"}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/triage/run", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"source":"slack-triage"`) || !strings.Contains(response.Body.String(), `"action_type":"follow_up"`) {
		t.Fatalf("body = %s, want model-requested pending follow_up", response.Body.String())
	}
}

func TestInboundFlushStartsTriageWhenEnabled(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "dry-run", DryRun: true},
	})
	body := `{"type":"event_callback","event_id":"EvTriageFlush","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"please fix the blocked deploy","channel":"C123","ts":"123.456"}}`
	_ = signedSlackEventRequest(t, router, body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/inbound/flush", strings.NewReader(`{"channel_id":"C123"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("flush status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Flushes []SlackInboundFlushResult `json:"flushes"`
		Inbound SlackInboundState         `json:"inbound"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Flushes) != 1 || payload.Flushes[0].Triage == nil || payload.Flushes[0].Triage.Finalization == nil {
		t.Fatalf("payload = %#v, want triage finalization", payload)
	}
	if payload.Inbound.EventBuffer.LastTriageJobID == "" {
		t.Fatalf("inbound = %#v, want last triage job id", payload.Inbound)
	}
}

func TestSlackTriageDecisionParsesFencedJSON(t *testing.T) {
	decision := parseSlackTriageDecision("```json\n{\"summary\":\"Decision: use Codex\",\"actions\":[{\"type\":\"follow_up\",\"title\":\"Ping owner\",\"message\":\"Ask owner\",\"confidence\":0.8,\"requiresConfirmation\":true}]}\n```", slackTriageFallback{Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK || decision.Summary != "Decision: use Codex" || len(decision.Actions) != 1 {
		t.Fatalf("decision = %#v, want parsed action", decision)
	}
	if decision.Actions[0].ChannelID != "C123" || decision.Actions[0].ThreadTS != "123.456" {
		t.Fatalf("action = %#v, want fallback channel/thread", decision.Actions[0])
	}
}

func TestSlackTriageDecisionHidesWorkerMechanismAction(t *testing.T) {
	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID: "C123",
		Digest:    "please investigate this link",
	})
	if strings.Contains(prompt, "delegate") {
		t.Fatalf("prompt contains hidden worker command: %s", prompt)
	}

	decision := parseSlackTriageDecision(`{"summary":"route work","actions":[{"type":"delegate","title":"Investigate","message":"Check this","requiresConfirmation":true}]}`, slackTriageFallback{Channel: "C123", ThreadTS: "123.456"})
	if len(decision.Actions) != 1 {
		t.Fatalf("decision = %#v, want one normalized action", decision)
	}
	if decision.Actions[0].Type != "create_task" {
		t.Fatalf("action type = %q, want create_task", decision.Actions[0].Type)
	}
}

func TestChannelBrainBuildsFactsAndOpenLoops(t *testing.T) {
	summary := buildChannelBrainSummary([]SlackThreadLedgerRecord{
		{ThreadTS: "111.222", Status: "active", Summary: "Decision: use Codex for runner", UpdatedAt: "2026-05-13T01:00:00Z"},
		{ThreadTS: "333.444", Status: "active", Summary: "Follow-up: confirm deploy owner", UpdatedAt: "2026-05-13T01:01:00Z"},
	})
	if !strings.Contains(summary, "Shared open loops:") || !strings.Contains(summary, "confirm deploy owner") {
		t.Fatalf("summary = %q, want open loop", summary)
	}
	if !strings.Contains(summary, "Shared facts and conventions:") || !strings.Contains(summary, "use Codex for runner") {
		t.Fatalf("summary = %q, want facts", summary)
	}
}
