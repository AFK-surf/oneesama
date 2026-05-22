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

	"github.com/AFK-surf/oneesama/internal/agentrunner"
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
	instructions := body["instructions"].(string)
	if !strings.Contains(instructions, "low-latency AI meeting avatar") ||
		!strings.Contains(instructions, "Identity contract:") {
		t.Fatalf("instructions missing product realtime prompt: %q", instructions)
	}
	if strings.Contains(instructions, "peng@example.com") ||
		strings.Contains(instructions, "Peng Xiao") ||
		strings.Contains(instructions, "delegate_to_") ||
		strings.Contains(instructions, "Codex") ||
		strings.Contains(instructions, "worker") {
		t.Fatalf("instructions leaked identity/mechanism details: %q", instructions)
	}
	tools := body["tools"].([]any)
	if !toolNamesInclude(tools, "delegate_to_worker", "present_video_stage", "update_avatar_state", "resolve_speaker_identity") {
		t.Fatalf("tools = %#v, missing expected old tool names", body["tools"])
	}
	if toolNamesInclude(tools, "start_demo_surface", "start_demo_execution", "cancel_demo_surface") {
		t.Fatalf("tools = %#v, demo surface tools must stay hidden when default-off", body["tools"])
	}
	sessionTools := session["tools"].([]any)
	if toolNamesInclude(sessionTools, "start_demo_surface", "start_demo_execution", "control_demo_surface", "cancel_demo_surface") {
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
	if toolNamesInclude(tools, "start_demo_surface", "start_demo_execution", "cancel_demo_surface", "control_demo_surface") {
		t.Fatalf("session tools = %#v, demo tools must be server-gated off", tools)
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
	router := newRealtimeTestRouterWithDemoBridge(t, appconfig.OpenAIConfig{}, bridge)

	start := httptest.NewRecorder()
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","url":"https://example.test/demo","goal":"show it"}`))
	if start.Code != http.StatusOK {
		t.Fatalf("start status = %d: %s", start.Code, start.Body.String())
	}
	var startBody map[string]any
	decodeRealtimeBody(t, start.Body.String(), &startBody)
	if startBody["ok"] != true || startBody["session_id"] != "demo_tool" || !strings.Contains(stringFromAny(startBody["observation_context"]), "Demo page opened") {
		t.Fatalf("start body = %#v, want demo observation", startBody)
	}

	control := httptest.NewRecorder()
	router.ServeHTTP(control, realtimeRequest(http.MethodPost, "/tools/control_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","action":"click","text":"Start snake"}`))
	if control.Code != http.StatusOK {
		t.Fatalf("control status = %d: %s", control.Code, control.Body.String())
	}
	var controlBody map[string]any
	decodeRealtimeBody(t, control.Body.String(), &controlBody)
	if controlBody["ok"] != true || stringFromAny(controlBody["status"]) != realtimeDemoBridgeStatusUpdated || !strings.Contains(stringFromAny(controlBody["observation_context"]), "already shared browser window") {
		t.Fatalf("control body = %#v, want updated demo observation", controlBody)
	}

	cancel := httptest.NewRecorder()
	router.ServeHTTP(cancel, realtimeRequest(http.MethodPost, "/tools/cancel_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_tool","reason":"done"}`))
	if cancel.Code != http.StatusOK {
		t.Fatalf("cancel status = %d: %s", cancel.Code, cancel.Body.String())
	}
	var cancelBody map[string]any
	decodeRealtimeBody(t, cancel.Body.String(), &cancelBody)
	if cancelBody["ok"] != true || stringFromAny(cancelBody["status"]) != realtimeDemoBridgeStatusStopped {
		t.Fatalf("cancel body = %#v, want stopped", cancelBody)
	}

}

