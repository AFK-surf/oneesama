package meetingagent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
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
		RealtimeTurnDetection:    "steady",
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
	if body["model"] != "gpt-realtime-2" || body["voice"] != "marin" || body["turnDetection"] != "steady" {
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
	turn := input["turn_detection"].(map[string]any)
	if turn["type"] != "semantic_vad" || turn["eagerness"] != "low" {
		t.Fatalf("turn_detection = %#v, want steady semantic_vad", turn)
	}
	format := input["format"].(map[string]any)
	if format["type"] != "audio/pcm" || format["rate"] != float64(24000) {
		t.Fatalf("input format = %#v, want audio/pcm 24000", format)
	}
	reasoning := session["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v, want high", reasoning)
	}
	instructions := body["instructions"].(string)
	if !strings.Contains(instructions, "low-latency AI meeting avatar") ||
		!strings.Contains(instructions, "Identity contract:") {
		t.Fatalf("instructions missing product realtime prompt: %q", instructions)
	}
	if strings.Contains(instructions, "peng@example.com") ||
		strings.Contains(instructions, "Peng Xiao") ||
		strings.Contains(instructions, "create a shared workspace") ||
		strings.Contains(instructions, "做一个贪吃蛇") ||
		strings.Contains(instructions, "delegate_to_") ||
		strings.Contains(instructions, "Codex") ||
		strings.Contains(instructions, "worker") {
		t.Fatalf("instructions leaked identity/unavailable mechanism details: %q", instructions)
	}
	tools := body["tools"].([]any)
	if !toolNamesInclude(tools, "delegate_to_worker", "present_video_stage", "share_existing_app_window", "kwwk_computer_use", "resolve_speaker_identity") {
		t.Fatalf("tools = %#v, missing expected live-safe tool names", body["tools"])
	}
	if toolNamesInclude(tools, "control_shared_app_window") {
		t.Fatalf("tools = %#v, compatibility app-control alias must not be in default Realtime tools", body["tools"])
	}
	if toolNamesInclude(tools, "list_shareable_apps", "present_app_share", "start_demo_surface", "start_demo_execution") {
		t.Fatalf("tools = %#v, realtime foreground must not expose legacy/ambiguous screen-share tools", body["tools"])
	}
	if toolNamesInclude(tools, "update_avatar_state", "set_avatar_expression", "set_avatar_action") {
		t.Fatalf("tools = %#v, visual-only avatar tools must not steal foreground functional requests", body["tools"])
	}
	if toolNamesInclude(tools, "open_shared_browser_surface", "create_shared_workspace", "stop_shared_browser_surface") {
		t.Fatalf("tools = %#v, demo surface tools must stay hidden when default-off", body["tools"])
	}
	sessionTools := session["tools"].([]any)
	if toolNamesInclude(sessionTools, "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface") {
		t.Fatalf("session tools = %#v, demo surface tools must stay hidden when default-off", sessionTools)
	}
	demoSurface := body["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != false || demoSurface["toolsExposed"] != false || demoSurface["configured"] != false {
		t.Fatalf("demoSurface = %#v, want default-off status", demoSurface)
	}
	if demoSurface["dryRun"] != true || demoSurface["adapter"] != "fake" {
		t.Fatalf("demoSurface = %#v, want dry-run fake defaults", demoSurface)
	}
	if demoSurface["mode"] != "off" {
		t.Fatalf("demoSurface = %#v, want off mode by default", demoSurface)
	}
	if demoSurface["requireExternalWriteApproval"] != true {
		t.Fatalf("demoSurface = %#v, want external-write approval required by default", demoSurface)
	}
	contextBudget := body["contextBudget"].(map[string]any)
	if contextBudget["stableTokens"].(float64) <= 0 ||
		contextBudget["dynamicTokens"].(float64) <= 0 ||
		contextBudget["toolSchemaTokens"].(float64) <= 0 ||
		contextBudget["totalTokens"].(float64) <= 0 {
		t.Fatalf("contextBudget = %#v, want realtime harness budget metrics", contextBudget)
	}
	if contextBudget["workerResultTokens"] != float64(0) || contextBudget["memoryEvidenceTokens"] != float64(0) {
		t.Fatalf("contextBudget = %#v, realtime foreground should not carry worker/memory payloads by default", contextBudget)
	}
}

