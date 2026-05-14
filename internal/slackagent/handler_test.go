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
	if payload.OK || payload.Text != "Unknown command: schedule\n\n"+avatarCommandUsage() {
		t.Fatalf("payload = %#v, want schedule hidden from user command surface", payload)
	}
}

func TestHandleAvatarCommandDelegatesAndListsJobs(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{SigningSecret: "secret"},
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	delegatePayload := signAvatarCommand(t, "secret", url.Values{
		"text":       {`delegate --session meet_go_123 --mode code --write true "Summarize route wiring"`},
		"team_id":    {"T123"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
		"user_id":    {"U123"},
		"user_name":  {"peng"},
	})
	delegateResponse := httptest.NewRecorder()
	delegateRequest := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(delegatePayload.body))
	delegateRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	delegateRequest.Header.Set("X-Slack-Request-Timestamp", delegatePayload.timestamp)
	delegateRequest.Header.Set("X-Slack-Signature", delegatePayload.signature)
	router.ServeHTTP(delegateResponse, delegateRequest)

	if delegateResponse.Code != http.StatusOK {
		t.Fatalf("delegate status = %d, want 200", delegateResponse.Code)
	}

	var delegate AvatarCommandResponse
	if err := json.Unmarshal(delegateResponse.Body.Bytes(), &delegate); err != nil {
		t.Fatalf("decode delegate response: %v", err)
	}
	jobMap, ok := delegate.Metadata["job"].(map[string]any)
	if !delegate.OK || !ok {
		t.Fatalf("delegate payload = %#v, want job metadata", delegate)
	}
	if jobMap["provider"] != "codex" {
		t.Fatalf("job provider = %#v, want codex", jobMap["provider"])
	}
	if jobMap["status"] != string(agentrunner.StatusCompleted) {
		t.Fatalf("job status = %#v, want completed", jobMap["status"])
	}
	contextMap, ok := jobMap["context"].(map[string]any)
	if !ok {
		t.Fatalf("job context = %#v, want map", jobMap["context"])
	}
	slackContext, ok := contextMap["slack"].(map[string]any)
	if !ok {
		t.Fatalf("slack context = %#v, want map", contextMap["slack"])
	}
	if slackContext["workspaceId"] != "T123" || slackContext["channelId"] != "C123" {
		t.Fatalf("slack context = %#v, want team/channel ids", slackContext)
	}
	if contextMap["session_id"] != "meet_go_123" {
		t.Fatalf("session_id = %#v, want meet_go_123", contextMap["session_id"])
	}

	jobsPayload := signAvatarCommand(t, "secret", url.Values{
		"text":       {"jobs --session meet_go_123"},
		"team_id":    {"T123"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
		"user_id":    {"U123"},
		"user_name":  {"peng"},
	})
	jobsResponse := httptest.NewRecorder()
	jobsRequest := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(jobsPayload.body))
	jobsRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	jobsRequest.Header.Set("X-Slack-Request-Timestamp", jobsPayload.timestamp)
	jobsRequest.Header.Set("X-Slack-Signature", jobsPayload.signature)
	router.ServeHTTP(jobsResponse, jobsRequest)

	if jobsResponse.Code != http.StatusOK {
		t.Fatalf("jobs status = %d, want 200", jobsResponse.Code)
	}
	if !strings.Contains(jobsResponse.Body.String(), "Summarize route wiring") {
		t.Fatalf("jobs body = %s, want delegated task", jobsResponse.Body.String())
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
