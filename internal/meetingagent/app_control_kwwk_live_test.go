package meetingagent

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const kwwkLiveSmokeTimeout = 30 * time.Second

func configureKWWKLiveSmokeFixturePlanner(t *testing.T) {
	t.Helper()
	t.Setenv("ONEESAMA_KWWK_CU_PLANNER_PROVIDER", "local")
	t.Setenv("ONEESAMA_KWWK_CU_PLANNER_MODEL", "tiny-kwwk-app-control-smoke-fixture")
}

func kwwkLiveSmokeObserveModelPlan() map[string]any {
	return map[string]any{
		"status":     "ok",
		"summary":    "Observed the shared app state.",
		"blocker":    "",
		"confidence": 0.7,
		"operations": []map[string]any{
			{"kind": string(KWWKAppControlState)},
		},
	}
}

func kwwkLiveSmokeBlockedModelPlan() map[string]any {
	return map[string]any{
		"status":     "blocked",
		"summary":    "The instruction mixes observation with a conditional action and is not directly executable.",
		"blocker":    "instruction_not_directly_executable",
		"confidence": 0.9,
		"operations": []map[string]any{},
	}
}

func TestLiveKWWKStdioAppControlBackendControlsHostApp(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
	configureKWWKLiveSmokeFixturePlanner(t)
	appName := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_APP"))
	if appName == "" {
		appName = "Pencil"
	}
	root := repoRootForKWWKLiveSmoke(t)
	screenshot := filepath.Join(t.TempDir(), "app-control-state.png")
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: `node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio`,
		Dir:     root,
		Timeout: kwwkLiveSmokeTimeout,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "live_smoke",
		Instruction: "run the explicit KWWK live smoke operation",
		Target: AppControlTarget{
			ApplicationName: appName,
		},
		Context: map[string]any{
			"includeScreenshot": true,
			"screenshotOutput":  screenshot,
			"timeoutMs":         15000,
			"modelPlan":         kwwkLiveSmokeObserveModelPlan(),
		},
		Timeout: kwwkLiveSmokeTimeout,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if !result.OK || result.Provider != "kwwk" {
		t.Fatalf("result = %#v, want KWWK success", result)
	}
	if len(result.Actions) != 1 || result.Actions[0] != "observe" {
		t.Fatalf("actions = %#v, want observe action from explicit state operation", result.Actions)
	}
	assertKWWKLiveScreenshotOrState(t, screenshot, result.Raw)
}

func TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
	configureKWWKLiveSmokeFixturePlanner(t)
	appName := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_APP"))
	if appName == "" {
		appName = "Pencil"
	}
	root := repoRootForKWWKLiveSmoke(t)
	screenshot := filepath.Join(t.TempDir(), "tool-state.png")
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: `node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio`,
		Dir:     root,
		Timeout: kwwkLiveSmokeTimeout,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  t.TempDir(),
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(t.TempDir()),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": appName,
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/kwwk_computer_use", jsonForKWWKLiveSmoke(t, map[string]any{
		"session_id":  "meet_session",
		"instruction": "observe the shared app through the HTTP tool",
		"wait":        true,
		"timeoutMs":   int(kwwkLiveSmokeTimeout / time.Millisecond),
		"context": map[string]any{
			"includeScreenshot": true,
			"screenshotOutput":  screenshot,
			"timeoutMs":         15000,
			"modelPlan":         kwwkLiveSmokeObserveModelPlan(),
		},
	}), http.StatusOK)

	if body["ok"] != true || body["provider"] != "kwwk" || body["status"] != appControlStatusCompleted {
		t.Fatalf("body = %#v, want KWWK success through HTTP tool", body)
	}
	assertKWWKLiveScreenshotOrState(t, screenshot, body)
}

func TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
	configureKWWKLiveSmokeFixturePlanner(t)
	appName := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_APP"))
	if appName == "" {
		appName = "Pencil"
	}
	root := repoRootForKWWKLiveSmoke(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: `node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio`,
		Dir:     root,
		Timeout: kwwkLiveSmokeTimeout,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  t.TempDir(),
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(t.TempDir()),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": appName,
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/kwwk_computer_use", jsonForKWWKLiveSmoke(t, map[string]any{
		"session_id":  "meet_session",
		"instruction": "observe the shared app through instruction-only KWWK direct mode",
		"wait":        true,
		"timeoutMs":   int(kwwkLiveSmokeTimeout / time.Millisecond),
		"context": map[string]any{
			"modelPlan": kwwkLiveSmokeObserveModelPlan(),
		},
	}), http.StatusOK)

	if body["ok"] != true || body["provider"] != "kwwk" || body["status"] != appControlStatusCompleted {
		t.Fatalf("body = %#v, want KWWK instruction-only observe success through HTTP tool", body)
	}
	actions, _ := body["actions"].([]any)
	if len(actions) != 1 || actions[0] != "observe" {
		t.Fatalf("actions = %#v, want observe", body["actions"])
	}
}

func TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
	configureKWWKLiveSmokeFixturePlanner(t)
	appName := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_APP"))
	if appName == "" {
		appName = "Pencil"
	}
	root := repoRootForKWWKLiveSmoke(t)
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: `node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio`,
		Dir:     root,
		Timeout: kwwkLiveSmokeTimeout,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})

	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:     "live_mixed_instruction",
		Instruction:   "Look at the shared app, then click the Got it button if visible.",
		ExecutionMode: appControlExecutionModeDirect,
		Target: AppControlTarget{
			ApplicationName: appName,
		},
		Context: map[string]any{
			"modelPlan": kwwkLiveSmokeBlockedModelPlan(),
		},
		Timeout: kwwkLiveSmokeTimeout,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}
	if result.OK || result.Blocker != "instruction_not_directly_executable" {
		t.Fatalf("result = %#v, mixed observe+action instruction must return direct blocker", result)
	}
	if len(result.Actions) == 1 && result.Actions[0] == "observe" {
		t.Fatalf("actions = %#v, mixed observe+action instruction must not pass as observe-only", result.Actions)
	}
}

func TestLiveKWWKStdioAppControlBackendMutatesHostApp(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_MUTATE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_MUTATE=1 to run the mutating host app-control smoke")
	}
	appName := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_APP"))
	if appName == "" {
		appName = "Pencil"
	}
	root := repoRootForKWWKLiveSmoke(t)
	screenshot := filepath.Join(t.TempDir(), "tool-mutated.png")
	label := strings.TrimSpace(os.Getenv("MAB_KWWK_APP_CONTROL_LIVE_LABEL"))
	if label == "" {
		label = "snake mockup smoke"
	}
	backend := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
		Command: `node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio`,
		Dir:     root,
		Timeout: kwwkLiveSmokeTimeout,
	})
	t.Cleanup(func() {
		_ = backend.Shutdown(context.Background())
	})
	result, err := backend.ControlSharedApp(context.Background(), AppControlRequest{
		SessionID:   "live_mutate",
		Instruction: "create a visible snake mockup smoke label in the shared app",
		Target: AppControlTarget{
			ApplicationName: appName,
		},
		Operations: []KWWKAppControlOperation{
			{Kind: KWWKAppControlPressKey, Key: "Escape"},
			{Kind: KWWKAppControlClick, X: 282, Y: 108},
			{Kind: KWWKAppControlClick, X: 850, Y: 430},
			{Kind: KWWKAppControlTypeText, Text: label},
		},
		Context: map[string]any{
			"includeScreenshot": true,
			"screenshotOutput":  screenshot,
			"timeoutMs":         15000,
		},
		Timeout: kwwkLiveSmokeTimeout,
	})
	if err != nil {
		t.Fatalf("ControlSharedApp() error = %v", err)
	}

	if !result.OK || result.Provider != "kwwk" || result.Status != appControlStatusCompleted {
		t.Fatalf("result = %#v, want KWWK mutation success", result)
	}
	if len(result.Actions) != 4 || result.Actions[0] != "press_key" || result.Actions[3] != "type_text" {
		t.Fatalf("actions = %#v, want press_key/click/click/type_text", result.Actions)
	}
	if _, err := os.Stat(screenshot); err != nil {
		t.Fatalf("screenshot %q stat error = %v; result=%#v", screenshot, err, result)
	}
}

func jsonForKWWKLiveSmoke(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal live smoke request: %v", err)
	}
	return string(data)
}

func assertKWWKLiveScreenshotOrState(t *testing.T, screenshot string, evidence any) {
	t.Helper()
	if _, err := os.Stat(screenshot); err == nil {
		return
	}
	state := findKWWKLiveStateEvidence(evidence)
	if state == nil {
		t.Fatalf("screenshot %q missing and no KWWK state evidence found: %#v", screenshot, evidence)
	}
	if state["ok"] != true {
		t.Fatalf("KWWK state evidence = %#v, want ok=true", state)
	}
	if _, ok := state["window"].(map[string]any); !ok {
		t.Fatalf("KWWK state evidence = %#v, want observed window metadata", state)
	}
	if state["screenshotIncluded"] == false && strings.TrimSpace(stringFromAny(state["screenshotBlocker"])) == "" {
		t.Fatalf("KWWK state evidence = %#v, screenshot miss must include blocker", state)
	}
}

func findKWWKLiveStateEvidence(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		if typed["source"] == "oneesama_app_control_helper" {
			if _, ok := typed["window"].(map[string]any); ok {
				return typed
			}
		}
		if state, ok := typed["state"].(map[string]any); ok {
			if found := findKWWKLiveStateEvidence(state); found != nil {
				return found
			}
		}
		for _, nested := range typed {
			if found := findKWWKLiveStateEvidence(nested); found != nil {
				return found
			}
		}
	case []any:
		for _, nested := range typed {
			if found := findKWWKLiveStateEvidence(nested); found != nil {
				return found
			}
		}
	}
	return nil
}

func repoRootForKWWKLiveSmoke(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(wd, "go.mod")); err == nil {
			return wd
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			t.Fatalf("go.mod not found from working directory")
		}
		wd = parent
	}
}
