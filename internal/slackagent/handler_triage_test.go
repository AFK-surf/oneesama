package slackagent

import (
	"bytes"
	"context"
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

func TestSlackTriageDecisionRepairsPlainNoActionOutput(t *testing.T) {
	raw := "No action.\n\n线程自然收尾，不需要再接话。"
	decision := parseSlackTriageDecision(raw, slackTriageFallback{Summary: "fallback summary", Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK {
		t.Fatalf("decision = %#v, want repaired no-action output to count as parsed", decision)
	}
	if len(decision.Actions) != 0 {
		t.Fatalf("actions = %#v, want no actions", decision.Actions)
	}
	if !strings.Contains(decision.Summary, "线程自然收尾") {
		t.Fatalf("summary = %q, want repaired plain-text no-action summary", decision.Summary)
	}
	if reason := slackTriageSuppressedReason(decision, decision.Actions, true); reason != "no_actions" {
		t.Fatalf("suppressed reason = %q, want no_actions after repair", reason)
	}
}

func TestSlackTriageDecisionStripsInlineNoActionPrefix(t *testing.T) {
	raw := "No action. 用户分享链接闲聊，无需助手介入。"
	decision := parseSlackTriageDecision(raw, slackTriageFallback{Summary: "fallback summary", Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK {
		t.Fatalf("decision = %#v, want inline no-action output repaired", decision)
	}
	if decision.Summary != "用户分享链接闲聊，无需助手介入。" {
		t.Fatalf("summary = %q, want no-action prefix stripped", decision.Summary)
	}
}

func TestSlackTriageDecisionStripsParsedNoActionSummaryPrefix(t *testing.T) {
	raw := `{"summary":"No action. U123 已经接住问题，无需助手介入。","actions":[]}`
	decision := parseSlackTriageDecision(raw, slackTriageFallback{Summary: "fallback summary", Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK {
		t.Fatalf("decision = %#v, want parsed JSON", decision)
	}
	if decision.Summary != "U123 已经接住问题，无需助手介入。" {
		t.Fatalf("summary = %q, want parsed no-action prefix stripped", decision.Summary)
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

func TestTriageStatusDefaultKeepsAuditWindowBeyondTenRuns(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	for i := 0; i < 12; i++ {
		if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
			SessionID: "triage-window",
			Status:    "ok",
			Summary:   "run",
			Channels:  []string{"C123"},
		}); err != nil {
			t.Fatalf("RecordRun %d: %v", i, err)
		}
	}
	status, err := service.TriageStatus(context.Background(), 0)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.Runs) != 12 {
		t.Fatalf("runs = %d, want all 12 by default for 6h audit window", len(status.Runs))
	}
}

func TestTriageStatusReportsSampleFreshness(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 16, 5, 46, 28, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		Timestamp: now.Add(-4 * time.Hour).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "oldest",
		Channels:  []string{"C123"},
	}); err != nil {
		t.Fatalf("RecordRun oldest: %v", err)
	}
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		Timestamp: now.Add(-30 * time.Minute).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "newest",
		Channels:  []string{"C123"},
	}); err != nil {
		t.Fatalf("RecordRun newest: %v", err)
	}
	status, err := service.TriageStatus(context.Background(), 0)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if status.AuditFreshness == nil {
		t.Fatalf("AuditFreshness missing")
	}
	if status.AuditFreshness.RunCount != 2 || status.AuditFreshness.NewestRunAgeSeconds != int64((30*time.Minute).Seconds()) {
		t.Fatalf("freshness = %#v, want run count and newest age", status.AuditFreshness)
	}
	if status.AuditFreshness.OldestRunAt == "" || status.AuditFreshness.NewestRunAt == "" || status.AuditFreshness.SampleWindowSeconds != int64((3*time.Hour+30*time.Minute).Seconds()) {
		t.Fatalf("freshness = %#v, want oldest/newest sample window", status.AuditFreshness)
	}
}

func TestTriageStatusIncludesAuditFixtures(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	status, err := service.TriageStatus(context.Background(), 0)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.AuditFixtures) != 3 {
		t.Fatalf("fixtures = %#v, want ACT/MAYBE/SKIP controls", status.AuditFixtures)
	}
	byName := map[string]SlackTriageAuditFixture{}
	for _, fixture := range status.AuditFixtures {
		byName[fixture.Name] = fixture
		if !fixture.ParseOK || !fixture.Pass {
			t.Fatalf("fixture = %#v, want parsed passing control", fixture)
		}
	}
	if byName["act_post_thread_reply"].Outcome != "ACT" || byName["act_post_thread_reply"].Actions != 1 || byName["act_post_thread_reply"].Mutations != 1 {
		t.Fatalf("ACT fixture = %#v", byName["act_post_thread_reply"])
	}
	if byName["maybe_follow_up"].Outcome != "MAYBE" || byName["maybe_follow_up"].Actions != 1 || byName["maybe_follow_up"].Mutations != 0 {
		t.Fatalf("MAYBE fixture = %#v", byName["maybe_follow_up"])
	}
	if byName["skip_no_action"].Outcome != "SKIP" || byName["skip_no_action"].Actions != 0 || byName["skip_no_action"].SuppressedReason != "no_actions" {
		t.Fatalf("SKIP fixture = %#v", byName["skip_no_action"])
	}
}

func TestTriageAuditReportsSixHourRollupAndFlags(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 1, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	runs := []SlackTriageContext{
		{
			Timestamp: now.Add(-7 * time.Hour).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "outside window",
			Channels:  []string{"C123"},
			Mutations: 1,
			Metadata:  map[string]any{"input_context_chars": 900},
		},
		{
			Timestamp: now.Add(-5 * time.Hour).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "low context skip",
			Channels:  []string{"C123"},
			Metadata: map[string]any{
				"input_context_chars":      120,
				"channel_context_fetched":  true,
				"thread_context_fetched":   false,
				"external_links_fetched":   1,
				"suppressed_reason":        "no_actions",
				"channel_context_messages": 3,
			},
		},
		{
			Timestamp: now.Add(-4 * time.Hour).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "maybe follow-up",
			Channels:  []string{"C123"},
			Actions:   []SlackTriageAction{{Tool: "suggest_action", Channel: "C123", Brief: "needs owner"}},
			Metadata: map[string]any{
				"input_context_chars":     300,
				"thread_context_fetched":  true,
				"external_links_fetched":  0,
				"thread_context_messages": 4,
			},
		},
		{
			Timestamp: now.Add(-150 * time.Minute).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "direct reply",
			Channels:  []string{"C123"},
			Actions:   []SlackTriageAction{{Tool: "slack_api", Channel: "C123", Brief: "posted"}},
			Mutations: 1,
			Metadata: map[string]any{
				"input_context_chars":    500,
				"thread_context_fetched": true,
			},
		},
	}
	for _, run := range runs {
		if _, err := service.triage.RecordRun(context.Background(), run); err != nil {
			t.Fatalf("RecordRun: %v", err)
		}
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.RunCount != 3 || report.Outcome.Mutations != 1 || report.Outcome.OutboundRuns != 1 || report.Outcome.MaybeRuns != 1 || report.Outcome.NoActionRuns != 1 {
		t.Fatalf("outcome = %#v runCount=%d", report.Outcome, report.RunCount)
	}
	if report.InputContext.Min != 120 || report.InputContext.Median != 300 || report.InputContext.Max != 500 || report.InputContext.LowUnder200 != 1 {
		t.Fatalf("inputContext = %#v", report.InputContext)
	}
	if report.ContextFetch.ChannelContextFetched != 1 || report.ContextFetch.ThreadContextFetched != 2 || report.ContextFetch.ExternalLinksFetched != 1 {
		t.Fatalf("contextFetch = %#v", report.ContextFetch)
	}
	if report.Canary.Total != 3 || report.Canary.Passed != 3 || report.Canary.NeedsLiveSample {
		t.Fatalf("canary = %#v", report.Canary)
	}
	if !hasAuditFlag(report.Flags, "stale_sample") || !hasAuditFlag(report.Flags, "low_context_samples") {
		t.Fatalf("flags = %#v, want stale and low context", report.Flags)
	}
	if hasAuditFlag(report.Flags, "no_live_positive_samples") {
		t.Fatalf("flags = %#v, live positive exists", report.Flags)
	}
}

func TestTriageAuditFlagsMissingLivePositiveSample(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 1, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		Timestamp: now.Add(-time.Hour).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "skip",
		Channels:  []string{"C123"},
		Metadata:  map[string]any{"input_context_chars": 400, "suppressed_reason": "no_actions"},
	}); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if !report.Canary.NeedsLiveSample || !hasAuditFlag(report.Flags, "no_live_positive_samples") {
		t.Fatalf("report = %#v, want live positive warning", report)
	}
}

func TestHandleTriageAuditReturnsSelfServeReport(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 1, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/triage/audit?window=6h", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var payload struct {
		OK    bool                   `json:"ok"`
		Audit SlackTriageAuditReport `json:"audit"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || payload.Audit.RunCount != 0 || payload.Audit.Canary.Total != 3 || !hasAuditFlag(payload.Audit.Flags, "no_recent_runs") {
		t.Fatalf("payload = %#v", payload)
	}
}

func hasAuditFlag(flags []SlackTriageAuditFlag, code string) bool {
	for _, flag := range flags {
		if flag.Code == code {
			return true
		}
	}
	return false
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
