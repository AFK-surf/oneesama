package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

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

	for _, tc := range []struct {
		name    string
		errText string
	}{
		{
			name:    "openrouter_eof",
			errText: `call oneesama Pi model: Post "https://openrouter.ai/api/v1/chat/completions": EOF`,
		},
		{
			name:    "malformed_pi_decision_json",
			errText: `decode oneesama Pi decision JSON: unexpected end of JSON input`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failed := SlackTriageContext{
				ID:        1779504725086007,
				Timestamp: now.Add(-8 * time.Minute).Format(time.RFC3339Nano),
				Status:    "failed",
				Channels:  []string{"C0B1F6E7A07"},
				Summary:   "Pi-first foreground triage pending for 1 Slack message(s) in C0B1F6E7A07",
				Error:     tc.errText,
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
						"error":       tc.errText,
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
		})
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
