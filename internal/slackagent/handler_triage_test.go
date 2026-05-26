package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type statusOnlyPersonaRuntime struct {
	status persona.Status
}

func (r statusOnlyPersonaRuntime) Decide(context.Context, persona.Request) (persona.Response, error) {
	return persona.Response{Runtime: r.status.Provider, Decision: persona.DecisionStaySilent, ShadowOnly: r.status.ShadowOnly}, nil
}

func (r statusOnlyPersonaRuntime) Status(context.Context) persona.Status {
	return r.status
}

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
	if strings.Contains(status.Body.String(), `"pendingActions"`) {
		t.Fatalf("status body = %s, want no invented pending actions", status.Body.String())
	}
}

func TestHandleTriageRunAcceptsIgnoreExistingBotReply(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_force_rerun",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	body := `{"team_id":"T123","channel_id":"C123","user_id":"U123","text":"看看这个链接","ts":"123.456","thread_ts":"123.456","ignore_existing_bot_reply":true}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/triage/run", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if got := boolFromAny(runner.startInput.Context["ignore_existing_bot_reply"], false); !got {
		t.Fatalf("runner context ignore_existing_bot_reply = %#v, want true", runner.startInput.Context["ignore_existing_bot_reply"])
	}
	if !strings.Contains(runner.startInput.Task, "Dev rerun override") || !strings.Contains(runner.startInput.Task, "Ignore bot-authored replies") {
		t.Fatalf("task missing dev rerun override:\n%s", runner.startInput.Task)
	}
}

