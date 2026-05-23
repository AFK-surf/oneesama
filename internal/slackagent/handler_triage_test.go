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
	if payload.Status != "would_request_reply_approval" {
		t.Fatalf("status = %q, want would_request_reply_approval", payload.Status)
	}
	if len(payload.DryRun.ActionsBeforeGate) != 1 || len(payload.DryRun.ActionsAfterGate) != 1 {
		t.Fatalf("actions before/after = %d/%d, want 1/1", len(payload.DryRun.ActionsBeforeGate), len(payload.DryRun.ActionsAfterGate))
	}
	if len(payload.DryRun.VisibleReplyVerdicts) != 1 || !payload.DryRun.VisibleReplyVerdicts[0].Allowed {
		t.Fatalf("visible verdicts = %#v, want allowed reply verdict", payload.DryRun.VisibleReplyVerdicts)
	}
	if !stringSliceContains(payload.DryRun.SideEffectsBlocked, "approval_card") || !stringSliceContains(payload.DryRun.SideEffectsBlocked, "slack_post") {
		t.Fatalf("side effects = %#v, want approval_card + slack_post blocked", payload.DryRun.SideEffectsBlocked)
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

func TestTriageAuditSplitsRealAndProbeOutcomes(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 23, 47, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	runs := []SlackTriageContext{
		{
			Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "real user direct reply",
			Mutations: 1,
			Metadata:  map[string]any{"suppressed_reason": "posted"},
		},
		{
			Timestamp: now.Add(-2 * time.Minute).Format(time.RFC3339Nano),
			Status:    "failed",
			Summary:   "early live positive probe failed",
			Error:     "provider temporarily failed",
			Metadata: map[string]any{
				"live_positive_probe": true,
				"probe_kind":          "maybe_follow_up",
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
	if report.Outcome.FailedRuns != 1 || report.Outcome.OutboundRuns != 1 {
		t.Fatalf("outcome = %#v, want aggregate failure plus real outbound", report.Outcome)
	}
	if report.RealOutcome.FailedRuns != 0 || report.RealOutcome.OutboundRuns != 1 {
		t.Fatalf("realOutcome = %#v, want real outbound without probe failure", report.RealOutcome)
	}
	if report.ProbeOutcome.FailedRuns != 1 || report.ProbeOutcome.OutboundRuns != 0 {
		t.Fatalf("probeOutcome = %#v, want probe failure isolated", report.ProbeOutcome)
	}
	if !hasAuditFlag(report.Flags, "probe_outcome_failures") {
		t.Fatalf("flags = %#v, want probe failure warning", report.Flags)
	}
	if len(report.FailureSamples) != 1 || !report.FailureSamples[0].Probe || report.FailureSamples[0].Error == "" {
		t.Fatalf("failureSamples = %#v, want probe failure sample", report.FailureSamples)
	}
}

func TestTriageAuditFlagsRealOutcomeFailures(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 18, 11, 47, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	for _, run := range []SlackTriageContext{
		{
			Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano),
			Status:    "failed",
			Summary:   "Triage failed: provider env missing\nvery long debug omitted",
			Error:     "Missing environment variable: CLOUDFLARE_API_TOKEN",
			Channels:  []string{"C123"},
		},
		{
			Timestamp: now.Add(-2 * time.Minute).Format(time.RFC3339Nano),
			Status:    "failed",
			Summary:   "probe failed too",
			Error:     "probe provider failed",
			Channels:  []string{"C_TRIAGE_PROBE"},
			Metadata:  map[string]any{"live_positive_probe": true},
		},
	} {
		if _, err := service.triage.RecordRun(context.Background(), run); err != nil {
			t.Fatalf("RecordRun: %v", err)
		}
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.RealOutcome.FailedRuns != 1 || report.ProbeOutcome.FailedRuns != 1 {
		t.Fatalf("real/probe outcome = %#v / %#v, want one failure each", report.RealOutcome, report.ProbeOutcome)
	}
	if !hasAuditFlagLevel(report.Flags, "real_outcome_failures", "red") {
		t.Fatalf("flags = %#v, want red real failure flag", report.Flags)
	}
	if !hasAuditFlagLevel(report.Flags, "probe_outcome_failures", "yellow") {
		t.Fatalf("flags = %#v, want yellow probe failure flag", report.Flags)
	}
	if len(report.FailureSamples) != 2 || report.FailureSamples[0].Probe == report.FailureSamples[1].Probe {
		t.Fatalf("failureSamples = %#v, want one real sample and one probe sample", report.FailureSamples)
	}
	realSample := report.FailureSamples[0]
	if realSample.Probe {
		realSample = report.FailureSamples[1]
	}
	if strings.Contains(realSample.Summary, "\n") || !strings.Contains(realSample.Error, "CLOUDFLARE_API_TOKEN") {
		t.Fatalf("failureSamples = %#v, want sanitized single-line sample", report.FailureSamples)
	}
}

func TestTriageAuditDowngradesRetryScheduledRealFailures(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 19, 2, 41, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{},
	})
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Status:    "failed",
		Summary:   "Triage failed: empty final response with no mutations",
		Error:     "empty final response with no mutations",
		Channels:  []string{"C123"},
		Failures:  1,
		Metadata: map[string]any{
			"triage_empty_final_needs_retry": true,
		},
	}); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.RealOutcome.FailedRuns != 1 || report.RealOutcome.RetryScheduledFailures != 1 {
		t.Fatalf("realOutcome = %#v, want one retry-scheduled failure", report.RealOutcome)
	}
	if hasAuditFlagLevel(report.Flags, "real_outcome_failures", "red") {
		t.Fatalf("flags = %#v, want no red for retry-scheduled failure", report.Flags)
	}
	if !hasAuditFlagLevel(report.Flags, "real_outcome_failures_retry_scheduled", "yellow") {
		t.Fatalf("flags = %#v, want yellow handled retry flag", report.Flags)
	}
}