func TestRealtimeContextHealthExposesLifecycleDefaults(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		RealtimeModel: "gpt-realtime-2",
		BotName:       "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodGet, "/realtime/context-health", ""))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["ok"] != true || body["itemsCount"] != float64(0) || body["tokenEstimate"] != float64(0) {
		t.Fatalf("context health = %#v, want empty healthy defaults", body)
	}
	if body["nextCompactThreshold"] != float64(80000) || body["lastCompactAt"] != "" {
		t.Fatalf("context health = %#v, want lifecycle thresholds", body)
	}
	truncation := body["sessionTruncation"].(map[string]any)
	if truncation["type"] != "retention_ratio" || truncation["retention_ratio"] != float64(0.8) {
		t.Fatalf("truncation = %#v, want product retention ratio", truncation)
	}
	policy := body["contextLifecyclePolicy"].(map[string]any)
	if policy["recentItems"] != float64(20) || policy["compactItemThreshold"] != float64(200) {
		t.Fatalf("policy = %#v, want default compact policy", policy)
	}
	contextBudget := body["contextBudget"].(map[string]any)
	if contextBudget["stableTokens"].(float64) <= 0 || contextBudget["totalTokens"].(float64) <= 0 {
		t.Fatalf("contextBudget = %#v, want realtime context budget defaults", contextBudget)
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

func TestRealtimeClientSecretStripsClientRequestedDemoToolsWhenDefaultOff(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		BaseURL:                  "https://api.openai.com/v1",
		RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
		RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{"tools":[{"type":"function","name":"start_demo_surface","parameters":{"type":"object"}},{"type":"function","name":"start_demo_execution","parameters":{"type":"object"}},{"type":"function","name":"cancel_demo_surface","parameters":{"type":"object"}}]}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want dry-run 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	session := body["session"].(map[string]any)
	tools := session["tools"].([]any)
	if len(tools) != 0 {
		t.Fatalf("session tools = %#v, stale-only client tool request must not fall back to full defaults", tools)
	}
	if toolNamesInclude(tools, "open_shared_browser_surface", "create_shared_workspace", "stop_shared_browser_surface", "control_shared_browser_surface") {
		t.Fatalf("session tools = %#v, demo tools must be server-gated off", tools)
	}
}

func TestRealtimeClientSecretHonorsClientRequestedLiveSafeToolSubset(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		BaseURL:                  "https://api.openai.com/v1",
		RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
		RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{"tools":[{"type":"function","name":"send_meet_chat","parameters":{"type":"object"}},{"type":"function","name":"share_existing_app_window","parameters":{"type":"object"}},{"type":"function","name":"open_shared_browser_surface","parameters":{"type":"object"}},{"type":"function","name":"github_search","parameters":{"type":"object"}}]}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want dry-run 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	session := body["session"].(map[string]any)
	tools := session["tools"].([]any)
	if len(tools) != 2 || !toolNamesInclude(tools, "send_meet_chat", "share_existing_app_window") {
		t.Fatalf("session tools = %#v, want exactly requested live-safe server tools", tools)
	}
	if toolNamesInclude(tools, "delegate_to_worker") ||
		toolNamesInclude(tools, "control_shared_app_window") ||
		toolNamesInclude(tools, "open_shared_browser_surface") ||
		toolNamesInclude(tools, "github_search") {
		t.Fatalf("session tools = %#v, must not expand requested subset or expose gated/stale tools", tools)
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

func TestRealtimeClientSecretRetriesTransientEOF(t *testing.T) {
	attempts := 0
	requestBodies := []string{}
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			attempts++
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatalf("read request body: %v", err)
			}
			requestBodies = append(requestBodies, string(body))
			if attempts == 1 {
				return nil, io.EOF
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"client_secret":{"value":"ek_retry"},"expires_at":123}`)),
				Request:    request,
			}, nil
		}),
	}
	router := newRealtimeTestRouterWithConfig(t, Config{
		HTTPClient: client,
		OpenAI: appconfig.OpenAIConfig{
			APIKey:                   "test-key",
			BaseURL:                  "https://api.openai.com/v1",
			RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
			RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
			RealtimeModel:            "gpt-realtime-2",
			RealtimeReasoningEffort:  "high",
			RealtimeVoice:            "marin",
			RealtimeTurnDetection:    "semantic_vad",
			RealtimeSessionSchema:    "realtime-2",
			BotName:                  "Meeting Avatar Bot",
		},
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{"safetyIdentifier":"operator-retry"}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 after retry: %s", response.Code, response.Body.String())
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want first EOF plus successful retry", attempts)
	}
	if len(requestBodies) != 2 || requestBodies[0] == "" || requestBodies[0] != requestBodies[1] {
		t.Fatalf("requestBodies = %#v, want retry with identical non-empty payload", requestBodies)
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["mintAttempts"] != float64(2) {
		t.Fatalf("body = %#v, want mintAttempts=2", body)
	}
	secret := body["client_secret"].(map[string]any)
	if secret["value"] != "ek_retry" {
		t.Fatalf("client_secret = %#v, want retry response", secret)
	}
}

func TestRealtimeClientSecretReturnsBadGatewayAfterTransientRetryExhaustion(t *testing.T) {
	attempts := 0
	client := &http.Client{
		Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			attempts++
			return nil, io.EOF
		}),
	}
	router := newRealtimeTestRouterWithConfig(t, Config{
		HTTPClient: client,
		OpenAI: appconfig.OpenAIConfig{
			APIKey:                   "test-key",
			BaseURL:                  "https://api.openai.com/v1",
			RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
			RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
			RealtimeModel:            "gpt-realtime-2",
			RealtimeReasoningEffort:  "high",
			RealtimeVoice:            "marin",
			RealtimeTurnDetection:    "semantic_vad",
			RealtimeSessionSchema:    "realtime-2",
			BotName:                  "Meeting Avatar Bot",
		},
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodPost, "/realtime/client-secret", `{}`))

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 after retry exhaustion: %s", response.Code, response.Body.String())
	}
	if attempts != realtimeClientSecretMaxAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, realtimeClientSecretMaxAttempts)
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	errorEnvelope := body["error"].(map[string]any)
	if errorEnvelope["message"] != "mint realtime client secret failed" {
		t.Fatalf("error = %#v, want handler error envelope", errorEnvelope)
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
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
		CurrentUserAliases:     []string{"彭潇", "肖鹏", "Operator"},
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
	aliases := currentUser["aliases"].([]any)
	if len(aliases) != 4 || aliases[1] != "彭潇" || containsAnyString(aliases, "老大") {
		t.Fatalf("identity aliases = %#v, want stable configured aliases without runtime-only nickname", aliases)
	}

	resolveCurrent := httptest.NewRecorder()
	router.ServeHTTP(resolveCurrent, realtimeRequest(http.MethodPost, "/tools/resolve_speaker_identity", `{"display_name":"彭潇","source":"meet_dom"}`))
	if resolveCurrent.Code != http.StatusOK {
		t.Fatalf("resolve current status = %d: %s", resolveCurrent.Code, resolveCurrent.Body.String())
	}
	var resolveCurrentBody map[string]any
	decodeRealtimeBody(t, resolveCurrent.Body.String(), &resolveCurrentBody)
	currentIdentity := resolveCurrentBody["identity"].(map[string]any)
	if currentIdentity["canonical_name"] != "Peng Xiao" ||
		currentIdentity["preferred_name"] != "Peng Xiao" ||
		currentIdentity["role"] != "current_user" ||
		currentIdentity["is_current_user"] != true {
		t.Fatalf("current identity = %#v, want current_user spoken-name match", currentIdentity)
	}

	resolveExternal := httptest.NewRecorder()
	router.ServeHTTP(resolveExternal, realtimeRequest(http.MethodPost, "/tools/resolve_speaker_identity", `{"display_name":"李四","source":"meet_dom"}`))
	if resolveExternal.Code != http.StatusOK {
		t.Fatalf("resolve external status = %d: %s", resolveExternal.Code, resolveExternal.Body.String())
	}
	var resolveExternalBody map[string]any
	decodeRealtimeBody(t, resolveExternal.Body.String(), &resolveExternalBody)
	externalIdentity := resolveExternalBody["identity"].(map[string]any)
	if externalIdentity["canonical_name"] != "李四" || externalIdentity["role"] != "external" || externalIdentity["is_current_user"] != false {
		t.Fatalf("external identity = %#v, want safe display-name fallback", externalIdentity)
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

func TestRealtimeCurrentUserDoesNotPreinjectRuntimeOnlyAlias(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{
		CurrentUserName:        "老大",
		CurrentUserEnglishName: "Peng Xiao",
		CurrentUserAliases:     []string{"老大", "彭潇"},
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(http.MethodGet, "/realtime/config", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	currentUser := body["currentUser"].(map[string]any)
	aliases := currentUser["aliases"].([]any)
	if containsAnyString(aliases, "老大") {
		t.Fatalf("aliases = %#v, must not preinject runtime-only nickname", aliases)
	}
	if !containsAnyString(aliases, "Peng Xiao") || !containsAnyString(aliases, "彭潇") {
		t.Fatalf("aliases = %#v, want stable configured names preserved", aliases)
	}

	resolveCurrent := httptest.NewRecorder()
	router.ServeHTTP(resolveCurrent, realtimeRequest(http.MethodPost, "/tools/resolve_speaker_identity", `{"display_name":"老大","source":"manual"}`))
	if resolveCurrent.Code != http.StatusOK {
		t.Fatalf("resolve current status = %d: %s", resolveCurrent.Code, resolveCurrent.Body.String())
	}
	var resolveCurrentBody map[string]any
	decodeRealtimeBody(t, resolveCurrent.Body.String(), &resolveCurrentBody)
	currentIdentity := resolveCurrentBody["identity"].(map[string]any)
	if currentIdentity["is_current_user"] == true {
		t.Fatalf("identity = %#v, runtime-only nickname must not resolve from static config alone", currentIdentity)
	}
}

func TestRealtimeCurrentUserOverwritesStaleWorkspaceAlias(t *testing.T) {
	t.Parallel()

	service := NewService(Config{
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		OpenAI: appconfig.OpenAIConfig{
			CurrentUserName:        "Peng Xiao",
			CurrentUserEnglishName: "Peng Xiao",
			CurrentUserEmail:       "peng@example.com",
			CurrentUserLinear:      "pengxiao",
			CurrentUserGitHub:      "pengx17",
		},
	})
	if err := service.upsertIdentityRecord(context.Background(), IdentityUserRecord{
		ID:               "workspace:current_user",
		CanonicalName:    "老大",
		PreferredName:    "Peng Xiao",
		Role:             "current_user",
		Aliases:          []string{"老大", "Peng Xiao"},
		MeetDisplayNames: []string{"老大", "Peng Xiao"},
		Email:            "peng@example.com",
		Sources:          []string{"workspace_owner_config"},
	}); err != nil {
		t.Fatalf("seed stale workspace current user: %v", err)
	}

	identity := service.resolveSpeakerIdentity(context.Background(), resolveSpeakerIdentityInput{
		DisplayName: "老大",
		Source:      "manual",
	})
	if identity["is_current_user"] == true {
		t.Fatalf("identity = %#v, stale runtime-only alias must be overwritten", identity)
	}
	stored, ok, err := service.identityStore.Get(context.Background(), "workspace:current_user")
	if err != nil || !ok {
		t.Fatalf("load stored current user ok=%v err=%v", ok, err)
	}
	if stored.CanonicalName != "Peng Xiao" || containsString(stored.Aliases, "老大") || containsString(stored.MeetDisplayNames, "老大") {
		t.Fatalf("stored current user = %#v, want stale runtime-only alias removed", stored)
	}
}

func TestRealtimeDemoSurfaceToolsUseBridge(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	lifecycle := NewDemoWorkspaceLifecycle(rootDir, &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 6001}})
	kwwk := NewFakeDemoKWWKClient()
	kwwk.QueueResult(DemoKWWKActionResult{
		Summary:    "Demo page opened for the meeting.",
		Confidence: 0.9,
	})
	kwwk.QueueResult(DemoKWWKActionResult{
		Summary:    "Demo page changed in the already shared browser window.",
		Confidence: 0.95,
	})
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Controller: DemoController{
			Client: kwwk,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://example.test/"},
				AllowActiveControl:   true,
			},
		},
		Presenter:    DemoSurfacePresenter{Share: &fakeDemoSurfaceShareClient{}},
		Store:        NewDemoSessionStore(),
		Observations: NewDemoObservationBus(),
	}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI:           appconfig.OpenAIConfig{},
		DemoBridge:       bridge,
		DemoSurface: appconfig.DemoSurfaceConfig{
			Enabled:             true,
			ExposeRealtimeTools: true,
			Adapter:             "fake",
			RootDir:             rootDir,
			DryRun:              true,
			AllowActiveControl:  true,
		},
	})

	startBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/open_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","url":"https://example.test/demo","goal":"show it"}`, http.StatusOK)
	if startBody["ok"] != true || startBody["session_id"] != "demo_tool" || !strings.Contains(stringFromAny(startBody["observation_context"]), "Demo page opened") {
		t.Fatalf("start body = %#v, want demo observation", startBody)
	}

	controlBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","action":"click","text":"Start snake"}`, http.StatusOK)
	if controlBody["ok"] != true || stringFromAny(controlBody["status"]) != realtimeDemoBridgeStatusUpdated || !strings.Contains(stringFromAny(controlBody["observation_context"]), "already shared browser window") {
		t.Fatalf("control body = %#v, want updated demo observation", controlBody)
	}

	cancelBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/stop_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","reason":"done"}`, http.StatusOK)
	if cancelBody["ok"] != true || stringFromAny(cancelBody["status"]) != realtimeDemoBridgeStatusStopped {
		t.Fatalf("cancel body = %#v, want stopped", cancelBody)
	}

}

func TestRealtimeDemoSurfaceToolsDefaultOff(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{})
	startBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/open_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_off","url":"https://example.test/demo","goal":"show it"}`, http.StatusServiceUnavailable)
	if startBody["ok"] != false || startBody["error"] != "demo_surface_tool_not_exposed" {
		t.Fatalf("start body = %#v, want hidden demo tool rejected", startBody)
	}
	deprecatedBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_old","url":"https://example.test/demo","goal":"show it"}`, http.StatusGone)
	if deprecatedBody["ok"] != false || deprecatedBody["error"] != "deprecated_demo_surface_tool" {
		t.Fatalf("deprecated body = %#v, want deprecated demo tool rejected", deprecatedBody)
	}
}

