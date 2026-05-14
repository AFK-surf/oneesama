package meetingagent

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

func TestRealtimeConfigMatchesOldDefaults(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		BaseURL:                  "https://api.openai.com/v1",
		RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
		RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeReasoningEffort:  "high",
		RealtimeVoice:            "marin",
		RealtimeTurnDetection:    "semantic_vad",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
		CurrentUserName:          "Peng",
		CurrentUserEnglishName:   "Peng Xiao",
		CurrentUserEmail:         "peng@example.com",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodGet, "/realtime/config", ""))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["model"] != "gpt-realtime-2" || body["voice"] != "marin" || body["turnDetection"] != "semantic_vad" {
		t.Fatalf("body = %#v, want old realtime defaults", body)
	}
	currentUser := body["currentUser"].(map[string]any)
	if currentUser["name"] != "Peng" || currentUser["englishName"] != "Peng Xiao" {
		t.Fatalf("currentUser = %#v, want configured identity", currentUser)
	}
	tuning := body["tuning"].(map[string]any)
	presets := tuning["presets"].(map[string]any)
	if presets["steady"] == nil || presets["fast"] == nil || presets["server_vad"] == nil {
		t.Fatalf("tuning presets = %#v, want human-loop presets", presets)
	}
	session := body["session"].(map[string]any)
	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	format := input["format"].(map[string]any)
	if format["type"] != "audio/pcm" || format["rate"] != float64(24000) {
		t.Fatalf("input format = %#v, want audio/pcm 24000", format)
	}
	reasoning := session["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v, want high", reasoning)
	}
	if !strings.Contains(body["instructions"].(string), "low-latency AI meeting avatar") ||
		!strings.Contains(body["instructions"].(string), "peng@example.com") {
		t.Fatalf("instructions missing old realtime prompt: %q", body["instructions"])
	}
	if !toolNamesInclude(body["tools"].([]any), "delegate_to_worker", "present_video_stage", "update_avatar_state") {
		t.Fatalf("tools = %#v, missing expected old tool names", body["tools"])
	}
}

func TestRealtimeClientSecretDryRunMissingAPIKey(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		BaseURL:                  "https://api.openai.com/v1",
		RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
		RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeReasoningEffort:  "high",
		RealtimeVoice:            "marin",
		RealtimeTurnDetection:    "semantic_vad",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want dry-run 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["ok"] != false || body["dryRun"] != true || body["error"] != "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing" {
		t.Fatalf("body = %#v, want old missing-key dry-run shape", body)
	}
}

func TestRealtimeClientSecretPostsToOpenAI(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want bearer key", r.Header.Get("Authorization"))
		}
		if r.Header.Get("OpenAI-Safety-Identifier") != "operator-1" {
			t.Fatalf("OpenAI-Safety-Identifier = %q, want request value", r.Header.Get("OpenAI-Safety-Identifier"))
		}
		var payload map[string]any
		decodeRealtimeReader(t, r.Body, &payload)
		session := payload["session"].(map[string]any)
		if session["model"] != "gpt-realtime-2-live" || session["tool_choice"] != "auto" {
			t.Fatalf("session = %#v, want requested model/tool_choice", session)
		}
		_, _ = w.Write([]byte(`{"client_secret":{"value":"ek_test"},"expires_at":123}`))
	}))
	defer upstream.Close()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		APIKey:                   "test-key",
		BaseURL:                  upstream.URL,
		RealtimeClientSecretsURL: upstream.URL,
		RealtimeSDPURL:           upstream.URL + "/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeReasoningEffort:  "high",
		RealtimeVoice:            "marin",
		RealtimeTurnDetection:    "semantic_vad",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{"model":"gpt-realtime-2-live","safetyIdentifier":"operator-1"}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["ok"] != true {
		t.Fatalf("body = %#v, want ok=true", body)
	}
	secret := body["client_secret"].(map[string]any)
	if secret["value"] != "ek_test" {
		t.Fatalf("client_secret = %#v, want upstream parsed response", secret)
	}
}

func TestRealtimeClientSecretUpstreamError(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`not json`))
	}))
	defer upstream.Close()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		APIKey:                   "test-key",
		BaseURL:                  upstream.URL,
		RealtimeClientSecretsURL: upstream.URL,
		RealtimeSDPURL:           upstream.URL + "/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeReasoningEffort:  "high",
		RealtimeVoice:            "marin",
		RealtimeTurnDetection:    "semantic_vad",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{}`))

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["error"] != "openai_realtime_upstream" || body["status"] != float64(http.StatusTeapot) {
		t.Fatalf("body = %#v, want upstream error shape", body)
	}
	detail := body["detail"].(map[string]any)
	if detail["raw"] != "not json" {
		t.Fatalf("detail = %#v, want raw body", detail)
	}
}

func TestRealtimeWorkspaceToolsExposeCurrentUserAndNow(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		CurrentUserName:        "老大",
		CurrentUserEnglishName: "Peng Xiao",
		CurrentUserEmail:       "peng@example.com",
		CurrentUserLinear:      "pengxiao",
		CurrentUserGitHub:      "pengx17",
		CurrentUserRole:        "owner",
	})

	identity := httptest.NewRecorder()
	router.ServeHTTP(identity, realtimeRequest(http.MethodPost, "/tools/current_user_identity", `{}`))
	if identity.Code != http.StatusOK {
		t.Fatalf("identity status = %d: %s", identity.Code, identity.Body.String())
	}
	var identityBody map[string]any
	decodeRealtimeBody(t, identity.Body.String(), &identityBody)
	currentUser := identityBody["current_user"].(map[string]any)
	if currentUser["name"] != "老大" || currentUser["english_name"] != "Peng Xiao" || currentUser["github"] != "pengx17" {
		t.Fatalf("identity body = %#v, want configured current user", identityBody)
	}

	now := httptest.NewRecorder()
	router.ServeHTTP(now, realtimeRequest(http.MethodPost, "/tools/now", `{}`))
	if now.Code != http.StatusOK {
		t.Fatalf("now status = %d: %s", now.Code, now.Body.String())
	}
	var nowBody map[string]any
	decodeRealtimeBody(t, now.Body.String(), &nowBody)
	if nowBody["timezone"] != "Asia/Shanghai" || nowBody["now"] == "" {
		t.Fatalf("now body = %#v, want Asia/Shanghai timestamp", nowBody)
	}
}

func newRealtimeTestRouter(t *testing.T, openai appconfig.OpenAIConfig) http.Handler {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()
	service := NewService(Config{
		Logger:           logger,
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI:           openai,
	})
	return httpserver.New("meeting-agent", logger, []string{"*"}, NewHandler(service))
}

func realtimeRequest(method string, path string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func decodeRealtimeBody(t *testing.T, body string, target any) {
	t.Helper()
	decodeRealtimeReader(t, strings.NewReader(body), target)
}

func decodeRealtimeReader(t *testing.T, reader io.Reader, target any) {
	t.Helper()
	if err := json.NewDecoder(reader).Decode(target); err != nil {
		t.Fatalf("decode json: %v", err)
	}
}

func toolNamesInclude(tools []any, names ...string) bool {
	found := map[string]bool{}
	for _, tool := range tools {
		typed, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		if name, ok := typed["name"].(string); ok {
			found[name] = true
		}
	}
	for _, name := range names {
		if !found[name] {
			return false
		}
	}
	return true
}
