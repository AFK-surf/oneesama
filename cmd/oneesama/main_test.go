package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunSlackAgentValidateModeSucceeds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("expected validate mode to probe /health, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()
	setValidateEnv(t, server.URL)
	t.Setenv("SLACK_BOT_TOKEN", "xoxb-test")
	t.Setenv("SLACK_APP_TOKEN", "xapp-test")

	var stderr bytes.Buffer
	if code := run([]string{"slack-agent", "--validate"}, &stderr); code != 0 {
		t.Fatalf("expected validate mode to succeed, code=%d stderr=%s", code, stderr.String())
	}
	if value := os.Getenv("SLACK_BOT_TOKEN"); value != "" {
		t.Fatalf("expected SLACK_BOT_TOKEN to be scrubbed, got %q", value)
	}
}

func TestRunSlackAgentValidateModeFailsMissingToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	setValidateEnv(t, server.URL)

	var stderr bytes.Buffer
	if code := run([]string{"slack-agent", "--validate"}, &stderr); code != 1 {
		t.Fatalf("expected validate mode to fail, code=%d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "slack bot token is required") {
		t.Fatalf("expected missing token error, got %s", stderr.String())
	}
}

func setValidateEnv(t *testing.T, meetingURL string) {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ONEESAMA_CONFIG_PATH", configPath)
	t.Setenv("ONEESAMA_MEETING_LISTEN", meetingURL)
	t.Setenv("ONEESAMA_SLACK_LISTEN", "127.0.0.1:0")
	t.Setenv("ONEESAMA_AGENT_RUNNER", "dry-run")
	t.Setenv("ONEESAMA_DRY_RUN_AGENT", "1")
	t.Setenv("ONEESAMA_LOG_FORMAT", "text")
	t.Setenv("SLACK_BOT_TOKEN", "")
	t.Setenv("SLACK_APP_TOKEN", "")
	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "")
	t.Setenv("ONEESAMA_SLACK_APP_TOKEN", "")
	t.Setenv("MAB_SLACK_BOT_TOKEN", "")
	t.Setenv("MAB_SLACK_APP_TOKEN", "")
}