func TestRealtimeDemoSurfaceEnabledDoesNotExposeForegroundToolsByDefault(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		MeetRunner: fakeMeetRunner{},
		DemoSurface: appconfig.DemoSurfaceConfig{
			Enabled:              true,
			Adapter:              "fake",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configBody := performRealtimeJSON(t, router, http.MethodGet, "/realtime/config", "", http.StatusOK)
	demoTools := []string{"open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface"}
	if toolNamesInclude(configBody["tools"].([]any), demoTools...) {
		t.Fatalf("tools = %#v, demo surface bridge must not expose browser tools without explicit opt-in", configBody["tools"])
	}
	session := configBody["session"].(map[string]any)
	if toolNamesInclude(session["tools"].([]any), demoTools...) {
		t.Fatalf("session.tools = %#v, demo surface bridge must not expose browser tools without explicit opt-in", session["tools"])
	}
	demoSurface := configBody["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != true || demoSurface["configured"] != true || demoSurface["toolsExposed"] != false {
		t.Fatalf("demoSurface = %#v, want bridge enabled but foreground tools hidden", demoSurface)
	}

	aliasBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/open_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_alias_hidden","url":"https://example.test/demo","goal":"show it"}`, http.StatusServiceUnavailable)
	if aliasBody["ok"] != false || aliasBody["error"] != "demo_surface_tool_not_exposed" {
		t.Fatalf("alias body = %#v, want hidden realtime demo alias rejected", aliasBody)
	}
	canonicalBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_canonical_hidden","url":"https://example.test/demo","goal":"show it"}`, http.StatusGone)
	if canonicalBody["ok"] != false || canonicalBody["error"] != "deprecated_demo_surface_tool" {
		t.Fatalf("canonical body = %#v, want deprecated canonical demo tool rejected", canonicalBody)
	}

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
}

func TestRealtimeDemoSurfaceRuntimeFlagEnablesSmoke(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		MeetRunner: fakeMeetRunner{},
		DemoSurface: appconfig.DemoSurfaceConfig{
			Enabled:              true,
			ExposeRealtimeTools:  true,
			Adapter:              "fake",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configBody := performRealtimeJSON(t, router, http.MethodGet, "/realtime/config", "", http.StatusOK)
	if !toolNamesInclude(configBody["tools"].([]any), "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface", "share_existing_app_window", "kwwk_computer_use", "control_shared_app_window") {
		t.Fatalf("tools = %#v, want demo surface tools when flag enabled", configBody["tools"])
	}
	demoSurface := configBody["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != true || demoSurface["toolsExposed"] != true || demoSurface["configured"] != true || demoSurface["exposeRealtimeTools"] != true {
		t.Fatalf("demoSurface = %#v, want enabled configured status", demoSurface)
	}

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	startBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/open_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_flag","url":"https://example.test/demo","goal":"show it"}`, http.StatusOK)
	if startBody["ok"] != true || startBody["session_id"] != "demo_flag" {
		t.Fatalf("start body = %#v, want successful demo session", startBody)
	}
	if !strings.Contains(stringFromAny(startBody["observation_context"]), "opened") {
		t.Fatalf("start body = %#v, want observation context from fake demo loop", startBody)
	}

	cancelBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/stop_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_flag","reason":"done"}`, http.StatusOK)
	if cancelBody["ok"] != true || stringFromAny(cancelBody["status"]) != realtimeDemoBridgeStatusStopped {
		t.Fatalf("cancel body = %#v, want stopped", cancelBody)
	}

	deprecatedBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_old_exposed","url":"https://example.test/demo","goal":"show it"}`, http.StatusGone)
	if deprecatedBody["ok"] != false || deprecatedBody["error"] != "deprecated_demo_surface_tool" {
		t.Fatalf("deprecated body = %#v, want deprecated canonical demo tool rejected even when exposed", deprecatedBody)
	}

	postCancelBody := performRealtimeJSON(t, router, http.MethodGet, "/realtime/config", "", http.StatusOK)
	status := postCancelBody["demoSurface"].(map[string]any)
	recent := status["recentSessions"].([]any)
	if len(recent) != 1 {
		t.Fatalf("recentSessions = %#v, want one demo feedback session", recent)
	}
	recentSession := recent[0].(map[string]any)
	if recentSession["mode"] != "safe" {
		t.Fatalf("recent session = %#v, want safe mode in audit trail", recentSession)
	}
	summaryPath := stringFromAny(recentSession["summary_json"])
	if summaryPath == "" {
		t.Fatalf("recent session = %#v, want summary json path for feedback package", recentSession)
	}
	if _, err := os.Stat(summaryPath); err != nil {
		t.Fatalf("feedback summary %q not written: %v", summaryPath, err)
	}

	trailResponse := httptest.NewRecorder()
	router.ServeHTTP(trailResponse, realtimeRequest(http.MethodGet, "/demo-surface/sessions/demo_flag/trail", ""))
	if trailResponse.Code != http.StatusOK {
		t.Fatalf("trail status = %d: %s", trailResponse.Code, trailResponse.Body.String())
	}
	var trailBody map[string]any
	decodeRealtimeBody(t, trailResponse.Body.String(), &trailBody)
	trail := trailBody["trail"].(map[string]any)
	if len(trail["entries"].([]any)) != 3 || len(trail["runbook_lines"].([]any)) != 3 {
		t.Fatalf("trail = %#v, want trigger/action/stop feedback package", trail)
	}
}

type recordingRealtimeTextTurnRunner struct {
	fakeMeetRunner
	input meetrunner.RealtimeTextTurnInput
	calls int
}

func (r *recordingRealtimeTextTurnRunner) RequestRealtimeTextTurn(_ context.Context, input meetrunner.RealtimeTextTurnInput) (meetrunner.RealtimeTextTurnResult, error) {
	r.input = input
	r.calls++
	return meetrunner.RealtimeTextTurnResult{
		"ok":         true,
		"source":     "fake_realtime_text_turn",
		"session_id": input.SessionID,
		"text":       input.Text,
	}, nil
}

func TestRealtimeTextTurnRouteProxiesToActiveJoinSession(t *testing.T) {
	t.Parallel()

	runner := &recordingRealtimeTextTurnRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/text-turn", `{"text":"分享 Chrome 浏览器窗口","instructions":"force a real tool call"}`, http.StatusOK)
	if body["ok"] != true || body["source"] != "fake_realtime_text_turn" {
		t.Fatalf("body = %#v, want proxied realtime text turn", body)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	if runner.input.SessionID != "meet_session" || runner.input.Text != "分享 Chrome 浏览器窗口" || runner.input.Instructions != "force a real tool call" {
		t.Fatalf("runner input = %#v", runner.input)
	}
}

func TestRealtimeTextTurnRouteRequiresText(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{})
	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/text-turn", `{}`, http.StatusBadRequest)
	if body["ok"] != false || body["error"] != "text_required" {
		t.Fatalf("body = %#v, want text_required", body)
	}
}

func newRealtimeTestRouter(t *testing.T, openai appconfig.OpenAIConfig) http.Handler {
	t.Helper()
	return newRealtimeTestRouterWithDemoBridge(t, openai, nil)
}

func newRealtimeTestRouterWithDemoBridge(t *testing.T, openai appconfig.OpenAIConfig, demoBridge *RealtimeDemoBridge) http.Handler {
	t.Helper()
	rootDir := t.TempDir()
	return newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI:           openai,
		MeetRunner:       fakeMeetRunner{},
		DemoSurface: appconfig.DemoSurfaceConfig{
			Adapter:                      "fake",
			RootDir:                      rootDir + "/demo-surfaces",
			DryRun:                       true,
			RequireExternalWriteApproval: true,
		},
		DemoBridge: demoBridge,
	})
}