func TestRealtimeDemoSurfaceToolsDefaultOff(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{})
	start := httptest.NewRecorder()
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_off","url":"https://example.test/demo","goal":"show it"}`))
	if start.Code != http.StatusServiceUnavailable {
		t.Fatalf("start status = %d, want 503: %s", start.Code, start.Body.String())
	}
	var startBody map[string]any
	decodeRealtimeBody(t, start.Body.String(), &startBody)
	if startBody["ok"] != false || startBody["error"] != errRealtimeDemoBridgeUnavailable.Error() {
		t.Fatalf("start body = %#v, want demo bridge unavailable", startBody)
	}
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
			Adapter:              "fake",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configResponse := httptest.NewRecorder()
	router.ServeHTTP(configResponse, realtimeRequest(http.MethodGet, "/realtime/config", ""))
	if configResponse.Code != http.StatusOK {
		t.Fatalf("config status = %d: %s", configResponse.Code, configResponse.Body.String())
	}
	var configBody map[string]any
	decodeRealtimeBody(t, configResponse.Body.String(), &configBody)
	if !toolNamesInclude(configBody["tools"].([]any), "start_demo_surface", "start_demo_execution", "control_demo_surface", "cancel_demo_surface") {
		t.Fatalf("tools = %#v, want demo surface tools when flag enabled", configBody["tools"])
	}
	demoSurface := configBody["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != true || demoSurface["toolsExposed"] != true || demoSurface["configured"] != true {
		t.Fatalf("demoSurface = %#v, want enabled configured status", demoSurface)
	}

	join := httptest.NewRecorder()
	router.ServeHTTP(join, realtimeRequest(http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`))
	if join.Code != http.StatusOK {
		t.Fatalf("join status = %d: %s", join.Code, join.Body.String())
	}

	start := httptest.NewRecorder()
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_flag","url":"https://example.test/demo","goal":"show it"}`))
	if start.Code != http.StatusOK {
		t.Fatalf("start status = %d: %s", start.Code, start.Body.String())
	}
	var startBody map[string]any
	decodeRealtimeBody(t, start.Body.String(), &startBody)
	if startBody["ok"] != true || startBody["session_id"] != "demo_flag" {
		t.Fatalf("start body = %#v, want successful demo session", startBody)
	}
	if !strings.Contains(stringFromAny(startBody["observation_context"]), "opened") {
		t.Fatalf("start body = %#v, want observation context from fake demo loop", startBody)
	}

	cancel := httptest.NewRecorder()
	router.ServeHTTP(cancel, realtimeRequest(http.MethodPost, "/tools/cancel_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_flag","reason":"done"}`))
	if cancel.Code != http.StatusOK {
		t.Fatalf("cancel status = %d: %s", cancel.Code, cancel.Body.String())
	}
	var cancelBody map[string]any
	decodeRealtimeBody(t, cancel.Body.String(), &cancelBody)
	if cancelBody["ok"] != true || stringFromAny(cancelBody["status"]) != realtimeDemoBridgeStatusStopped {
		t.Fatalf("cancel body = %#v, want stopped", cancelBody)
	}

	postCancelConfig := httptest.NewRecorder()
	router.ServeHTTP(postCancelConfig, realtimeRequest(http.MethodGet, "/realtime/config", ""))
	if postCancelConfig.Code != http.StatusOK {
		t.Fatalf("post-cancel config status = %d: %s", postCancelConfig.Code, postCancelConfig.Body.String())
	}
	var postCancelBody map[string]any
	decodeRealtimeBody(t, postCancelConfig.Body.String(), &postCancelBody)
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

func TestRealtimeDemoExecutionStartsWorkerSurfaceAndApprovalGate(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_snake_demo",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"status":"completed","summary":"Snake page ready","demo_url":"https://example.test/snake/final","files_changed":["snake/index.html"],"needs_approval":["close issue after human approval"]}`,
		},
	}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel:          "gpt-realtime-2",
			BotName:                "Meeting Avatar Bot",
			CurrentUserEnglishName: "Peng Xiao",
		},
		MeetRunner: fakeMeetRunner{},
		Runner:     runner,
		DemoSurface: appconfig.DemoSurfaceConfig{
			Enabled:              true,
			Mode:                 "safe",
			Adapter:              "fake",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configResponse := httptest.NewRecorder()
	router.ServeHTTP(configResponse, realtimeRequest(http.MethodGet, "/realtime/config", ""))
	if configResponse.Code != http.StatusOK {
		t.Fatalf("config status = %d: %s", configResponse.Code, configResponse.Body.String())
	}
	var configBody map[string]any
	decodeRealtimeBody(t, configResponse.Body.String(), &configBody)
	if !toolNamesInclude(configBody["tools"].([]any), "start_demo_execution") {
		t.Fatalf("tools = %#v, want demo execution tool when demo surface enabled", configBody["tools"])
	}
	if !strings.Contains(stringFromAny(configBody["instructions"]), "做一个贪吃蛇") ||
		!strings.Contains(stringFromAny(configBody["instructions"]), "start_demo_execution") {
		t.Fatalf("instructions = %q, want semantic demo-execution example", stringFromAny(configBody["instructions"]))
	}

	join := httptest.NewRecorder()
	router.ServeHTTP(join, realtimeRequest(http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_screen_share_bridge":true}`))
	if join.Code != http.StatusOK {
		t.Fatalf("join status = %d: %s", join.Code, join.Body.String())
	}

	start := httptest.NewRecorder()
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/start_demo_execution", `{"session_id":"meet_session","demo_session_id":"snake_demo","task":"做一个贪吃蛇，然后给我看屏幕，不要先讲规划","task_url":"https://example.test/tasks/snake","demo_url":"https://example.test/tasks/snake","issue_id":"MOCK-1","request_issue_close":true,"user_instruction":"短一点，进度走屏幕"}`))
	if start.Code != http.StatusOK {
		t.Fatalf("start status = %d: %s", start.Code, start.Body.String())
	}
	var startBody map[string]any
	decodeRealtimeBody(t, start.Body.String(), &startBody)
	if startBody["ok"] != true || stringFromAny(startBody["status"]) != realtimeDemoExecutionStatusStarted {
		t.Fatalf("start body = %#v, want started demo execution", startBody)
	}
	approval := startBody["approval"].(map[string]any)
	if approval["required"] != true || approval["operation"] != "close_issue" || approval["reason"] != "external_write_approval_required" {
		t.Fatalf("approval = %#v, want external close approval gate", approval)
	}
	if startBody["completion_demo"] != nil || startBody["report"] != nil {
		t.Fatalf("start body = %#v, want async worker completion outside immediate tool result", startBody)
	}
	if !strings.Contains(stringFromAny(startBody["observation_context"]), "fake kwwk open_url observation") {
		t.Fatalf("start body = %#v, want initial demo observation", startBody)
	}
	if runner.startCount != 1 || !runner.startInput.AllowCodeChanges || runner.startInput.Mode != "code" {
		t.Fatalf("runner input = %#v count=%d, want code-capable worker", runner.startInput, runner.startCount)
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindDemoExecution ||
		runner.startInput.Context["session_role"] != agentrunner.SessionRoleDemoExecution {
		t.Fatalf("runner context = %#v, want demo execution capabilities", runner.startInput.Context)
	}
	preferences := runner.startInput.Context["user_preferences"].(map[string]any)
	if preferences["no_planning"] != true || preferences["concise"] != true ||
		preferences["progress_channel"] != "demo_surface" || preferences["preferred_spoken_name"] != "Peng Xiao" {
		t.Fatalf("preferences = %#v, want user preference snapshot", preferences)
	}
	if !strings.Contains(runner.startInput.Task, "Do the requested task; do not return a plan-only answer.") ||
		!strings.Contains(runner.startInput.Task, "needs_approval") ||
		!strings.Contains(runner.startInput.Task, "做一个贪吃蛇") {
		t.Fatalf("worker task = %q, missing execution contract", runner.startInput.Task)
	}
	waitForDemoTrailEntry(t, router, "snake_demo", "https://example.test/snake/final", "demo_execution_worker_started")
}

func TestServiceShutdownCancelsDemoExecutionCompletion(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_slow_demo",
			Provider: "codex",
			Status:   agentrunner.StatusRunning,
		},
	}
	service := NewService(Config{
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		MeetRunner: fakeMeetRunner{},
		Runner:     runner,
		DemoBridge: &RealtimeDemoBridge{
			Mode:      "safe",
			Lifecycle: NewDemoWorkspaceLifecycle(rootDir+"/demo-surfaces", demoWorkspaceNoopLauncher{}),
			Controller: DemoController{
				Client: NewFakeDemoKWWKClient(),
				Safety: DemoSafetyPolicy{
					URLAllowlistPatterns: []string{"https://example.test/"},
					DryRun:               true,
				},
			},
			Presenter:    fakeDemoSurfacePresenter{},
			Store:        NewPersistentDemoSessionStore(rootDir + "/demo-surfaces/feedback"),
			Observations: NewDemoObservationBus(),
		},
	})

	result, err := service.StartRealtimeDemoExecution(context.Background(), RealtimeDemoExecutionStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "slow_demo",
		Task:             "做一个慢任务，然后给我看屏幕",
		DemoURL:          "https://example.test/tasks/slow",
	})
	if err != nil || !result.OK || result.Status != realtimeDemoExecutionStatusStarted {
		t.Fatalf("StartRealtimeDemoExecution() = %#v, %v; want started", result, err)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	trail, ok := service.DemoSurfaceTrail("slow_demo")
	if !ok {
		t.Fatalf("DemoSurfaceTrail(slow_demo) missing")
	}
	if !demoTrailHasReason(trail, "demo_execution_completion_cancelled") {
		t.Fatalf("trail = %#v, want completion cancellation audit", trail)
	}
}

func TestRealtimeDemoSurfaceRuntimeFlagEnablesCodexAdapterSmoke(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_demo_codex_runtime",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"summary":"Codex browser-use opened the demo page and saw the launch checklist.","confidence":0.88}`,
		},
	}
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
		Runner:     runner,
		DemoSurface: appconfig.DemoSurfaceConfig{
			Enabled:              true,
			Adapter:              "codex",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configResponse := httptest.NewRecorder()
	router.ServeHTTP(configResponse, realtimeRequest(http.MethodGet, "/realtime/config", ""))
	if configResponse.Code != http.StatusOK {
		t.Fatalf("config status = %d: %s", configResponse.Code, configResponse.Body.String())
	}
	var configBody map[string]any
	decodeRealtimeBody(t, configResponse.Body.String(), &configBody)
	demoSurface := configBody["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != true || demoSurface["adapter"] != "codex" {
		t.Fatalf("demoSurface = %#v, want enabled codex adapter", demoSurface)
	}

	join := httptest.NewRecorder()
	router.ServeHTTP(join, realtimeRequest(http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`))
	if join.Code != http.StatusOK {
		t.Fatalf("join status = %d: %s", join.Code, join.Body.String())
	}

	start := httptest.NewRecorder()
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/start_demo_surface", `{"session_id":"meet_session","demo_session_id":"demo_codex_flag","url":"https://example.test/demo","goal":"show it"}`))
	if start.Code != http.StatusOK {
		t.Fatalf("start status = %d: %s", start.Code, start.Body.String())
	}
	var startBody map[string]any
	decodeRealtimeBody(t, start.Body.String(), &startBody)
	if startBody["ok"] != true || startBody["session_id"] != "demo_codex_flag" {
		t.Fatalf("start body = %#v, want successful codex demo session", startBody)
	}
	if !strings.Contains(stringFromAny(startBody["observation_context"]), "Codex browser-use opened") {
		t.Fatalf("start body = %#v, want observation context from codex adapter", startBody)
	}
	if runner.startCount != 1 || !strings.Contains(runner.startInput.Task, "browser-use") {
		t.Fatalf("runner start = %d input=%#v, want codex browser-use job", runner.startCount, runner.startInput)
	}
}

func TestResolveSpeakerIdentityFusesSlackAndPeopleMemory(t *testing.T) {
	t.Parallel()

	slackAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/users.list" {
			t.Fatalf("slack path = %q, want /users.list", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer xoxb-test" {
			t.Fatalf("Authorization = %q, want bot token", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{
			"ok": true,
			"members": [
				{
					"id": "U123",
					"team_id": "T123",
					"name": "peng",
					"real_name": "Peng Xiao",
					"profile": {
						"display_name": "Peng",
						"real_name": "Peng Xiao",
						"email": "peng@example.com"
					}
				}
			],
			"response_metadata": {"next_cursor": ""}
		}`))
	}))
	defer slackAPI.Close()

	service := NewService(Config{
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(t.TempDir()),
		OpenAI: appconfig.OpenAIConfig{
			CurrentUserName:        "Peng Xiao",
			CurrentUserEnglishName: "Peng Xiao",
			CurrentUserEmail:       "peng@example.com",
			CurrentUserAliases:     []string{"彭潇"},
		},
		SlackBotToken:   "xoxb-test",
		SlackAPIBaseURL: slackAPI.URL,
	})
	if err := service.upsertIdentityRecord(context.Background(), IdentityUserRecord{
		ID:                  "person:peng",
		CanonicalName:       "Peng Xiao",
		PreferredName:       "Peng Xiao",
		HonorificPreference: "肖鹏",
		Role:                "current_user",
		Aliases:             []string{"老大"},
		Email:               "peng@example.com",
		Sources:             []string{"people_memory"},
	}); err != nil {
		t.Fatalf("seed people memory: %v", err)
	}

	identity := service.resolveSpeakerIdentity(context.Background(), resolveSpeakerIdentityInput{
		DisplayName: "彭潇",
		Source:      "meet_dom",
	})
	if identity["canonical_name"] != "Peng Xiao" || identity["preferred_name"] != "肖鹏" || identity["is_current_user"] != true {
		t.Fatalf("identity = %#v, want fused current user with honorific", identity)
	}
	if identity["confidence"] != "high" || identity["source_match_count"] != 3 {
		t.Fatalf("identity = %#v, want high confidence from three sources", identity)
	}
	cross := identity["cross_service_ids"].(map[string]any)
	if cross["slack_user_id"] != "U123" || cross["email"] != "peng@example.com" {
		t.Fatalf("cross_service_ids = %#v, want Slack + email mapping", cross)
	}
}

