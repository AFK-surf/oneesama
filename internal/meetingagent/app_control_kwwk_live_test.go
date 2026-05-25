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

const kwwkLiveSmokeTimeout = 15 * time.Second

func TestLiveKWWKStdioAppControlBackendControlsHostApp(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
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
		Instruction: "observe the shared app through the KWWK helper",
		Target: AppControlTarget{
			ApplicationName: appName,
		},
		Operations: []KWWKAppControlOperation{{Kind: KWWKAppControlState}},
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
	if !result.OK || result.Provider != "kwwk" {
		t.Fatalf("result = %#v, want KWWK success", result)
	}
	if len(result.Actions) != 1 || result.Actions[0] != "state" {
		t.Fatalf("actions = %#v, want state action", result.Actions)
	}
	if _, err := os.Stat(screenshot); err != nil {
		t.Fatalf("screenshot %q stat error = %v; result=%#v", screenshot, err, result)
	}
}

func TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", jsonForKWWKLiveSmoke(t, map[string]any{
		"session_id":  "meet_session",
		"instruction": "observe the shared app through the HTTP tool",
		"operations": []map[string]any{
			{"kind": "state"},
		},
		"context": map[string]any{
			"includeScreenshot": true,
			"screenshotOutput":  screenshot,
			"timeoutMs":         15000,
		},
	}), http.StatusOK)

	if body["ok"] != true || body["provider"] != "kwwk" || body["status"] != appControlStatusCompleted {
		t.Fatalf("body = %#v, want KWWK success through HTTP tool", body)
	}
	if _, err := os.Stat(screenshot); err != nil {
		t.Fatalf("screenshot %q stat error = %v; body=%#v", screenshot, err, body)
	}
}

func TestLiveRealtimeSharedAppControlHTTPReportsKWWKBlocker(t *testing.T) {
	if os.Getenv("MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE") != "1" {
		t.Skip("set MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 to run the host app-control smoke")
	}
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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", jsonForKWWKLiveSmoke(t, map[string]any{
		"session_id":  "meet_session",
		"instruction": "draw a snake mockup without explicit operations",
	}), http.StatusOK)

	if body["ok"] != false || body["provider"] != "kwwk" || body["error"] != "app_control_blocked" || body["blocker"] != "structured_operations_required" {
		t.Fatalf("body = %#v, want KWWK structured-operations blocker through HTTP tool", body)
	}
}

func TestLiveRealtimeSharedAppControlHTTPMutatesHostApp(t *testing.T) {
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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", jsonForKWWKLiveSmoke(t, map[string]any{
		"session_id":  "meet_session",
		"instruction": "create a visible snake mockup smoke label in the shared app",
		"operations": []map[string]any{
			{"kind": "press_key", "key": "Escape"},
			{"kind": "click", "x": 282, "y": 108},
			{"kind": "click", "x": 850, "y": 430},
			{"kind": "type_text", "text": label},
		},
		"context": map[string]any{
			"includeScreenshot": true,
			"screenshotOutput":  screenshot,
			"timeoutMs":         15000,
		},
	}), http.StatusOK)

	if body["ok"] != true || body["provider"] != "kwwk" || body["status"] != appControlStatusCompleted {
		t.Fatalf("body = %#v, want KWWK mutation success through HTTP tool", body)
	}
	actions, ok := body["actions"].([]any)
	if !ok || len(actions) != 4 || actions[0] != "press_key" || actions[3] != "type_text" {
		t.Fatalf("actions = %#v, want press_key/click/click/type_text", body["actions"])
	}
	if _, err := os.Stat(screenshot); err != nil {
		t.Fatalf("screenshot %q stat error = %v; body=%#v", screenshot, err, body)
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
