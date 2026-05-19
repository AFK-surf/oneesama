package slackagent

import (
	"context"
	"encoding/json"
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

func TestSlackTriageRelatedMemoryUsesFreshQuestionOverDigestContext(t *testing.T) {
	workspaceDir := t.TempDir()
	writeTestFile(t, filepath.Join(workspaceDir, "memory", "legacy", "slack-agent-d", "workspace", "memory", "team", "facts", "meeting-84.md"), strings.Join([]string{
		"# Meeting 84 stable facts",
		"",
		"- 所有付费用户订阅额度已全部重置拉满，免费送的用户也需要重置",
	}, "\n"))
	writeTestFile(t, filepath.Join(workspaceDir, "memory", "legacy", "slack-agent-d", "workspace", "memory", "team", "meetings", "meeting-84.md"), strings.Join([]string{
		"# Meeting 84",
		"",
		"Action item: 重置免费用户（送的）的额度，三到五天内最高额度。",
	}, "\n"))
	writeTestFile(t, filepath.Join(workspaceDir, "memory", "people", "bridge-apple.md"), strings.Join([]string{
		"# Entity graph noise",
		"",
		"Bridge contact is Apple.",
		"Apple organization is Watch.",
	}, "\n"))
	writeNoActionTriageProjection(t, workspaceDir, SlackTriageContext{
		SessionID: "triage:C09KVPBMLJ3:1779179367129",
		Timestamp: "2026-05-19T08:29:27Z",
		Status:    "ok",
		Channels:  []string{"C09KVPBMLJ3"},
		Summary:   "Nicole 问没付费用户是否 reset quota，属于产品/技术问题，超出 office helper 范围，无动作。",
		Digest:    "没付费的用户 reset quota 了吗",
		Metadata: map[string]any{
			"suppressed_reason":  "no_actions",
			"skip_reason_bucket": "no_action_other",
		},
	})

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_quota_memory_question",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"fixture","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
		Runner: runner,
	})
	messages := []SlackInboundMessage{{
		ChannelID: "C09KVPBMLJ3",
		TeamID:    "T123",
		TS:        "1779179299.144449",
		UserID:    "U09L4CPK3BL",
		Text:      "没付费的用户 reset quota 了吗",
	}}
	digest := strings.Join([]string{
		"=== Slack Activity ===",
		"",
		"#C09KVPBMLJ3",
		"  (context) <@U09L4CPK3BL>: \"bridge 能接 apple watch 吗\"",
		"  (context) <@U09L0U0SJ3F>: \"首先得有ios app\"",
		"  (context) <@U09L4CPK3BL>: \"刚刷到一个在手表上玩吃鸡的。。\"",
		"  --- new messages ---",
		"  • [ref:m1 msg_ts:1779179299.144449] <@U09L4CPK3BL>: \"没付费的用户 reset quota 了吗\"",
	}, "\n")

	if _, err := service.startSlackTriage(context.Background(), "C09KVPBMLJ3", messages, digest, slackTriageStartOptions{}); err != nil {
		t.Fatalf("startSlackTriage: %v", err)
	}

	localMemory, ok := runner.startInput.Context["localSlackMemory"].(map[string]any)
	if !ok {
		t.Fatalf("localSlackMemory = %#v, want map context", runner.startInput.Context["localSlackMemory"])
	}
	query, _ := localMemory["query"].(string)
	if query != "没付费的用户 reset quota 了吗" {
		t.Fatalf("memory query = %q, want fresh question only", query)
	}
	if strings.Contains(strings.ToLower(query), "apple") || strings.Contains(strings.ToLower(query), "bridge") {
		t.Fatalf("memory query leaked stale digest context: %q", query)
	}
	localResults, ok := localMemory["results"].([]SlackTriageMemoryEntry)
	if !ok || len(localResults) == 0 {
		t.Fatalf("localSlackMemory results = %#v, want meeting fact evidence", localMemory["results"])
	}
	if !strings.Contains(localResults[0].Content, "免费送的用户也需要重置") && !strings.Contains(localResults[0].Content, "重置免费用户") {
		t.Fatalf("top local memory = %#v, want quota reset meeting evidence", localResults[0])
	}
	for _, result := range localResults {
		if result.Kind == "triage_projection" && strings.Contains(result.Content, "无动作") {
			t.Fatalf("local memory included no-action projection as evidence: %#v", result)
		}
	}

	related, ok := runner.startInput.Context["relatedMemory"].(SlackRelatedMemorySearchResult)
	if !ok {
		t.Fatalf("relatedMemory = %#v, want search result", runner.startInput.Context["relatedMemory"])
	}
	if len(related.Results) == 0 {
		t.Fatalf("related memory empty, want meeting fact evidence")
	}
	top := related.Results[0]
	if top.Kind != "team_fact" && top.Kind != "team_meeting" {
		t.Fatalf("top related memory kind = %q, want team fact/meeting before digest/entity noise; results = %#v", top.Kind, related.Results)
	}
	if !strings.Contains(top.Content, "免费送的用户也需要重置") && !strings.Contains(top.Content, "重置免费用户") {
		t.Fatalf("top related memory = %q, want quota reset meeting evidence", top.Content)
	}
	for _, record := range related.Results {
		if record.Kind == "triage_projection" && strings.Contains(record.Content, "无动作") {
			t.Fatalf("related memory included no-action projection as evidence: %#v", record)
		}
		if record.Kind == "entity_graph" && strings.Contains(record.Content, "Apple") {
			t.Fatalf("related memory was polluted by stale digest entity graph context: %#v", record)
		}
	}
}

func writeNoActionTriageProjection(t *testing.T, workspaceDir string, context SlackTriageContext) {
	t.Helper()
	raw, err := json.Marshal([]SlackTriageContext{context})
	if err != nil {
		t.Fatalf("Marshal triage context: %v", err)
	}
	writeTestFile(t, filepath.Join(workspaceDir, "memory", triageContextFile), string(raw))
}
