package slackstartup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestValidateMeetdHealthMatchesCueboardProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("expected /health probe, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	if err := ValidateMeetdHealth(context.Background(), server.URL); err != nil {
		t.Fatalf("expected health probe to pass: %v", err)
	}
}

func TestValidateRequiresSlackTokens(t *testing.T) {
	cfg := appconfig.Config{
		SlackAgent:   appconfig.ServiceConfig{Listen: "127.0.0.1:0"},
		MeetingAgent: appconfig.ServiceConfig{Listen: ""},
		AgentRunner:  appconfig.AgentRunnerConfig{Provider: "dry-run", DryRun: true, JobTimeout: time.Minute},
	}
	err := Validate(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "slack bot token is required") {
		t.Fatalf("expected bot token error, got %v", err)
	}
}

func TestValidateRejectsLiveSlackLegacyFallback(t *testing.T) {
	cfg := validSlackStartupConfig()
	cfg.AgentRunner = appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: time.Minute}

	err := Validate(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "foreground_chain=pi_first_live") {
		t.Fatalf("Validate error = %v, want live foreground posture failure", err)
	}
}

func TestValidateAcceptsExplicitLegacySlackOverride(t *testing.T) {
	t.Setenv("ONEESAMA_LIVE_ALLOW_LEGACY_SLACK", "1")
	cfg := validSlackStartupConfig()
	cfg.AgentRunner = appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: time.Minute}

	if err := ValidateLiveTriagePosture(cfg); err != nil {
		t.Fatalf("ValidateLiveTriagePosture should allow explicit legacy slack override, got %v", err)
	}
}

func TestValidateAcceptsPiFirstLiveSlackPosture(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "test-openrouter-key")
	cfg := validSlackStartupConfig()
	cfg.AgentRunner = appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: time.Minute}
	cfg.Slack.Triage = appconfig.SlackTriageConfig{
		ForegroundChain: "pi_first_live",
		WorkspacePolicy: "Reply only with source-backed workspace-aware comments.",
	}
	cfg.PersonaRuntime = appconfig.PersonaRuntimeConfig{
		Provider:   "oneesama-pi",
		Mode:       "live",
		Timeout:    time.Minute,
		ShadowOnly: false,
	}

	if err := ValidateLiveTriagePosture(cfg); err != nil {
		t.Fatalf("ValidateLiveTriagePosture should accept Pi-first live posture, got %v", err)
	}
}

func TestValidateFailsOnFatalBackendAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/llm/models" {
			t.Fatalf("backend probe path = %q, want /v1/llm/models", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer jwt-token" {
			t.Fatalf("Authorization = %q, want Bearer jwt-token", got)
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid token"}`))
	}))
	defer server.Close()

	previousClient := backendProbeHTTPClient
	backendProbeHTTPClient = server.Client()
	t.Cleanup(func() { backendProbeHTTPClient = previousClient })
	t.Setenv("BACKEND_URL", server.URL)
	t.Setenv("API_KEY", "jwt-token")

	cfg := validSlackStartupConfig()
	err := Validate(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "status 401") {
		t.Fatalf("Validate error = %v, want fatal backend auth status", err)
	}
}

func TestValidateIgnoresNonFatalBackendProbeFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`gateway unavailable`))
	}))
	defer server.Close()

	previousClient := backendProbeHTTPClient
	backendProbeHTTPClient = server.Client()
	t.Cleanup(func() { backendProbeHTTPClient = previousClient })
	t.Setenv("BACKEND_URL", server.URL)
	t.Setenv("API_KEY", "jwt-token")

	cfg := validSlackStartupConfig()
	if err := Validate(context.Background(), cfg); err != nil {
		t.Fatalf("Validate should ignore non-fatal backend probe failure, got %v", err)
	}
}

func TestValidateWebhookListenNormalizesPortOnlyAddress(t *testing.T) {
	if err := ValidateWebhookListen("0"); err != nil {
		t.Fatalf("expected port-only listen probe to pass: %v", err)
	}
}

func validSlackStartupConfig() appconfig.Config {
	return appconfig.Config{
		SlackAgent:   appconfig.ServiceConfig{Listen: "127.0.0.1:0"},
		MeetingAgent: appconfig.ServiceConfig{Listen: ""},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-valid-token",
			AppToken: "xapp-valid-token",
		},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "dry-run", DryRun: true, JobTimeout: time.Minute},
	}
}