func TestTriageAuditDowngradesStaleSampleWhenScannerAndSocketHealthy(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 18, 11, 47, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{AppToken: "xapp-test"},
	})
	for i := 0; i < 11; i++ {
		service.recordSlackScannerSweep(now.Add(-time.Duration(i+1) * time.Minute))
	}
	runner := NewSocketModeRunner(SocketModeRunnerConfig{Service: service, AppToken: "xapp-test"})
	runner.stateMu.Lock()
	runner.state.Connected = true
	runner.state.LastConnectedAt = now.Add(-time.Hour).Format(time.RFC3339Nano)
	runner.stateMu.Unlock()
	service.socketModeMu.Lock()
	service.socketMode = runner
	service.socketModeMu.Unlock()
	if _, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		Timestamp: now.Add(-3 * time.Hour).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "quiet skip",
		Metadata:  map[string]any{"input_context_chars": 400, "suppressed_reason": "no_actions"},
	}); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if hasAuditFlag(report.Flags, "stale_sample") || !hasAuditFlagLevel(report.Flags, "quiet_window", "info") {
		t.Fatalf("flags = %#v, want info quiet_window instead of stale_sample", report.Flags)
	}
}

func TestHandleTriageProbeRecordsLivePositiveWithoutSideEffects(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_probe_1",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"probe follow-up recognized","actions":[{"type":"follow_up","title":"Probe follow-up","message":"Verify recall path","confidence":0.91,"requiresConfirmation":true}]}`,
	}}
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				PostActions: true,
			},
		},
		Runner: runner,
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/triage/probe", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"probe":true`) || strings.Contains(response.Body.String(), `"pendingActions"`) {
		t.Fatalf("body = %s, want probe without pending action side effects", response.Body.String())
	}
	if runner.startInput.Context["triageProbe"] != true {
		t.Fatalf("runner context = %#v, want triage probe flag", runner.startInput.Context)
	}

	auditResponse := httptest.NewRecorder()
	auditRequest := httptest.NewRequest(http.MethodGet, "/slack/triage/audit?window=6h", nil)
	auditRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(auditResponse, auditRequest)
	if auditResponse.Code != http.StatusOK {
		t.Fatalf("audit status = %d, want 200: %s", auditResponse.Code, auditResponse.Body.String())
	}
	var payload struct {
		OK    bool                   `json:"ok"`
		Audit SlackTriageAuditReport `json:"audit"`
	}
	if err := json.Unmarshal(auditResponse.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode audit: %v", err)
	}
	if payload.Audit.LiveProbe.Total != 1 || payload.Audit.LiveProbe.Passed != 1 || payload.Audit.LiveProbe.LatestOutcome != "MAYBE" {
		t.Fatalf("liveProbe = %#v, want one passing MAYBE probe", payload.Audit.LiveProbe)
	}
	if payload.Audit.Canary.NeedsLiveSample || hasAuditFlag(payload.Audit.Flags, "no_live_positive_samples") {
		t.Fatalf("audit = %#v, probe should satisfy live positive sample", payload.Audit)
	}
}

