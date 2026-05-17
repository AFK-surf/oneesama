package slackagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleAppManifestReturnsExpectedURLs(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
			PublicBaseURL:   "https://oneesama.example.com",
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/app/manifest", nil)
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if strings.Contains(response.Body.String(), `"slash_commands"`) || strings.Contains(response.Body.String(), "/slack/commands/avatar") {
		t.Fatalf("body = %s, want no slash command surface", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"request_url":"https://oneesama.example.com/slack/events"`) {
		t.Fatalf("body = %s, want event request url", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"reaction_added"`) {
		t.Fatalf("body = %s, want reaction_added event for emoji feedback memory", response.Body.String())
	}
}

func TestHandleValidateAppManifestAcceptsGeneratedManifest(t *testing.T) {
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
			PublicBaseURL:   "https://oneesama.example.com",
		},
	})
	manifest := service.BuildManifest()

	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
			PublicBaseURL:   "https://oneesama.example.com",
		},
	})

	payloadBytes, err := json.Marshal(map[string]any{"manifest": manifest})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/app/manifest/validate", strings.NewReader(string(payloadBytes)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("body = %s, want ok=true", response.Body.String())
	}
}