func TestResolveSpeakerIdentityUsesCalendarAttendees(t *testing.T) {
	t.Parallel()

	service := NewService(Config{
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(t.TempDir()),
		OpenAI: appconfig.OpenAIConfig{
			CurrentUserName:        "Peng Xiao",
			CurrentUserEnglishName: "Peng Xiao",
		},
	})
	start := "2026-05-17T09:00:00Z"
	end := "2026-05-17T10:00:00Z"
	if _, err := service.ScheduleMeetdMeeting(context.Background(), MeetdMeetingBrief{
		EventID:   "event-1",
		MeetURL:   "https://meet.google.com/abc-defg-hij",
		Title:     "Calendar source fixture",
		StartAt:   start,
		EndAt:     end,
		Attendees: []string{"Li Si <lisi@example.com>"},
		Status:    "active",
	}); err != nil {
		t.Fatalf("schedule meeting: %v", err)
	}

	identity := service.resolveSpeakerIdentity(context.Background(), resolveSpeakerIdentityInput{
		DisplayName: "Li Si",
		Source:      "caption",
		MeetingURL:  "https://meet.google.com/abc-defg-hij",
	})
	if identity["canonical_name"] != "Li Si" || identity["role"] != "external" || identity["confidence"] != "medium" {
		t.Fatalf("identity = %#v, want calendar attendee match", identity)
	}
	cross := identity["cross_service_ids"].(map[string]any)
	emails := cross["calendar_emails"].([]string)
	if len(emails) != 1 || emails[0] != "lisi@example.com" {
		t.Fatalf("cross_service_ids = %#v, want calendar email", cross)
	}
}

