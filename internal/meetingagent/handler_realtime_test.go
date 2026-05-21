package meetingagent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	if toolNamesInclude(tools, "start_demo_surface", "cancel_demo_surface") {
		t.Fatalf("tools = %#v, demo surface tools must stay hidden when default-off", body["tools"])
	}
	demoSurface := body["demoSurface"].(map[string]any)
	if demoSurface["enabled"] != false || demoSurface["toolsExposed"] != false || demoSurface["configured"] != false {
		t.Fatalf("demoSurface = %#v, want default-off status", demoSurface)
	}
	if demoSurface["dryRun"] != true || demoSurface["adapter"] != "fake" {
		t.Fatalf("demoSurface = %#v, want dry-run fake defaults", demoSurface)
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
	if len(aliases) != 5 || aliases[2] != "彭潇" {
		t.Fatalf("identity aliases = %#v, want configured aliases plus names", aliases)
	}

	resolveCurrent := httptest.NewRecorder()
	router.ServeHTTP(resolveCurrent, realtimeRequest(http.MethodPost, "/tools/resolve_speaker_identity", `{"display_name":"彭潇","source":"meet_dom"}`))
	if resolveCurrent.Code != http.StatusOK {
		t.Fatalf("resolve current status = %d: %s", resolveCurrent.Code, resolveCurrent.Body.String())
	}
	var resolveCurrentBody map[string]any
	decodeRealtimeBody(t, resolveCurrent.Body.String(), &resolveCurrentBody)
	currentIdentity := resolveCurrentBody["identity"].(map[string]any)
	if currentIdentity["canonical_name"] != "老大" || currentIdentity["role"] != "current_user" || currentIdentity["is_current_user"] != true {
		t.Fatalf("current identity = %#v, want current_user match", currentIdentity)
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
	if !toolNamesInclude(configBody["tools"].([]any), "start_demo_surface", "control_demo_surface", "cancel_demo_surface") {
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
