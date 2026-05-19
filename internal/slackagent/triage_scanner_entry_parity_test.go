package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackHistoryScannerTriageCarriesMemoryAndPlannerContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C224","name":"scanner-parity","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("channel") != "C224" {
				t.Fatalf("channel = %q, want C224", r.Form.Get("channel"))
			}
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			if got := r.Form.Get("oldest"); got != "1779167000.000000" {
				t.Fatalf("oldest = %q, want stored cursor", got)
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"UQUESTION","text":"calypso cumulon recall ladder 这个没人接吗？","ts":"1779167100.000000","team":"T123"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	workspaceDir := t.TempDir()
	writeTestFile(t, filepath.Join(workspaceDir, "memory", "team", "calypso-cumulon.md"), strings.Join([]string{
		"# Calypso cumulon recall ladder",
		"",
		"When scanner triage sees a calypso cumulon recall ladder question, cite this note before drafting a reply.",
		"Use this as a production scanner-entry parity fixture, not as an app_mention-only fixture.",
	}, "\n"))

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_scanner_entry_parity",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"scanner parity fixture observed","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:     "xoxb-test",
			WorkspaceDir: workspaceDir,
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				HeuristicFallback: true,
			},
		},
		Runner: runner,
	})
	service.inbound.SetCursor("C224", "1779167000.000000")
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		SessionID: "triage-prev-scanner",
		Status:    "ok",
		Timestamp: "2026-05-19T05:00:00Z",
		Summary:   "previous scanner triage used memory before replying",
		Channels:  []string{"C224"},
		Actions: []SlackTriageAction{{
			Tool:    "post_thread_reply",
			Channel: "C224",
			Brief:   "answered a scanner memory question with cited context",
		}},
	}); err != nil {
		t.Fatalf("record previous triage: %v", err)
	}

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.Source != "slack_web_api" || sweep.Buffered != 1 || sweep.Flushed == nil || sweep.Flushed.Count != 1 {
		t.Fatalf("sweep = %#v, want scanner history message flushed into triage", sweep)
	}
	if runner.startCount != 1 {
		t.Fatalf("runner start count = %d, want 1", runner.startCount)
	}

	task := runner.startInput.Task
	for _, want := range []string{
		"calypso cumulon recall ladder",
		"[ref:m1 msg_ts:1779167100.000000]",
		"Relevant local memory",
		"memory/team/calypso-cumulon.md",
		"=== Previous Triage ===",
		"post_thread_reply \"answered a scanner memory question with cited context\"",
	} {
		if !strings.Contains(task, want) {
			t.Fatalf("runner task missing %q:\n%s", want, task)
		}
	}

	capabilities, ok := runner.startInput.Context["session_capabilities"].(agentrunner.SessionCapabilities)
	if !ok {
		t.Fatalf("session_capabilities = %#v, want agentrunner.SessionCapabilities", runner.startInput.Context["session_capabilities"])
	}
	if capabilities.Kind != agentrunner.SessionKindTriage {
		t.Fatalf("session capability kind = %q, want %q", capabilities.Kind, agentrunner.SessionKindTriage)
	}
	if !slices.Contains(capabilities.AllowedTools, "followup_memory") || !slices.Contains(capabilities.AllowedTools, "person_memory") || !slices.Contains(capabilities.AllowedTools, "slack_api") {
		t.Fatalf("triage capabilities = %#v, want Cueboard planner memory/slack tools", capabilities.AllowedTools)
	}
	if slices.Contains(capabilities.AllowedTools, "image_generation") || slices.Contains(capabilities.AllowedTools, "audio_generation") {
		t.Fatalf("triage capabilities = %#v, want scanner planner to exclude assistant-only media tools", capabilities.AllowedTools)
	}

	localMemory, ok := runner.startInput.Context["localSlackMemory"].(map[string]any)
	if !ok {
		t.Fatalf("localSlackMemory = %#v, want map context", runner.startInput.Context["localSlackMemory"])
	}
	results, ok := localMemory["results"].([]SlackTriageMemoryEntry)
	if !ok || len(results) == 0 || results[0].Source != "workspace:memory/team/calypso-cumulon.md" {
		t.Fatalf("localSlackMemory results = %#v, want scanner parity memory as top evidence", localMemory["results"])
	}
}
