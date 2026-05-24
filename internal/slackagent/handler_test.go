package slackagent

import (
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
	"github.com/AFK-surf/oneesama/internal/internalauth"
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

	response := performSlackRequest(router, http.MethodGet, "/slack/status", "", nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"service":"slack-agent"`) {
		t.Fatalf("body = %s, want slack-agent status", response.Body.String())
	}
	var body StatusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if body.Persistence != (PersistenceStatus{
		Provider:   "sqlite",
		DataDir:    "./runtime/state",
		SQLitePath: "./runtime/state/oneesama.sqlite",
	}) {
		t.Fatalf("persistence = %#v, want sqlite status", body.Persistence)
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

	response := performSlackRequest(router, http.MethodGet, "/slack/status", "", nil)

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

func TestHandlePostMessagePurposePolicy(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantStatus   int
		wantBody     []string
		wantNoPost   bool
		wantChannel  string
		wantThreadTS string
	}{
		{
			name:        "legacy dm allowed",
			body:        `{"channel":"D123","text":"hello from go"}`,
			wantStatus:  http.StatusOK,
			wantBody:    []string{`"mock":true`},
			wantChannel: "D123",
		},
		{
			name:       "legacy public channel rejected",
			body:       `{"channel":"C123","text":"hello from go"}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   []string{"requires purpose"},
			wantNoPost: true,
		},
		{
			name:        "public channel notice does not require thread",
			body:        `{"purpose":"public_channel_notice","channel":"C123","text":"channel notice"}`,
			wantStatus:  http.StatusOK,
			wantBody:    []string{`"purpose":"public_channel_notice"`},
			wantChannel: "C123",
		},
		{
			name:        "operator notice bypasses public reply gate",
			body:        `{"purpose":"operator_notice","channel":"D123","text":"operator note"}`,
			wantStatus:  http.StatusOK,
			wantBody:    []string{`"escape_hatch":true`},
			wantChannel: "D123",
		},
		{
			name:       "manual override requires bypass reason",
			body:       `{"purpose":"manual_override","channel":"C123","text":"force post"}`,
			wantStatus: http.StatusBadRequest,
			wantNoPost: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			poster := &recordingPoster{callCh: make(chan struct{}, 1)}
			router := newTestRouter(t, Config{
				Persistence: appconfig.PersistenceConfig{Provider: "memory"},
				Poster:      poster,
			})

			response := postSlackJSON(router, "/slack/post-message", tt.body)

			assertStatus(t, response, tt.wantStatus)
			assertBodyContains(t, response, tt.wantBody...)
			if tt.wantNoPost {
				if calls := poster.Calls(); len(calls) != 0 {
					t.Fatalf("poster calls = %#v, want none", calls)
				}
				return
			}
			poster.WaitForCalls(t, 1)
			calls := poster.Calls()
			if len(calls) != 1 || calls[0].Channel != tt.wantChannel || calls[0].ThreadTS != tt.wantThreadTS {
				t.Fatalf("poster calls = %#v, want channel=%q thread=%q", calls, tt.wantChannel, tt.wantThreadTS)
			}
		})
	}
}

func TestHandlePostMessagePublicThreadReplyUsesPublicReplyGate(t *testing.T) {
	snapshotTS, _, restore := installNewerHumanReplyFixture(t, "看一下这个", "我已经答了，不要重复发。")
	defer restore()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	})

	body := `{"purpose":"public_thread_reply","channel":"C123","thread_ts":"` + snapshotTS + `","snapshot_ts":"` + snapshotTS + `","text":"这条本来准备发到公开 thread。"}`
	response := postSlackJSON(router, "/slack/post-message", body)

	assertStatus(t, response, http.StatusOK)
	assertBodyContains(t, response, `"blocked":true`, "thread_has_newer_activity")
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want public stale post suppressed", calls)
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
	publishResponse := postSlackJSON(router, "/canvas/publish", publishBody)

	assertStatus(t, publishResponse, http.StatusOK)
	assertBodyContains(t, publishResponse, `"surface":"file"`)

	listResponse := performSlackRequest(router, http.MethodGet, "/canvas/published", "", nil)

	assertStatus(t, listResponse, http.StatusOK)
	assertBodyContains(t, listResponse, `"artifact_id":"artifact_1"`)
}