func TestTriageAuditIncludesProcessHealthSignals(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 17, 11, 46, 29, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{AppToken: "xapp-test"},
	})
	service.recordSlackScannerSweep(now.Add(-7 * time.Hour))
	service.recordSlackScannerSweep(now.Add(-30 * time.Minute))
	service.recordSlackScannerRateLimit(now.Add(-8 * time.Hour))
	service.recordSlackScannerRateLimit(now.Add(-time.Hour))

	runner := NewSocketModeRunner(SocketModeRunnerConfig{Service: service, AppToken: "xapp-test"})
	runner.stateMu.Lock()
	runner.state.Connected = true
	runner.state.Reconnects = 2
	runner.state.LastConnectedAt = now.Add(-20 * time.Minute).Format(time.RFC3339Nano)
	runner.state.LastClosedAt = now.Add(-15 * time.Minute).Format(time.RFC3339Nano)
	runner.state.LastEventAt = now.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	runner.reconnectHistory = []time.Time{now.Add(-7 * time.Hour), now.Add(-15 * time.Minute)}
	runner.stateMu.Unlock()
	service.socketModeMu.Lock()
	service.socketMode = runner
	service.socketModeMu.Unlock()

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	health := report.ProcessHealth
	if health.PID == 0 || health.UptimeSeconds != 0 {
		t.Fatalf("processHealth = %#v, want pid and deterministic zero uptime", health)
	}
	if health.ScannerSweepsLastWindow != 1 {
		t.Fatalf("scanner sweeps = %d, want 1", health.ScannerSweepsLastWindow)
	}
	if health.ScannerRateLimitsLastWindow != 1 || health.HTTP429LastWindow != 1 {
		t.Fatalf("rate limits = %#v, want one 429-style rate limit in window", health)
	}
	if !health.SocketConnected || health.SocketReconnectsTotal != 2 || health.SocketReconnectsLastWindow != 1 {
		t.Fatalf("socket health = %#v, want connected with one reconnect in window", health)
	}
	if health.SocketLastConnectedAt == "" || health.SocketLastClosedAt == "" || health.SocketLastEventAt == "" {
		t.Fatalf("socket health = %#v, want socket timestamps", health)
	}
}

func TestTriageAuditProcessHealthReportsCodexProviderEnvPresence(t *testing.T) {
	t.Setenv("ONEESAMA_TEST_CODEX_PROVIDER_TOKEN", "token")
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			Codex: appconfig.CodexRunnerConfig{
				ModelProvider: "cf_openrouter",
				BaseURL:       "https://gateway.example.test/openrouter",
				EnvKey:        "ONEESAMA_TEST_CODEX_PROVIDER_TOKEN",
			},
		},
	})
	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.ProcessHealth.CodexRequiredEnvKey != "ONEESAMA_TEST_CODEX_PROVIDER_TOKEN" || !report.ProcessHealth.CodexRequiredEnvPresent {
		t.Fatalf("processHealth = %#v, want codex env presence", report.ProcessHealth)
	}
}

