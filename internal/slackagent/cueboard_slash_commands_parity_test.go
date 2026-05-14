//go:build cueboardparity

package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCueboardParityCollectStatusDashboardChecksMeetHealth(t *testing.T) {
	t.Parallel()

	var paths []string
	meetd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer meetd.Close()

	service := NewService(Config{
		MeetingAgentURL: meetd.URL,
		ConfigFilePath:  "/config/slack-agentd.yaml",
		SecretsFilePath: "/run/config/slack-agentd.env",
	})

	snapshot := service.collectStatusDashboard(context.Background())
	if !snapshot.MeetConfigured {
		t.Fatal("MeetConfigured = false, want true")
	}
	if !snapshot.MeetHealthy {
		t.Fatalf("MeetHealthy = false, want true (error=%q check=%#v)", snapshot.MeetError, snapshot.MeetHealthCheck)
	}
	if snapshot.ConfigFile != "slack-agentd.yaml" {
		t.Fatalf("ConfigFile = %q, want slack-agentd.yaml", snapshot.ConfigFile)
	}
	if snapshot.SecretsFile != "slack-agentd.env" {
		t.Fatalf("SecretsFile = %q, want slack-agentd.env", snapshot.SecretsFile)
	}
	if strings.Join(paths, ",") != "/healthz,/health" {
		t.Fatalf("health probe paths = %q, want /healthz fallback to /health", strings.Join(paths, ","))
	}
}

func TestCueboardParityRenderStatusDashboardIncludesConfigSource(t *testing.T) {
	t.Parallel()

	rendered := renderStatusDashboardText(slackStatusDashboardSnapshot{
		Runtime: StatusResponse{
			Slack:       SlackStatus{PosterMode: "slack-api"},
			AgentRunner: AgentRunnerStatus{Provider: "codex", Ready: true},
		},
		ConfigFile:     "slack-agentd.yaml",
		SecretsFile:    "slack-agentd.env",
		MeetConfigured: true,
		MeetHealthy:    true,
		MeetURL:        "http://meetd:8090",
	})

	if !strings.Contains(rendered, "config `slack-agentd.yaml` + secrets `slack-agentd.env`") {
		t.Fatalf("status dashboard missing config source:\n%s", rendered)
	}
	if !strings.Contains(rendered, "healthy (`http://meetd:8090`)") {
		t.Fatalf("status dashboard missing meet health:\n%s", rendered)
	}
}