func TestResolveSpeakerIdentityDisambiguatesAndFailsClosed(t *testing.T) {
	t.Parallel()

	service := NewService(Config{
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(t.TempDir()),
		OpenAI: appconfig.OpenAIConfig{
			CurrentUserName: "Owner",
		},
	})
	for _, record := range []IdentityUserRecord{
		{ID: "person:zhang-san", CanonicalName: "张三", Aliases: []string{"Zhang San"}, Sources: []string{"people_memory"}},
		{ID: "person:zhang-shan", CanonicalName: "张山", Aliases: []string{"Zhang Shan"}, Sources: []string{"people_memory"}},
		{ID: "person:alex-a", CanonicalName: "Alex A", Aliases: []string{"Alex"}, Sources: []string{"people_memory"}},
		{ID: "person:alex-b", CanonicalName: "Alex B", Aliases: []string{"Alex"}, Sources: []string{"people_memory"}},
	} {
		if err := service.upsertIdentityRecord(context.Background(), record); err != nil {
			t.Fatalf("seed identity %s: %v", record.ID, err)
		}
	}

	resolved := service.resolveSpeakerIdentity(context.Background(), resolveSpeakerIdentityInput{
		DisplayName: "Zhang San",
		Source:      "meet_dom",
	})
	if resolved["canonical_name"] != "张三" || resolved["confidence"] != "medium" {
		t.Fatalf("resolved = %#v, want exact Zhang San match", resolved)
	}

	ambiguous := service.resolveSpeakerIdentity(context.Background(), resolveSpeakerIdentityInput{
		DisplayName: "Alex",
		Source:      "meet_dom",
	})
	if ambiguous["canonical_name"] != "Alex" || ambiguous["confidence"] != "low" || ambiguous["resolver"] != "identity_resolver_v2" {
		t.Fatalf("ambiguous = %#v, want low-confidence fallback", ambiguous)
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

func containsAnyString(values []any, want string) bool {
	for _, value := range values {
		if text, ok := value.(string); ok && text == want {
			return true
		}
	}
	return false
}