func newRealtimeTestRouterWithConfig(t *testing.T, cfg Config) http.Handler {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if cfg.Logger == nil {
		cfg.Logger = logger
	}
	if cfg.Persistence.Provider == "" {
		cfg.Persistence = appconfig.PersistenceConfig{Provider: "memory"}
	}
	if cfg.ArtifactsRootDir == "" {
		cfg.ArtifactsRootDir = t.TempDir()
	}
	if cfg.InternalAuthKey == "" {
		cfg.InternalAuthKey = "secret-key"
	}
	if cfg.Pipeline == nil {
		cfg.Pipeline = postmeeting.NewPipeline(cfg.ArtifactsRootDir)
	}
	if cfg.MeetRunner == nil {
		cfg.MeetRunner = fakeMeetRunner{}
	}
	service := NewService(cfg)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = service.Shutdown(ctx)
	})
	return httpserver.New("meeting-agent", logger, []string{"*"}, NewHandler(service))
}

func realtimeRequest(method string, path string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func performRealtimeRequest(t *testing.T, router http.Handler, method string, path string, body string, wantStatus int) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, realtimeRequest(method, path, body))
	if response.Code != wantStatus {
		t.Fatalf("%s %s status = %d, want %d: %s", method, path, response.Code, wantStatus, response.Body.String())
	}
	return response
}

