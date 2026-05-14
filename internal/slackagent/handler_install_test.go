package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleInstallRedirectsWithStateCookie(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			ClientID:      "client-123",
			ClientSecret:  "client-secret",
			PublicBaseURL: "https://oneesama.example.com",
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/install", nil)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", response.Code)
	}

	location := response.Header().Get("Location")
	if location == "" {
		t.Fatalf("missing redirect location")
	}
	installURL, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse location: %v", err)
	}
	if installURL.Host != "slack.com" || installURL.Path != "/oauth/v2/authorize" {
		t.Fatalf("location = %s, want slack oauth authorize url", location)
	}

	query := installURL.Query()
	if query.Get("client_id") != "client-123" {
		t.Fatalf("client_id = %q, want %q", query.Get("client_id"), "client-123")
	}
	if query.Get("redirect_uri") != "https://oneesama.example.com/slack/oauth" {
		t.Fatalf("redirect_uri = %q, want callback url", query.Get("redirect_uri"))
	}
	if query.Get("state") == "" {
		t.Fatalf("expected non-empty oauth state in redirect query")
	}

	stateCookie := response.Result().Cookies()[0]
	if stateCookie.Name != slackOAuthStateCookie {
		t.Fatalf("cookie name = %q, want %q", stateCookie.Name, slackOAuthStateCookie)
	}
	if stateCookie.Value != query.Get("state") {
		t.Fatalf("cookie value = %q, want state %q", stateCookie.Value, query.Get("state"))
	}
	if !stateCookie.HttpOnly || !stateCookie.Secure {
		t.Fatalf("cookie flags = httpOnly:%v secure:%v, want both true", stateCookie.HttpOnly, stateCookie.Secure)
	}
	if stateCookie.Path != "/slack/oauth" {
		t.Fatalf("cookie path = %q, want %q", stateCookie.Path, "/slack/oauth")
	}
}

func TestHandleOAuthCallbackRejectsStateMismatch(t *testing.T) {
	exchanger := &fakeOAuthExchanger{}
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			ClientID:      "client-123",
			ClientSecret:  "client-secret",
			PublicBaseURL: "https://oneesama.example.com",
		},
		OAuthExchanger: exchanger,
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/oauth?code=abc&state=expected-state", nil)
	request.AddCookie(&http.Cookie{Name: slackOAuthStateCookie, Value: "different-state"})
	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if !strings.Contains(response.Body.String(), "state mismatch") {
		t.Fatalf("body = %s, want state mismatch error", response.Body.String())
	}
	if exchanger.calls != 0 {
		t.Fatalf("exchange calls = %d, want 0", exchanger.calls)
	}
}

func TestHandleOAuthCallbackPersistsInstallation(t *testing.T) {
	stateDir := t.TempDir()
	exchanger := &fakeOAuthExchanger{
		result: SlackOAuthExchangeResult{
			OK:     true,
			Status: http.StatusOK,
			Body: SlackOAuthResponseBody{
				OK:          true,
				AppID:       "A123",
				Scope:       "chat:write,commands",
				TokenType:   "bot",
				AccessToken: "xoxb-1234567890",
				BotUserID:   "B123",
				Team:        &SlackOAuthTeam{ID: "T123", Name: "Team Onee"},
				AuthedUser: &SlackOAuthAuthedUser{
					ID:          "U123",
					Scope:       "channels:history",
					AccessToken: "xoxp-1234567890",
					TokenType:   "user",
				},
				IncomingWebhook: &SlackOAuthIncomingHook{
					Channel:          "xp-test",
					ChannelID:        "C123",
					ConfigurationURL: "https://slack.com/app_redirect?channel=C123",
				},
			},
		},
	}

	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{
			Provider: "json-file",
			DataDir:  stateDir,
		},
		Slack: appconfig.SlackConfig{
			ClientID:      "client-123",
			ClientSecret:  "client-secret",
			RedirectURI:   "https://oneesama.example.com/slack/oauth",
			PublicBaseURL: "https://oneesama.example.com",
		},
		OAuthExchanger: exchanger,
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/oauth?code=abc&state=state-123", nil)
	request.AddCookie(&http.Cookie{Name: slackOAuthStateCookie, Value: "state-123"})
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"installation_id":"team:T123"`) {
		t.Fatalf("body = %s, want persisted installation id", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"bot_access_token":"...7890"`) {
		t.Fatalf("body = %s, want masked bot token", response.Body.String())
	}

	store, err := persistence.OpenTyped[SlackInstallation](persistence.Options{
		Provider:   persistence.ProviderJSONFile,
		Collection: slackOAuthInstallations,
		DataDir:    stateDir,
		FilePath:   filepath.Join(stateDir, slackOAuthInstallations+".json"),
	})
	if err != nil {
		t.Fatalf("open typed store: %v", err)
	}
	record, ok, err := store.Get(context.Background(), "team:T123")
	if err != nil {
		t.Fatalf("store.Get: %v", err)
	}
	if !ok {
		t.Fatalf("expected persisted installation record")
	}
	if record.BotAccessToken != "xoxb-1234567890" {
		t.Fatalf("BotAccessToken = %q, want full token", record.BotAccessToken)
	}
	if record.AuthedUserAccessToken != "xoxp-1234567890" {
		t.Fatalf("AuthedUserAccessToken = %q, want full token", record.AuthedUserAccessToken)
	}
}

type fakeOAuthExchanger struct {
	result SlackOAuthExchangeResult
	err    error
	calls  int
	input  SlackOAuthExchangeInput
}

func (f *fakeOAuthExchanger) ExchangeCode(_ context.Context, input SlackOAuthExchangeInput) (SlackOAuthExchangeResult, error) {
	f.calls++
	f.input = input
	return f.result, f.err
}
