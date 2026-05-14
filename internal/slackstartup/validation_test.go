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

func TestValidateWebhookListenNormalizesPortOnlyAddress(t *testing.T) {
	if err := ValidateWebhookListen("0"); err != nil {
		t.Fatalf("expected port-only listen probe to pass: %v", err)
	}
}