func TestTriageAuditFlagsMissingCodexProviderEnv(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			Codex: appconfig.CodexRunnerConfig{
				ModelProvider: "cf_openrouter",
				BaseURL:       "https://gateway.example.test/openrouter",
				EnvKey:        "ONEESAMA_TEST_MISSING_AUDIT_CODEX_TOKEN",
			},
		},
	})
	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.ProcessHealth.CodexRequiredEnvKey != "ONEESAMA_TEST_MISSING_AUDIT_CODEX_TOKEN" || report.ProcessHealth.CodexRequiredEnvPresent {
		t.Fatalf("processHealth = %#v, want missing codex env", report.ProcessHealth)
	}
	if !hasAuditFlagLevel(report.Flags, "codex_provider_env_missing", "red") {
		t.Fatalf("flags = %#v, want red codex env flag", report.Flags)
	}
}

func TestTriageAuditReportsLivePersonaRuntimeHealth(t *testing.T) {
	now := time.Date(2026, 5, 18, 22, 55, 0, 0, time.UTC)
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider:   persona.ProviderFake,
			Mode:       persona.ModeLive,
			ShadowOnly: false,
		},
	})
	service.personaRuntime = statusOnlyPersonaRuntime{status: persona.Status{
		Provider:      persona.ProviderPi,
		Mode:          persona.ModeLive,
		Ready:         true,
		Healthy:       true,
		ShadowOnly:    false,
		Version:       "persona-sidecar-live-v1",
		LastRequestAt: now.Format(time.RFC3339Nano),
		LastLatencyMS: 321,
	}}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 0)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	runtime := report.PersonaRuntime
	if !runtime.Configured || !runtime.ForegroundEnabled || runtime.Provider != persona.ProviderPi || runtime.Mode != persona.ModeLive {
		t.Fatalf("persona runtime = %#v, want live pi foreground", runtime)
	}
	if !runtime.Ready || !runtime.Healthy || runtime.ShadowOnly || runtime.Version != "persona-sidecar-live-v1" || runtime.LastLatencyMS != 321 {
		t.Fatalf("persona runtime = %#v, want healthy live status", runtime)
	}
	if hasAuditFlag(report.Flags, "persona_runtime_unhealthy") || hasAuditFlag(report.Flags, "persona_runtime_not_live") {
		t.Fatalf("flags = %#v, healthy live runtime should not flag", report.Flags)
	}
}

func TestTriageAuditFlagsPersonaRuntimeHealthFailures(t *testing.T) {
	report := SlackTriageAuditReport{
		PersonaRuntime: SlackTriagePersonaRuntime{
			ForegroundEnabled: true,
			Provider:          persona.ProviderPi,
			Mode:              persona.ModeLive,
			Ready:             false,
			Healthy:           false,
			LastError:         "sidecar refused connection",
		},
		PersonaQuality: SlackTriagePersonaQuality{
			Failures:            1,
			ShadowOnlyResponses: 1,
		},
	}
	flags := buildSlackTriageAuditFlags(report)
	for _, code := range []string{"persona_runtime_unhealthy", "persona_foreground_failures", "persona_foreground_shadow_only"} {
		if !hasAuditFlagLevel(flags, code, "red") {
			t.Fatalf("flags = %#v, want red %s", flags, code)
		}
	}
	if hasAuditFlag(flags, "persona_runtime_not_live") {
		t.Fatalf("flags = %#v, mode is live so not_live should not fire", flags)
	}
}