func TestHandleAvatarCommandRejectsInvalidSignature(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	payload := signDefaultAvatarCommand(t, "status")
	payload.signature = "v0=bad"
	response := performSignedAvatarCommand(router, payload)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if !strings.Contains(response.Body.String(), "signature_mismatch") {
		t.Fatalf("body = %s, want signature mismatch reason", response.Body.String())
	}
}

func TestSlackRoutesRejectOversizedBodies(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		path    string
		body    string
		headers map[string]string
	}{
		{
			name:   "signed slack route before signature",
			config: Config{Slack: appconfig.SlackConfig{SigningSecret: "secret"}},
			path:   "/slack/events",
			body:   strings.Repeat("x", slackSignedRequestBodyLimit+1),
			headers: map[string]string{
				"X-Slack-Request-Timestamp": strconv.FormatInt(time.Now().Unix(), 10),
				"X-Slack-Signature":         "v0=bad",
			},
		},
		{
			name:   "internal tool route",
			config: Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key"}},
			path:   "/tools/call",
			body:   `{"tool":"` + strings.Repeat("x", slackInternalJSONBodyLimit+1) + `"}`,
			headers: map[string]string{
				internalauth.HeaderName: "secret-key",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			router := newTestRouter(t, tt.config)
			headers := map[string]string{"Content-Type": "application/json"}
			for key, value := range tt.headers {
				headers[key] = value
			}
			response := performSlackRequest(router, http.MethodPost, tt.path, tt.body, headers)

			assertStatus(t, response, http.StatusRequestEntityTooLarge)
			assertBodyContains(t, response, "request body too large")
		})
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

	payload := signDefaultAvatarCommand(t, "schedule list")
	response := performSignedAvatarCommand(router, payload)

	assertStatus(t, response, http.StatusOK)

	decoded := decodeAvatarCommandResponse(t, response)
	if decoded.OK || decoded.Text != "I don't understand that command.\n\n"+avatarCommandUsage() {
		t.Fatalf("payload = %#v, want schedule hidden from user command surface", decoded)
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
		payload := signDefaultAvatarCommand(t, text)
		response := performSignedAvatarCommand(router, payload)

		assertStatus(t, response, http.StatusOK)
		decoded := decodeAvatarCommandResponse(t, response)
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

	payload := signDefaultAvatarCommand(t, "Summarize route wiring")
	response := performSignedAvatarCommand(router, payload)

	assertStatus(t, response, http.StatusOK)
	decoded := decodeAvatarCommandResponse(t, response)
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

func performSlackRequest(router http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	var requestBody io.Reader
	if body != "" {
		requestBody = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, requestBody)
	request.RemoteAddr = "127.0.0.1:4040"
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	router.ServeHTTP(response, request)
	return response
}

func postSlackJSON(router http.Handler, path, body string) *httptest.ResponseRecorder {
	return performSlackRequest(router, http.MethodPost, path, body, map[string]string{
		"Content-Type": "application/json",
	})
}

func assertStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d body=%s, want %d", response.Code, response.Body.String(), want)
	}
}

func assertBodyContains(t *testing.T, response *httptest.ResponseRecorder, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(response.Body.String(), want) {
			t.Fatalf("body = %s, want %s", response.Body.String(), want)
		}
	}
}

type signedAvatarCommand struct {
	body      string
	timestamp string
	signature string
}

func signDefaultAvatarCommand(t *testing.T, text string) signedAvatarCommand {
	t.Helper()
	return signAvatarCommand(t, "secret", url.Values{
		"text":       {text},
		"team_id":    {"T123"},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
		"user_id":    {"U123"},
		"user_name":  {"peng"},
	})
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

func performSignedAvatarCommand(router http.Handler, payload signedAvatarCommand) *httptest.ResponseRecorder {
	return performSlackRequest(router, http.MethodPost, "/slack/commands/avatar", payload.body, map[string]string{
		"Content-Type":              "application/x-www-form-urlencoded",
		"X-Slack-Request-Timestamp": payload.timestamp,
		"X-Slack-Signature":         payload.signature,
	})
}

func decodeAvatarCommandResponse(t *testing.T, response *httptest.ResponseRecorder) AvatarCommandResponse {
	t.Helper()
	var decoded AvatarCommandResponse
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return decoded
}
