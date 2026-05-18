package integration

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetingagent"
	"github.com/AFK-surf/oneesama/internal/slackagent"
	"github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackAndMeetingAuthSecuritySmoke(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()

	meetingListener := newListener(t)
	slackListener := newListener(t)
	slackBaseURL := "http://" + slackListener.Addr().String()

	cfg := config.Config{
		SlackAgent:   config.ServiceConfig{AllowedOrigins: []string{"*"}},
		MeetingAgent: config.ServiceConfig{AllowedOrigins: []string{"*"}},
		Slack: config.SlackConfig{
			ClientID:        "client-123",
			ClientSecret:    "client-secret",
			PublicBaseURL:   slackBaseURL,
			InternalAuthKey: "integration-key",
			WorkspaceDir:    rootDir + "/workspace",
		},
		Persistence: config.PersistenceConfig{
			Provider: "json-file",
			DataDir:  rootDir + "/state",
		},
	}

	cfg.MeetingAgent.Listen = meetingListener.Addr().String()
	meetingServer := meetingagent.NewServer(cfg, logger.With("service", "meeting-agent"))
	meetingBaseURL := serveManagedServer(t, meetingServer, meetingListener)

	cfg.SlackAgent.Listen = slackListener.Addr().String()
	slackServer := slackagent.NewServer(cfg, logger.With("service", "slack-agent"))
	slackBaseURL = serveManagedServer(t, slackServer, slackListener)

	t.Run("loopback_requests_ignore_forwarded_for", func(t *testing.T) {
		validateResponse := postJSON(t, slackBaseURL+"/slack/validate", `{"require_slack_tokens":false}`, map[string]string{
			"X-Forwarded-For": "203.0.113.10",
		})
		if validateResponse.StatusCode != http.StatusOK {
			t.Fatalf("slack validate status = %d, want 200", validateResponse.StatusCode)
		}
		validateBody := readBody(t, validateResponse)
		if !strings.Contains(string(validateBody), `"ok":true`) {
			t.Fatalf("slack validate body = %s, want successful loopback request", validateBody)
		}

		statusResponse := get(t, meetingBaseURL+"/meetings/status", map[string]string{
			"X-Forwarded-For": "203.0.113.10",
		})
		if statusResponse.StatusCode != http.StatusOK {
			t.Fatalf("meeting status = %d, want 200", statusResponse.StatusCode)
		}
		statusBody := readBody(t, statusResponse)
		if !strings.Contains(string(statusBody), `"internal_auth_configured":true`) {
			t.Fatalf("meeting status body = %s, want successful loopback status", statusBody)
		}
	})

	t.Run("slack_install_sets_state_cookie", func(t *testing.T) {
		response := getNoRedirect(t, slackBaseURL+"/slack/install", nil)
		if response.StatusCode != http.StatusFound {
			t.Fatalf("install status = %d, want 302", response.StatusCode)
		}

		location := response.Header.Get("Location")
		if location == "" {
			t.Fatal("missing install redirect location")
		}
		installURL, err := url.Parse(location)
		if err != nil {
			t.Fatalf("parse location: %v", err)
		}
		if installURL.Host != "slack.com" || installURL.Path != "/oauth/v2/authorize" {
			t.Fatalf("location = %s, want slack oauth authorize url", location)
		}
		if installURL.Query().Get("redirect_uri") != slackBaseURL+"/slack/oauth" {
			t.Fatalf("redirect_uri = %q, want %q", installURL.Query().Get("redirect_uri"), slackBaseURL+"/slack/oauth")
		}
		state := installURL.Query().Get("state")
		if state == "" {
			t.Fatal("expected non-empty oauth state")
		}
		cookies := response.Cookies()
		if len(cookies) == 0 || cookies[0].Value != state {
			t.Fatalf("cookies = %#v, want state cookie matching redirect query", cookies)
		}
	})

	t.Run("slack_oauth_rejects_state_mismatch", func(t *testing.T) {
		response := getNoRedirect(t, slackBaseURL+"/slack/oauth?code=abc&state=expected-state", map[string]string{
			"Cookie": (&http.Cookie{
				Name:  "oneesama_slack_oauth_state",
				Value: "different-state",
				Path:  "/slack/oauth",
			}).String(),
		})
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("oauth callback status = %d, want 401", response.StatusCode)
		}
		callbackBody := readBody(t, response)
		if !strings.Contains(string(callbackBody), "state mismatch") {
			t.Fatalf("oauth callback body = %s, want state mismatch", callbackBody)
		}
	})

	t.Run("slack_workspace_bootstrap_ignores_forwarded_for", func(t *testing.T) {
		response := postJSON(t, slackBaseURL+"/slack/workspace/bootstrap", `{}`, map[string]string{
			"X-Forwarded-For": "203.0.113.10",
		})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("workspace bootstrap status = %d, want 200", response.StatusCode)
		}
		bootstrapBody := readBody(t, response)
		if !strings.Contains(string(bootstrapBody), `"template_count":18`) {
			t.Fatalf("workspace bootstrap body = %s, want successful bootstrap", bootstrapBody)
		}
	})
}

func getNoRedirect(t *testing.T, targetURL string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		t.Fatalf("build get request: %v", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}

	client := &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext: (&net.Dialer{}).DialContext,
		},
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("do request %s %s: %v", request.Method, request.URL.String(), err)
	}
	t.Cleanup(func() {
		_ = response.Body.Close()
	})
	return response
}