func TestTriageAuditSummarizesPersonaForegroundQuality(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 18, 22, 58, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	report := buildSlackTriageAuditReport([]SlackTriageContext{
		{
			ID:        10,
			Timestamp: now.Add(-3 * time.Minute).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "persona queued",
			Metadata:  map[string]any{"persona_foreground_queued": true},
		},
		{
			ID:        11,
			Timestamp: now.Add(-2 * time.Minute).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "persona replied",
			Mutations: 1,
			Metadata: map[string]any{
				"persona_foreground": map[string]any{
					"success":         true,
					"decision":        persona.DecisionReply,
					"visible_text":    "Pi foreground live ok.",
					"worker_requests": []any{"agent_read: inspect source"},
					"memory_writes":   []any{"episode: Peng prefers Pi memory"},
					"shadow_only":     false,
					"latency_ms":      int64(1200),
				},
			},
		},
		{
			ID:        12,
			Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano),
			Status:    "failed",
			Summary:   "persona failed",
			Error:     "persona foreground failed: status code: 401 Authentication Fails",
			Metadata: map[string]any{
				"persona_foreground": map[string]any{
					"success":     false,
					"decision":    persona.DecisionStaySilent,
					"error":       "status code: 401 Authentication Fails",
					"shadow_only": true,
					"latency_ms":  int64(90000),
				},
			},
		},
		{
			ID:        13,
			Timestamp: now.Add(-4 * time.Minute).Format(time.RFC3339Nano),
			Status:    "ok",
			Summary:   "persona shadow-only response in live mode",
			Metadata: map[string]any{
				"persona_foreground": map[string]any{
					"success":     true,
					"decision":    persona.DecisionStaySilent,
					"shadow_only": true,
				},
			},
		},
	}, 6*time.Hour)
	quality := report.PersonaQuality
	if quality.ForegroundRuns != 3 || quality.ForegroundQueuedRuns != 1 || quality.Successes != 2 || quality.Replies != 1 || quality.Failures != 1 || quality.ShadowOnlyResponses != 1 || quality.WorkerRequests != 1 || quality.MemoryWriteIntents != 1 {
		t.Fatalf("persona quality = %#v, want queued/success/reply/failure summary", quality)
	}
	if quality.ForegroundStaleQueuedRuns != 1 || quality.OldestQueuedRunID != 10 || quality.OldestQueuedAgeSeconds < int64((2*time.Minute).Seconds()) {
		t.Fatalf("persona quality queued = %#v, want stale queued run details", quality)
	}
	if quality.AuthFailures != 1 || quality.LatestAuthFailureRunID != 12 || !strings.Contains(quality.LatestAuthFailureError, "401") {
		t.Fatalf("persona quality auth = %#v, want latest auth failure details", quality)
	}
	if quality.LatestRunID != 12 || quality.LatestDecision != persona.DecisionStaySilent || quality.LatestError != "status code: 401 Authentication Fails" || quality.LatestLatencyMS != 90000 {
		t.Fatalf("persona quality latest = %#v, want latest failed run details", quality)
	}

	report.PersonaRuntime = SlackTriagePersonaRuntime{ForegroundEnabled: true, Provider: persona.ProviderPi, Mode: persona.ModeLive, Ready: true, Healthy: true}
	report.Flags = buildSlackTriageAuditFlags(report)
	if !hasAuditFlagLevel(report.Flags, "persona_foreground_failures", "red") ||
		!hasAuditFlagLevel(report.Flags, "persona_foreground_auth_failures", "red") ||
		!hasAuditFlagLevel(report.Flags, "persona_foreground_stuck_queued", "red") ||
		!hasAuditFlagLevel(report.Flags, "persona_foreground_shadow_only", "red") {
		t.Fatalf("flags = %#v, want persona foreground quality red flags", report.Flags)
	}
}