func TestHandleTriageRunDryRunBlocksSideEffects(t *testing.T) {
	cfg := Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{PostActions: true},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider:   persona.ProviderPi,
			Mode:       persona.ModeLive,
			ShadowOnly: false,
			Timeout:    time.Second,
		},
	}
	service := NewService(cfg)
	service.personaRuntimeErr = nil
	service.personaRuntime = &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "我看到了，应该交给现有 owner 跟进。",
		Confidence:  0.8,
		EvidenceAnchors: []persona.EvidenceAnchor{{
			Kind:      "explicit_user_command",
			SourceRef: "slack:C123:123.456",
			Quote:     "帮我看下这个",
		}},
	}}
	handler := NewHandler(service)
	router := httpserver.New("slack-agent", slog.New(slog.NewTextHandler(io.Discard, nil)), []string{"*"}, handler)

	body := `{"team_id":"T123","channel_id":"C123","user_id":"U123","text":"帮我看下这个","ts":"123.456","dry_run":true}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/triage/run", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var payload struct {
		OK     bool                    `json:"ok"`
		DryRun SlackTriageDryRunResult `json:"dry_run"`
		Status string                  `json:"status"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.DryRun.DryRun {
		t.Fatalf("payload = %#v, want dry_run result", payload)
	}
	if payload.Status != "would_post_reply" {
		t.Fatalf("status = %q, want would_post_reply", payload.Status)
	}
	if len(payload.DryRun.ActionsBeforeGate) != 1 || len(payload.DryRun.ActionsAfterGate) != 1 {
		t.Fatalf("actions before/after = %d/%d, want 1/1", len(payload.DryRun.ActionsBeforeGate), len(payload.DryRun.ActionsAfterGate))
	}
	if len(payload.DryRun.VisibleReplyVerdicts) != 1 || !payload.DryRun.VisibleReplyVerdicts[0].Allowed {
		t.Fatalf("visible verdicts = %#v, want allowed reply verdict", payload.DryRun.VisibleReplyVerdicts)
	}
	if stringSliceContains(payload.DryRun.SideEffectsBlocked, "approval_card") || !stringSliceContains(payload.DryRun.SideEffectsBlocked, "slack_post") {
		t.Fatalf("side effects = %#v, want slack_post blocked and no approval_card", payload.DryRun.SideEffectsBlocked)
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

func TestSlackTriageDecisionRepairsMalformedNoActionWithUnescapedCJKQuotes(t *testing.T) {
	raw := `{"summary":"No action. 用户只是说"蹲"一下，暂时不用接话。","actions":[]}`
	decision := parseSlackTriageDecision(raw, slackTriageFallback{Summary: "fallback summary", Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK {
		t.Fatalf("decision = %#v, want malformed no-action output repaired", decision)
	}
	if len(decision.Actions) != 0 {
		t.Fatalf("actions = %#v, want no actions", decision.Actions)
	}
	if !strings.Contains(decision.Summary, "蹲") {
		t.Fatalf("summary = %q, want repaired summary to retain CJK quoted text", decision.Summary)
	}
	if reason := slackTriageSuppressedReason(decision, decision.Actions, true); reason != "no_actions" {
		t.Fatalf("suppressed reason = %q, want no_actions after repair", reason)
	}
}

func TestSlackTriageDecisionRepairsCJKPunctuationNoAction(t *testing.T) {
	raw := "【无需操作】这条只是“蹲一下 / 围观”，没有明确请求；继续观察。"
	decision := parseSlackTriageDecision(raw, slackTriageFallback{Summary: "fallback summary", Channel: "C123", ThreadTS: "123.456"})
	if !decision.ParseOK {
		t.Fatalf("decision = %#v, want CJK punctuation no-action output repaired", decision)
	}
	if len(decision.Actions) != 0 {
		t.Fatalf("actions = %#v, want no actions", decision.Actions)
	}
	if !strings.Contains(decision.Summary, "围观") {
		t.Fatalf("summary = %q, want repaired summary to retain CJK punctuation text", decision.Summary)
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

func TestStartSlackTriageAnnotatesWorkspacePolicyBoundary(t *testing.T) {
	policy := "Reply to source-backed product-adjacent articles in this workspace."
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_policy_boundary",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{WorkspacePolicy: policy},
		},
		Runner: runner,
	})
	result, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "看看这个产品文章",
		TS:        "123.456",
	}}, "")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	want := buildSlackWorkspacePolicyStatus(policy)
	if runner.startCount != 1 {
		t.Fatalf("runner start count = %d, want 1", runner.startCount)
	}
	if got := runner.startInput.Context["workspaceTriagePolicySource"]; got != want.Source {
		t.Fatalf("workspaceTriagePolicySource = %#v, want %q", got, want.Source)
	}
	if got := runner.startInput.Context["workspaceTriagePolicyVersion"]; got != want.Version {
		t.Fatalf("workspaceTriagePolicyVersion = %#v, want %q", got, want.Version)
	}
	if got := runner.startInput.Context["workspaceTriagePolicyHash"]; got != want.Hash {
		t.Fatalf("workspaceTriagePolicyHash = %#v, want %q", got, want.Hash)
	}
	if !strings.Contains(runner.startInput.Task, "Workspace triage policy metadata:") || !strings.Contains(runner.startInput.Task, want.Version) {
		t.Fatalf("task missing workspace policy metadata:\n%s", runner.startInput.Task)
	}
	if result.Run == nil {
		t.Fatalf("run missing")
	}
	if got := stringFromContext(result.Run.Metadata, "workspace_policy_source"); got != want.Source {
		t.Fatalf("run workspace_policy_source = %q, want %q", got, want.Source)
	}
	if got := stringFromContext(result.Run.Metadata, "workspace_policy_version"); got != want.Version {
		t.Fatalf("run workspace_policy_version = %q, want %q", got, want.Version)
	}
	if got := stringFromContext(result.Run.Metadata, "workspace_policy_hash"); got != want.Hash {
		t.Fatalf("run workspace_policy_hash = %q, want %q", got, want.Hash)
	}
	status, err := service.TriageStatus(context.Background(), 0)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if status.WorkspacePolicy != want {
		t.Fatalf("triage workspace policy = %#v, want %#v", status.WorkspacePolicy, want)
	}
	serviceStatus := service.Status()
	if serviceStatus.Slack.WorkspacePolicy != want {
		t.Fatalf("status workspace policy = %#v, want %#v", serviceStatus.Slack.WorkspacePolicy, want)
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
	if len(status.AuditFixtures) != 11 {
		t.Fatalf("fixtures = %#v, want parse controls plus memory-backed canaries", status.AuditFixtures)
	}
	if !status.EpisodeRecall.Ready || status.EpisodeRecall.Canary.Passed != status.EpisodeRecall.Canary.Total {
		t.Fatalf("episode recall = %#v, want passing status canary", status.EpisodeRecall)
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
	if byName["synthesis_link_reply"].Outcome != "ACT" || byName["synthesis_link_reply"].Actions != 1 || byName["synthesis_link_reply"].Mutations != 1 {
		t.Fatalf("link synthesis fixture = %#v", byName["synthesis_link_reply"])
	}
	if byName["skip_no_action"].Outcome != "SKIP" || byName["skip_no_action"].Actions != 0 || byName["skip_no_action"].SuppressedReason != "no_actions" {
		t.Fatalf("SKIP fixture = %#v", byName["skip_no_action"])
	}
	for _, name := range []string{"skip_malformed_no_action_unescaped_cjk_quotes", "skip_no_action_cjk_punctuation"} {
		fixture := byName[name]
		if fixture.Outcome != "SKIP" || fixture.Actions != 0 || fixture.SuppressedReason != "no_actions" {
			t.Fatalf("parse fallback fixture %s = %#v, want safe SKIP", name, fixture)
		}
	}
	for _, name := range []string{
		"aha_unanswered_question_with_recent_memory",
		"delayed_no_reply_uses_memory_before_reply",
		"backfill_review_ready_requires_memory_or_agent_read",
		"weak_memory_hit_stays_needs_context",
		"person_project_memory_cites_source",
	} {
		fixture, ok := byName[name]
		if !ok {
			t.Fatalf("missing memory-backed canary %q in %#v", name, status.AuditFixtures)
		}
		if fixture.Category != "memory_backed_triage" || !fixture.Pass {
			t.Fatalf("memory-backed canary %s = %#v, want passing category", name, fixture)
		}
	}
	if byName["aha_unanswered_question_with_recent_memory"].Expected != "prompt_cites_related_memory" || len(byName["aha_unanswered_question_with_recent_memory"].Evidence) == 0 {
		t.Fatalf("Aha memory canary = %#v", byName["aha_unanswered_question_with_recent_memory"])
	}
	if byName["weak_memory_hit_stays_needs_context"].Outcome != BackfillReviewNeedsContext {
		t.Fatalf("weak memory canary = %#v", byName["weak_memory_hit_stays_needs_context"])
	}
	if byName["person_project_memory_cites_source"].Outcome != BackfillReviewReady || len(byName["person_project_memory_cites_source"].Evidence) == 0 {
		t.Fatalf("person/project memory canary = %#v", byName["person_project_memory_cites_source"])
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
				"input_context_chars":                   120,
				"context_budget_total_chars":            1000,
				"context_budget_total_tokens":           250,
				"context_budget_stable_tokens":          100,
				"context_budget_dynamic_tokens":         30,
				"context_budget_worker_result_tokens":   0,
				"context_budget_memory_evidence_tokens": 20,
				"channel_context_fetched":               true,
				"thread_context_fetched":                false,
				"external_links_fetched":                1,
				"suppressed_reason":                     "no_actions",
				"channel_context_messages":              3,
			},
		},
		{
			Timestamp: now.Add(-4 * time.Hour).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "maybe follow-up",
			Channels:  []string{"C123"},
			Actions:   []SlackTriageAction{{Tool: "suggest_action", Channel: "C123", Brief: "needs owner"}},
			Metadata: map[string]any{
				"input_context_chars":                   300,
				"context_budget_total_chars":            2000,
				"context_budget_total_tokens":           500,
				"context_budget_stable_tokens":          100,
				"context_budget_dynamic_tokens":         40,
				"context_budget_worker_result_tokens":   12,
				"context_budget_memory_evidence_tokens": 60,
				"thread_context_fetched":                true,
				"external_links_fetched":                0,
				"thread_context_messages":               4,
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
				"input_context_chars":                   500,
				"context_budget_total_chars":            3000,
				"context_budget_total_tokens":           750,
				"context_budget_stable_tokens":          100,
				"context_budget_dynamic_tokens":         20,
				"context_budget_worker_result_tokens":   0,
				"context_budget_memory_evidence_tokens": 30,
				"thread_context_fetched":                true,
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
	if report.ContextBudget.Count != 3 ||
		report.ContextBudget.MedianTotalChars != 2000 ||
		report.ContextBudget.MaxTotalChars != 3000 ||
		report.ContextBudget.MaxTotalTokens != 750 ||
		report.ContextBudget.MaxWorkerResultTokens != 12 ||
		report.ContextBudget.MaxMemoryEvidenceTokens != 60 {
		t.Fatalf("contextBudget = %#v", report.ContextBudget)
	}
	if report.Harness.PIStablePromptHash == "" ||
		report.Harness.RunsWithContextBudget != 3 ||
		report.Harness.MaxContextBudgetTokens != 750 ||
		report.Harness.MaxWorkerResultTokens != 12 ||
		report.Harness.MaxMemoryEvidenceTokens != 60 {
		t.Fatalf("harness = %#v", report.Harness)
	}
	if report.ContextFetch.ChannelContextFetched != 1 || report.ContextFetch.ThreadContextFetched != 2 || report.ContextFetch.ExternalLinksFetched != 1 {
		t.Fatalf("contextFetch = %#v", report.ContextFetch)
	}
	if report.ContextFetch.Reasons["channel_low_context_expansion"] != 1 || report.ContextFetch.Reasons["thread_context_fetched"] != 2 {
		t.Fatalf("context fetch reasons = %#v", report.ContextFetch.Reasons)
	}
	if report.SkipReasons["no_action_other"] != 1 {
		t.Fatalf("skip reasons = %#v, want no_action_other bucket", report.SkipReasons)
	}
	if len(report.RecentRuns) == 0 || report.RecentRuns[0].ContextFetchReason == "" || report.RecentRuns[0].SkipReasonBucket == "" {
		t.Fatalf("recentRuns = %#v, want context reason and skip bucket", report.RecentRuns)
	}
	if report.RecentRuns[0].ContextBudgetTokens == 0 || report.RecentRuns[0].DynamicContextTokens == 0 {
		t.Fatalf("recentRuns = %#v, want context budget brief fields", report.RecentRuns)
	}
	if report.Canary.Total != 11 || report.Canary.Passed != 11 || report.Canary.NeedsLiveSample {
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

func TestTriageAuditClassifiesSkipReasonBuckets(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 17, 46, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	for _, run := range []SlackTriageContext{
		{Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "目标 bot 已处理并正在修复，无需助手介入。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-2 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "用户补一条点赞转发个人操作备忘。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-3 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "纯技术开发实现进度，无需办公助手介入。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-4 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "与上一次 triage 结论一致，重复 followup。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-5 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "用户继续追问 cueboard PR #1915 进度，bot internal issue 后尚未恢复。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-6 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "团队成员同步日程：一人请假、一人赶飞机。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-7 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "用户分享 bridge.surf 链接，属于技术内容。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-8 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "单条 file_share 截图，上下文不足无法判断。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
		{Timestamp: now.Add(-9 * time.Minute).Format(time.RFC3339Nano), Status: "ok", Summary: "工具行为观察/报备，无协调需求。", Metadata: map[string]any{"suppressed_reason": "no_actions"}},
	} {
		if _, err := service.triage.RecordRun(context.Background(), run); err != nil {
			t.Fatalf("RecordRun: %v", err)
		}
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	for _, want := range []string{
		"handled_by_other_bot",
		"personal_note",
		"pure_dev_progress",
		"duplicate_or_followup",
		"dev_bot_stuck_or_handoff",
		"schedule_note",
		"link_share",
		"low_signal_file_share",
		"observation_only",
	} {
		if report.SkipReasons[want] != 1 {
			t.Fatalf("skipReasons = %#v, want one %s", report.SkipReasons, want)
		}
	}
	if !hasAuditFlag(report.Flags, "dev_bot_stuck_or_handoff") {
		t.Fatalf("flags = %#v, want stuck/handoff signal", report.Flags)
	}
}
