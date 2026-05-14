package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleListInstallationsReturnsMaskedSummaries(t *testing.T) {
	stateDir := t.TempDir()
	seedSlackInstallationStore(t, stateDir, SlackInstallation{
		InstallationID:        "team:T123",
		TeamID:                "T123",
		TeamName:              "Team Onee",
		BotAccessToken:        "xoxb-1234567890",
		AuthedUserAccessToken: "xoxp-abcdef7890",
		InstalledAt:           "2026-05-13T00:00:00Z",
		UpdatedAt:             "2026-05-13T00:00:00Z",
	})

	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{
			Provider: "json-file",
			DataDir:  stateDir,
		},
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/installations", nil)
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"installation_id":"team:T123"`) {
		t.Fatalf("body = %s, want installation id", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"bot_access_token":"...7890"`) {
		t.Fatalf("body = %s, want masked bot token suffix", response.Body.String())
	}
	if strings.Contains(response.Body.String(), `xoxb-1234567890`) {
		t.Fatalf("body leaked full bot token: %s", response.Body.String())
	}
}

func TestHandleResolveInstallationUsesTeamLookup(t *testing.T) {
	stateDir := t.TempDir()
	seedSlackInstallationStore(t, stateDir, SlackInstallation{
		InstallationID: "team:T999",
		TeamID:         "T999",
		TeamName:       "Routing Team",
		BotAccessToken: "xoxb-routing9999",
		InstalledAt:    "2026-05-13T00:00:00Z",
		UpdatedAt:      "2026-05-13T00:00:00Z",
	})

	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{
			Provider: "json-file",
			DataDir:  stateDir,
		},
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/installations/resolve?team_id=T999", nil)
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"found":true`) {
		t.Fatalf("body = %s, want found=true", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"matched_by":"team_id"`) {
		t.Fatalf("body = %s, want team_id match", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"installation_id":"team:T999"`) {
		t.Fatalf("body = %s, want resolved installation id", response.Body.String())
	}
}

func seedSlackInstallationStore(t *testing.T, dataDir string, record SlackInstallation) {
	t.Helper()
	store, err := persistence.OpenTyped[SlackInstallation](persistence.Options{
		Provider:   persistence.ProviderJSONFile,
		Collection: slackOAuthInstallations,
		DataDir:    dataDir,
	})
	if err != nil {
		t.Fatalf("open typed store: %v", err)
	}
	if err := store.Set(context.Background(), record.InstallationID, record); err != nil {
		t.Fatalf("seed installation store: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close typed store: %v", err)
	}
}
