package slackagent

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/httpserver"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

func TestHandleStatus(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{
			Provider:   "sqlite",
			DataDir:    "./runtime/state",
			SQLitePath: "./runtime/state/oneesama.sqlite",
		},
		Slack: appconfig.SlackConfig{AppToken: "xapp-test"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			Codex: appconfig.CodexRunnerConfig{
				Model:         "deepseek/deepseek-v4-pro",
				ModelProvider: "openrouter",
				BaseURL:       "https://openrouter.ai/api/v1",
			},
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/status", nil)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"service":"slack-agent"`) {
		t.Fatalf("body = %s, want slack-agent status", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"provider":"sqlite"`) {
		t.Fatalf("body = %s, want sqlite persistence", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"socket_mode":{"configured":true`) {
		t.Fatalf("body = %s, want socket mode status", response.Body.String())
	}
	for _, want := range []string{`"model":"deepseek/deepseek-v4-pro"`, `"model_provider":"openrouter"`, `"base_url":"https://openrouter.ai/api/v1"`} {
		if !strings.Contains(response.Body.String(), want) {
			t.Fatalf("body = %s, want %s", response.Body.String(), want)
		}
	}
}

func TestHandleStatusReportsAgentRunnerFailureCodes(t *testing.T) {
	router := newTestRouter(t, Config{
		Runner: &fakeRunner{
			job: agentrunner.Job{
				ID:          "job_timeout",
				Provider:    "codex",
				Status:      agentrunner.StatusTimeout,
				FailureCode: agentrunner.FailureTimeout,
			},
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/status", nil)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body StatusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if got := body.AgentRunner.FailureCodes[string(agentrunner.FailureTimeout)]; got != 1 {
		t.Fatalf("failure_codes = %#v, want timeout=1", body.AgentRunner.FailureCodes)
	}
}

func TestHandlePostMessageUsesPoster(t *testing.T) {
	router := newTestRouter(t, Config{
		Poster: NewPoster(PosterConfig{Mock: true, BotToken: "x"}),
	})

	body := `{"channel":"C123","text":"hello from go"}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/post-message", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"mock":true`) {
		t.Fatalf("body = %s, want mock poster result", response.Body.String())
	}
}

func TestHandleCanvasPublishAndList(t *testing.T) {
	router := newTestRouter(t, Config{
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "file",
			OutDir:   t.TempDir(),
		},
	})

	publishBody := `{"artifact_id":"artifact_1","title":"Daily sync","summary_markdown":"# summary\n"}`
	publishResponse := httptest.NewRecorder()
	publishRequest := httptest.NewRequest(http.MethodPost, "/canvas/publish", strings.NewReader(publishBody))
	publishRequest.Header.Set("Content-Type", "application/json")
	publishRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(publishResponse, publishRequest)

	if publishResponse.Code != http.StatusOK {
		t.Fatalf("publish status = %d, want 200", publishResponse.Code)
	}
	if !strings.Contains(publishResponse.Body.String(), `"surface":"file"`) {
		t.Fatalf("publish body = %s, want file manifest", publishResponse.Body.String())
	}

	listResponse := httptest.NewRecorder()
	listRequest := httptest.NewRequest(http.MethodGet, "/canvas/published", nil)
	listRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(listResponse, listRequest)

	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listResponse.Code)
	}
	if !strings.Contains(listResponse.Body.String(), `"artifact_id":"artifact_1"`) {
		t.Fatalf("list body = %s, want artifact manifest", listResponse.Body.String())
	}
}

func TestHandleAvatarCommandRejectsInvalidSignature(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	form := url.Values{
		"text":       {"status"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
	}
	body := form.Encode()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", "v0=bad")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if !strings.Contains(response.Body.String(), "signature_mismatch") {
		t.Fatalf("body = %s, want signature mismatch reason", response.Body.String())
	}
}

func TestHandleAvatarCommandDoesNotExposeScheduleSurface(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
		ScheduleManager: NewInMemoryScheduleManager([]ScheduleDefinition{
			{
				"id": "sched_1",
				"metadata": map[string]any{
					SlackScheduleMetadataChannelID: "C123",
					SlackScheduleMetadataThreadTS:  "123.456",
				},
			},
		}),
	})

	form := url.Values{
		"text":       {"schedule list"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
	}
	body := form.Encode()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signature := SignSlackRequestBody("secret", timestamp, body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	var payload AvatarCommandResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.OK || payload.Text != "I don't understand that command.\n\n"+avatarCommandUsage() {
		t.Fatalf("payload = %#v, want schedule hidden from user command surface", payload)
	}
}

func TestHandleAvatarCommandHidesWorkerDebugCommands(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{SigningSecret: "secret"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	for _, text := range []string{
		`delegate --session meet_go_123 --mode code --write true "Summarize route wiring"`,
		"jobs --session meet_go_123",
	} {
		payload := signAvatarCommand(t, "secret", url.Values{
			"text":       {text},
			"team_id":    {"T123"},
			"channel_id": {"C123"},
			"thread_ts":  {"123.456"},
			"user_id":    {"U123"},
			"user_name":  {"peng"},
		})
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(payload.body))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
		request.Header.Set("X-Slack-Signature", payload.signature)
		router.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", text, response.Code)
		}
		var decoded AvatarCommandResponse
		if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %s response: %v", text, err)
		}
		if decoded.OK || !strings.Contains(decoded.Text, "I don't understand that command.") {
			t.Fatalf("%s payload = %#v, want hidden debug command", text, decoded)
		}
		if strings.Contains(decoded.Text, "delegate") || strings.Contains(decoded.Text, "jobs") || strings.Contains(decoded.Text, "Codex") {
			t.Fatalf("%s text = %q, want no worker implementation terms", text, decoded.Text)
		}
	}
}

func TestHandleAvatarCommandNaturalTextStartsWorkInternally(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{SigningSecret: "secret"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	payload := signAvatarCommand(t, "secret", url.Values{
		"text":       {"Summarize route wiring"},
		"team_id":    {"T123"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
		"user_id":    {"U123"},
		"user_name":  {"peng"},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var decoded AvatarCommandResponse
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	jobMap, ok := decoded.Metadata["job"].(map[string]any)
	if !decoded.OK || !ok {
		t.Fatalf("payload = %#v, want internal task metadata", decoded)
	}
	if decoded.Text != "我来处理，完成后会发回这个线程。" {
		t.Fatalf("text = %q, want generic work acknowledgement", decoded.Text)
	}
	if jobMap["provider"] != "codex" || jobMap["task"] != "Summarize route wiring" {
		t.Fatalf("job = %#v, want provider and natural task", jobMap)
	}
	if strings.Contains(decoded.Text, "delegate") || strings.Contains(decoded.Text, "Codex") {
		t.Fatalf("text = %q, want no implementation terms", decoded.Text)
	}
}

func newTestRouter(t *testing.T, cfg Config) http.Handler {
	t.Helper()

	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewService(cfg)
	handler := NewHandler(service)
	return httpserver.New("slack-agent", logger, []string{"*"}, handler)
}

type signedAvatarCommand struct {
	body      string
	timestamp string
	signature string
}

func signAvatarCommand(t *testing.T, secret string, form url.Values) signedAvatarCommand {
	t.Helper()

	body := form.Encode()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	return signedAvatarCommand{
		body:      body,
		timestamp: timestamp,
		signature: SignSlackRequestBody(secret, timestamp, body),
	}
}
