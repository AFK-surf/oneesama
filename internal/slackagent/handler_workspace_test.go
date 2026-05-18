package slackagent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleWorkspaceBootstrapRequiresInternalAuth(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/workspace/bootstrap", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-For", "127.0.0.1")
	request.RemoteAddr = "203.0.113.10:1234"
	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestHandleWorkspaceBootstrapCreatesTemplates(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: t.TempDir(), InternalAuthKey: "secret-key"},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/workspace/bootstrap", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"template_count":25`) || !strings.Contains(response.Body.String(), `backfill_agent_read_prompt.en.tmpl`) || !strings.Contains(response.Body.String(), `related_memory_evidence.zh.tmpl`) {
		t.Fatalf("body = %s, want created templates", response.Body.String())
	}
}

func TestHandleRuntimeValidateReportsSlackTokenRequirement(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			SigningSecret:   "signing",
			BotToken:        "bot",
			AppToken:        "app",
			InternalAuthKey: "secret-key",
		},
		MeetingAgentURL: "http://127.0.0.1:1",
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/validate", strings.NewReader(`{"require_slack_tokens":true}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"ok":false`) {
		t.Fatalf("body = %s, want ok=false", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"name":"slack_tokens"`) {
		t.Fatalf("body = %s, want slack_tokens check", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"app_token_configured":true`) {
		t.Fatalf("body = %s, want app token configured", response.Body.String())
	}
}