func performRealtimeJSON(t *testing.T, router http.Handler, method string, path string, body string, wantStatus int) map[string]any {
	t.Helper()
	response := performRealtimeRequest(t, router, method, path, body, wantStatus)
	var payload map[string]any
	decodeRealtimeBody(t, response.Body.String(), &payload)
	return payload
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

func waitForDemoTrailEntry(t *testing.T, router http.Handler, sessionID string, wants ...string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, realtimeRequest(http.MethodGet, "/demo-surface/sessions/"+sessionID+"/trail", ""))
		last = response.Body.String()
		if response.Code == http.StatusOK {
			ok := true
			for _, want := range wants {
				if !strings.Contains(last, want) {
					ok = false
					break
				}
			}
			if ok {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("demo trail for %s never contained %v; last = %s", sessionID, wants, last)
}

func demoTrailHasReason(trail DemoSessionFeedbackPackage, reason string) bool {
	for _, entry := range trail.Entries {
		if entry.ReasonCode == reason {
			return true
		}
	}
	return false
}

type fakeDemoSurfacePresenter struct{}

func (fakeDemoSurfacePresenter) Present(_ context.Context, req DemoSurfacePresentRequest) (DemoSurfacePresentation, error) {
	return DemoSurfacePresentation{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSessionID:    firstNonEmpty(strings.TrimSpace(req.DemoSessionID), strings.TrimSpace(req.DemoSession.ID)),
		Status:           DemoSurfacePresentationPresenting,
		Reason:           "fake_presented",
	}, nil
}

func (fakeDemoSurfacePresenter) Stop(_ context.Context, req DemoSurfaceStopRequest) (DemoSurfacePresentation, error) {
	return DemoSurfacePresentation{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSessionID:    strings.TrimSpace(req.DemoSessionID),
		Status:           DemoSurfacePresentationStopped,
		Reason:           "fake_stopped",
	}, nil
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

func toolByName(tools []any, name string) map[string]any {
	for _, tool := range tools {
		typed, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		if typed["name"] == name {
			return typed
		}
	}
	return nil
}

func containsAnyString(values []any, want string) bool {
	for _, value := range values {
		if text, ok := value.(string); ok && text == want {
			return true
		}
	}
	return false
}