func TestTriageAuditDemotesRecoveredProviderFailure(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 23, 11, 5, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	errText := `call oneesama Pi model: Post "https://openrouter.ai/api/v1/chat/completions": EOF`
	failed := SlackTriageContext{
		ID:        1779504725086007,
		Timestamp: now.Add(-8 * time.Minute).Format(time.RFC3339Nano),
		Status:    "failed",
		Channels:  []string{"C0B1F6E7A07"},
		Summary:   "Pi-first foreground triage pending for 1 Slack message(s) in C0B1F6E7A07",
		Error:     errText,
		Failures:  1,
		Metadata: map[string]any{
			"channel_id": "C0B1F6E7A07",
			"thread_ts":  "1779504417.305049",
			"persona_foreground": map[string]any{
				"channel_id":  "C0B1F6E7A07",
				"thread_ts":   "1779504417.305049",
				"source":      "triage",
				"success":     false,
				"shadow_only": true,
				"error":       errText,
			},
		},
	}
	recovered := SlackTriageContext{
		ID:        1779504981042008,
		Timestamp: now.Add(-4 * time.Minute).Format(time.RFC3339Nano),
		Status:    "ok",
		Channels:  []string{"C0B1F6E7A07"},
		Summary:   "The request was already fully handled by Oneesama in the thread.",
		Metadata: map[string]any{
			"channel_id": "C0B1F6E7A07",
			"thread_ts":  "1779504417.305049",
			"persona_foreground": map[string]any{
				"channel_id": "C0B1F6E7A07",
				"thread_ts":  "1779504417.305049",
				"source":     "triage",
				"success":    true,
				"decision":   persona.DecisionStaySilent,
				"reason":     "The request was already fully handled by Oneesama in the thread.",
			},
		},
	}

	report := buildSlackTriageAuditReport([]SlackTriageContext{failed, recovered}, 2*time.Hour)
	if report.InfoBuckets.RecoveredProviderFailureCount != 1 {
		t.Fatalf("RecoveredProviderFailureCount = %d, want 1", report.InfoBuckets.RecoveredProviderFailureCount)
	}
	if len(report.InfoBuckets.RecoveredProviderFailureSamples) != 1 {
		t.Fatalf("RecoveredProviderFailureSamples = %#v, want one sample", report.InfoBuckets.RecoveredProviderFailureSamples)
	}
	sample := report.InfoBuckets.RecoveredProviderFailureSamples[0]
	if sample.RunID != failed.ID || sample.RecoveredByRunID != recovered.ID || sample.ThreadTS != "1779504417.305049" {
		t.Fatalf("RecoveredProviderFailure sample = %#v, want failed->recovered same thread", sample)
	}
	if report.PersonaQuality.Failures != 0 || report.PersonaQuality.RecoveredProviderFailures != 1 {
		t.Fatalf("PersonaQuality = %#v, want recovered provider failure not red failure", report.PersonaQuality)
	}
	if len(report.FailureSamples) != 0 {
		t.Fatalf("FailureSamples = %#v, want recovered provider failure hidden from red samples", report.FailureSamples)
	}
	if hasAuditFlag(report.Flags, "real_outcome_failures") {
		t.Fatalf("flags = %#v, recovered provider failure should not flag real_outcome_failures", report.Flags)
	}
	report.PersonaRuntime = SlackTriagePersonaRuntime{ForegroundEnabled: true, Provider: persona.ProviderPi, Mode: persona.ModeLive, Ready: true, Healthy: true}
	report.Flags = buildSlackTriageAuditFlags(report)
	if hasAuditFlag(report.Flags, "persona_foreground_failures") {
		t.Fatalf("flags = %#v, recovered provider failure should not flag persona foreground failures", report.Flags)
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
	if !payload.OK || payload.Audit.RunCount != 0 || payload.Audit.Canary.Total != 11 || !payload.Audit.EpisodeRecall.Ready || !hasAuditFlag(payload.Audit.Flags, "no_recent_runs") {
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

func hasAuditFlagLevel(flags []SlackTriageAuditFlag, code string, level string) bool {
	for _, flag := range flags {
		if flag.Code == code && flag.Level == level {
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

func TestChannelBrainSkipsNoActionPolicyRationales(t *testing.T) {
	summary := buildChannelBrainSummary([]SlackThreadLedgerRecord{
		{
			ThreadTS:         "111.222",
			Status:           "active",
			LastActionType:   "triage",
			LastActionStatus: "no_action",
			Summary:          "Railway GCP 账户被封锁的云平台运维公告，非 workspace policy 覆盖的 AI agent/coding tool/lab 话题。纯链接分享无评论，不触发回复。",
			UpdatedAt:        "2026-05-20T01:00:00Z",
		},
		{
			ThreadTS:         "333.444",
			Status:           "active",
			LastActionType:   "triage",
			LastActionStatus: "confirmed",
			Summary:          "Decision: product-adjacent link replies should cite workspace memory.",
			UpdatedAt:        "2026-05-20T01:01:00Z",
		},
	})
	if strings.Contains(summary, "Railway") || strings.Contains(summary, "不触发回复") || strings.Contains(summary, "纯链接") {
		t.Fatalf("summary retained no-action rationale:\n%s", summary)
	}
	if !strings.Contains(summary, "product-adjacent link replies") {
		t.Fatalf("summary missing durable decision:\n%s", summary)
	}
}

func TestChannelBrainSanitizesStoredNoActionRationaleLines(t *testing.T) {
	raw := strings.Join([]string{
		"Shared facts and conventions:",
		"- Railway GCP 账户被封锁的云平台运维公告，非 workspace policy 覆盖。纯链接分享无评论，不触发回复。",
		"- Decision: product-adjacent link replies should cite workspace memory.",
		"",
		"Shared open loops:",
		"- Durov link 非 workspace policy，纯链接分享无评论，不触发回复。",
	}, "\n")
	summary := sanitizeChannelBrainSummary(raw)
	if strings.Contains(summary, "Railway") || strings.Contains(summary, "Durov") || strings.Contains(summary, "不触发回复") {
		t.Fatalf("summary retained stale no-action rationale:\n%s", summary)
	}
	if !strings.Contains(summary, "product-adjacent link replies") {
		t.Fatalf("summary missing valid content:\n%s", summary)
	}
}

func TestChannelBrainSanitizesCannedSecretaryRoutingText(t *testing.T) {
	raw := strings.Join([]string{
		"Shared open loops:",
		"- [thread 1779381024.001839] updated=2026-05-21T16:31:44Z 这看起来是具体项目代码/环境问题，我先不直接下场查 repo。更适合走项目 owner 处理；我可以帮忙把现象、链接和影响面整理成 brief，或者在你明确授权我查 Oneesama 自身/指定代码时再派 worker。",
		"",
		"Shared facts and conventions:",
		"- Decision: product-adjacent link replies should cite workspace memory.",
	}, "\n")
	summary := sanitizeChannelBrainSummary(raw)
	if strings.Contains(summary, "不直接下场查 repo") || strings.Contains(summary, "project owner") || strings.Contains(summary, "整理成 brief") {
		t.Fatalf("summary retained canned secretary routing text:\n%s", summary)
	}
	if !strings.Contains(summary, "product-adjacent link replies") {
		t.Fatalf("summary missing valid content:\n%s", summary)
	}
}

func TestChannelBrainSanitizesEmptySectionsAndInternalPending(t *testing.T) {
	raw := strings.Join([]string{
		"Shared open loops:",
		"- [thread 1779205377.367449] updated=2026-05-19T15:51:31Z Pi-first foreground triage pending for 1 Slack message(s) in C09L0TAN31T",
		"",
		"Shared facts and conventions:",
		"- Durov X 帖子链接，非 workspace policy 覆盖。纯链接分享无评论，不触发回复。",
	}, "\n")
	summary := sanitizeChannelBrainSummary(raw)
	if summary != "" {
		t.Fatalf("expected fully stale channel brain to sanitize empty, got:\n%s", summary)
	}
}
