package meetingagent

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestRealtimeSharedAppControlStartsComputerUseWorker(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_app_control",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true,"summary":"Drew a test stroke in Pencil.","actions":["selected pencil","drew stroke"],"confidence":0.8,"blocker":""}`,
		},
	}
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
		Runner: runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
					"title":           "共享 Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas","executionMode":"delegate","wait":true}`, http.StatusOK)

	if body["ok"] != true || body["status"] != string(agentrunner.StatusCompleted) {
		t.Fatalf("body = %#v, want completed app-control worker", body)
	}
	if runner.startCount != 1 {
		t.Fatalf("startCount = %d, want 1", runner.startCount)
	}
	task := runner.startInput.Task
	if !strings.Contains(task, "Computer Use") || !strings.Contains(task, "Pencil") || !strings.Contains(task, "draw a small circle") {
		t.Fatalf("task prompt = %q, want Computer Use app-control request", task)
	}
	if strings.Contains(task, "raw CGEvent") && !strings.Contains(task, "Do not implement low-level CGEvent") {
		t.Fatalf("task prompt = %q, must prohibit low-level CGEvent control", task)
	}
	if runner.startInput.AllowCodeChanges {
		t.Fatalf("start input = %#v, app control must not allow code changes", runner.startInput)
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindMeetingAppControl {
		t.Fatalf("context = %#v, want meeting app control session kind", runner.startInput.Context)
	}
	if runner.startInput.Context["application_name"] != "Pencil" {
		t.Fatalf("context = %#v, want app name", runner.startInput.Context)
	}
	capabilities := runner.startInput.Context["session_capabilities"].(agentrunner.SessionCapabilities)
	if !demoCodexContainsString(capabilities.AllowedTools, "computer_use") ||
		!demoCodexContainsString(capabilities.BlockedTools, "bash") {
		t.Fatalf("capabilities = %#v, want Computer Use allowed and shell/code blocked", capabilities)
	}
	if capabilities.ExternalToolsExcluded {
		t.Fatalf("capabilities = %#v, app control must expose real host Computer Use tools", capabilities)
	}
}

func TestRealtimeSharedAppControlDelegatesConfiguredKWWKGoalToComputerUseExecutor(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_app_control_goal",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true,"summary":"Explored Pencil and drew a circle.","actions":["observed canvas","selected a shape tool","drew circle","verified result"],"confidence":0.82,"blocker":""}`,
		},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		AppControl: appconfig.AppControlConfig{
			Provider:      "kwwk",
			CodexFallback: false,
			KWWK:          appconfig.KWWKAppControlConfig{Command: "missing-kwwk-helper"},
		},
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		Runner: runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a circle without telling me which tool to use","executionMode":"delegate","wait":true}`, http.StatusOK)

	if body["ok"] != true || body["provider"] != "codex" || body["summary"] != "Explored Pencil and drew a circle." {
		t.Fatalf("body = %#v, want instruction-only app-control goal handled by Computer Use executor", body)
	}
	if runner.startCount != 1 {
		t.Fatalf("startCount = %d, want 1", runner.startCount)
	}
	if _, ok := runner.startInput.Context["operations"]; ok {
		t.Fatalf("context = %#v, natural-language app-control goals must not require primitive operations", runner.startInput.Context)
	}
	if runner.startInput.Context["execution_mode"] != appControlExecutionModeDelegate {
		t.Fatalf("context = %#v, want explicit delegate execution mode", runner.startInput.Context)
	}
}

func TestRealtimeSharedAppControlDirectConfiguredKWWKDoesNotStartCodexExecutor(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_should_not_start",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true}`,
		},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		AppControl: appconfig.AppControlConfig{
			Provider:      "kwwk",
			CodexFallback: false,
		},
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		Runner: runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a circle without telling me which tool to use","executionMode":"direct","wait":true}`, http.StatusOK)

	if body["ok"] != false || body["provider"] != "kwwk" || body["error"] != "kwwk_app_control_unconfigured" {
		t.Fatalf("body = %#v, want direct KWWK blocker without Codex fallback", body)
	}
	if runner.startCount != 0 {
		t.Fatalf("startCount = %d, want direct mode to skip Codex executor", runner.startCount)
	}
}

func TestRealtimeSharedAppControlRoutesKWWKBackgroundAgentPlanToCodexExecutor(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_app_control_background_agent",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true,"summary":"Updated the shared roadmap document.","actions":["observed document","planned sections","edited roadmap","verified text"],"confidence":0.86,"blocker":""}`,
		},
	}
	primary := &fakeAppControlBackend{
		name: "kwwk",
		result: AppControlResult{
			OK:       false,
			Provider: "kwwk",
			Status:   "needs_background_agent",
			Error:    "app_control_blocked",
			Blocker:  "needs_background_agent",
			Summary:  "background agent required for multi-step app task",
		},
	}
	rootDir := t.TempDir()
	service := NewService(Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: primary,
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel: "gpt-realtime-2",
			BotName:       "Meeting Avatar Bot",
		},
		Runner: runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Docs",
					"title":           "Product Roadmap",
					"windowId":        221,
				},
			},
		},
	})
	service.appControlBackend = NewFallbackAppControlBackend(primary, NewCodexAppControlBackend(service))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = service.Shutdown(ctx)
	})

	if _, err := service.JoinGoogleMeet(context.Background(), JoinGoogleMeetRequest{
		SessionID:   "meet_session",
		MeetingURL:  "https://meet.google.com/abc-defg-hij",
		DisplayName: "Onee-sama",
		DryRun:      true,
	}); err != nil {
		t.Fatalf("JoinGoogleMeet() error = %v", err)
	}
	body := service.ControlRealtimeSharedApp(context.Background(), RealtimeSharedAppControlRequest{
		SessionID:       "meet_session",
		ApplicationName: "Docs",
		Instruction:     "redesign the product roadmap in the shared document",
		ExecutionMode:   "direct",
		Wait:            true,
	})

	if body["ok"] != true || body["provider"] != "codex" || body["summary"] != "Updated the shared roadmap document." {
		t.Fatalf("body = %#v, want KWWK needs_background_agent routed to Codex executor", body)
	}
	if primary.requestCount() != 1 || runner.startCount != 1 {
		t.Fatalf("primary requests=%d startCount=%d, want one KWWK plan then one Codex executor", primary.requestCount(), runner.startCount)
	}
	if !strings.Contains(runner.startInput.Task, "redesign the product roadmap") || !strings.Contains(runner.startInput.Task, "Docs") {
		t.Fatalf("task prompt = %q, want original instruction and app target", runner.startInput.Task)
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindMeetingAppControl {
		t.Fatalf("context = %#v, want meeting app control session kind", runner.startInput.Context)
	}
}

func TestRealtimeSharedAppControlCompactsRuntimeStatusForComputerUse(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_app_control_compact",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true,"summary":"Closed the prompt.","actions":["observed Chrome","clicked Got it"],"confidence":0.9,"blocker":""}`,
		},
	}
	hugeTimeline := strings.Repeat("hugeTimelineToken", 5000)
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI:           appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		Runner:           runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Chrome",
					"title":           "Chrome",
					"subtitle":        "共享 Chrome 窗口",
					"imageUrl":        "http://127.0.0.1/screen-share.mjpg",
					"windowId":        2190,
					"processId":       72417,
				},
				"realtimeBridge": map[string]any{
					"timeline": hugeTimeline,
					"connection": map[string]any{
						"sentDataChannelMessages": hugeTimeline,
					},
				},
				"captions": map[string]any{
					"latest": map[string]any{"text": hugeTimeline},
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Chrome","instruction":"点击 Got it 关闭提示","executionMode":"delegate","wait":true}`, http.StatusOK)

	if body["ok"] != true {
		t.Fatalf("body = %#v, want app-control success", body)
	}
	if strings.Contains(runner.startInput.Task, "hugeTimelineToken") || len(runner.startInput.Task) > 12000 {
		t.Fatalf("task length=%d contains huge runtime status: %.200q", len(runner.startInput.Task), runner.startInput.Task)
	}
	screenShareStatus, ok := runner.startInput.Context["screen_share_status"].(map[string]any)
	if !ok {
		t.Fatalf("context = %#v, want compact screen_share_status", runner.startInput.Context)
	}
	if _, ok := screenShareStatus["realtimeBridge"]; ok {
		t.Fatalf("screen_share_status = %#v, must not include realtimeBridge", screenShareStatus)
	}
	if screenShareStatus["applicationName"] != "Chrome" || screenShareStatus["windowId"] != 2190.0 && screenShareStatus["windowId"] != 2190 {
		t.Fatalf("screen_share_status = %#v, want compact target fields", screenShareStatus)
	}
	screenShareResult := body["screenShare"].(map[string]any)
	if _, ok := screenShareResult["realtimeBridge"]; ok {
		t.Fatalf("body screenShare = %#v, must not expose full runtime state", screenShareResult)
	}
	if activeMap, ok := screenShareResult["active"].(map[string]any); ok {
		if _, ok := activeMap["realtimeBridge"]; ok {
			t.Fatalf("body screenShare = %#v, must not expose full runtime state", screenShareResult)
		}
	}
}

func TestRealtimeSharedAppControlRejectsStandaloneToolBypass(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_standalone_app_control",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":true,"summary":"Observed the Pencil canvas without changing it.","actions":["observed Pencil window","verified no mutation"],"confidence":0.9,"blocker":""}`,
		},
	}
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
		Runner: runner,
	})

	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"standalone":true,"session_id":"cu_case_probe_1","applicationName":"Pencil","instruction":"only observe Pencil; do not edit anything","executionMode":"delegate","wait":true}`, http.StatusOK)

	if body["ok"] != false || body["error"] != "standalone_app_control_not_allowed" {
		t.Fatalf("body = %#v, want standalone_app_control_not_allowed", body)
	}
	if runner.startCount != 0 {
		t.Fatalf("startCount = %d, want standalone bypass to skip app-control executor", runner.startCount)
	}
}

func TestRealtimeSharedAppControlRejectsStandaloneBeforeTargetValidation(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2"})
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"standalone":true,"instruction":"observe the active app"}`, http.StatusOK)
	if body["ok"] != false || body["error"] != "standalone_app_control_not_allowed" {
		t.Fatalf("body = %#v, want standalone_app_control_not_allowed", body)
	}
}

func TestRealtimeSharedAppControlPropagatesWorkerBlocker(t *testing.T) {
	t.Parallel()

	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_app_control_blocked",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"ok":false,"summary":"Pencil is shared but no Computer Use tool is available.","actions":["verified target"],"confidence":1,"blocker":"computer_use_unavailable"}`,
		},
	}
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
		Runner: runner,
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas","executionMode":"delegate","wait":true}`, http.StatusOK)

	if body["ok"] != false || body["error"] != "app_control_blocked" || body["blocker"] != "computer_use_unavailable" {
		t.Fatalf("body = %#v, want worker blocker surfaced", body)
	}
	if body["displayText"] != "操作失败" || body["answer_hint_zh"] != "操作失败" {
		t.Fatalf("body = %#v, want compact human-facing blocker wording", body)
	}
}

func TestAppControlResultMapAddsCompactFailureWording(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		status   string
		blocker  string
		error    string
		expected string
	}{
		{name: "ambiguous", status: "blocked", blocker: "blocked_ambiguous_target", expected: "目标不明确"},
		{name: "permission", status: "blocked", blocker: "blocked_permission", expected: "需要权限"},
		{name: "no target", status: "blocked", blocker: "blocked_no_target_app", expected: "找不到窗口"},
		{name: "unsupported", status: "blocked", blocker: "blocked_unsupported_instruction", expected: "暂不支持"},
		{name: "background", status: "needs_background_agent", blocker: "needs_background_agent", expected: "交给后台"},
		{name: "execution", status: "failed", blocker: "failed_execution", expected: "操作失败"},
		{name: "verification", status: "failed", blocker: "failed_verification", expected: "验证失败"},
		{name: "timeout", status: string(agentrunner.StatusTimeout), expected: "操作失败"},
		{name: "error fallback", status: "failed", error: "app_control_blocked", expected: "操作失败"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			out := appControlResultMap(AppControlResult{
				OK:       false,
				Provider: "kwwk",
				Status:   testCase.status,
				Blocker:  testCase.blocker,
				Error:    testCase.error,
			}, map[string]any{"active": true})

			if out["blocker"] != testCase.blocker && testCase.blocker != "" {
				t.Fatalf("out = %#v, must preserve machine-readable blocker", out)
			}
			if out["displayText"] != testCase.expected || out["answer_hint_zh"] != testCase.expected {
				t.Fatalf("out = %#v, want compact wording %q", out, testCase.expected)
			}
		})
	}
}

func TestRealtimeSharedAppControlStripsStaleOperationsWithWindowTarget(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{
		name: "kwwk",
		result: AppControlResult{
			OK:       true,
			Provider: "kwwk",
			Status:   appControlStatusCompleted,
			Summary:  "updated the shared Pencil canvas",
			Actions:  []string{"state", "click", "type_text", "drag"},
			Raw: map[string]any{
				"operations": []KWWKAppControlOperation{
					{Kind: KWWKAppControlState},
					{Kind: KWWKAppControlClick, X: 120, Y: 80},
					{Kind: KWWKAppControlTypeText, Text: "snake"},
					{Kind: KWWKAppControlDrag, FromX: 140, FromY: 120, ToX: 220, ToY: 120},
				},
				"metadata": map[string]any{
					"method": "kwwk.test",
					"tags":   []any{"kept"},
					"events": []any{
						map[string]any{"type": "diagnostic", "message": "kept"},
					},
				},
			},
		},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
					"windowId":        991,
					"processId":       4242,
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","instruction":"draw a snake mockup","wait":true,"operations":[{"kind":"state"},{"kind":"click","x":120,"y":80},{"kind":"type_text","text":"snake"},{"kind":"drag","from_x":140,"from_y":120,"to_x":220,"to_y":120}],"context":{"operations":[{"kind":"click","x":1,"y":2}]}}`, http.StatusOK)

	if body["ok"] != true || body["provider"] != "kwwk" || body["summary"] != "updated the shared Pencil canvas" {
		t.Fatalf("body = %#v, want KWWK backend success", body)
	}
	if len(backend.requests) != 1 {
		t.Fatalf("backend requests = %d, want 1", len(backend.requests))
	}
	req := backend.requests[0]
	if req.Target.WindowID != 991 || req.Target.ProcessID != 4242 || req.Target.ApplicationName != "Pencil" {
		t.Fatalf("target = %#v, want explicit shared Pencil window target", req.Target)
	}
	if req.Instruction != "draw a snake mockup" {
		t.Fatalf("instruction = %q, want preserved user instruction", req.Instruction)
	}
	if len(req.Operations) != 0 {
		t.Fatalf("operations = %#v, want stale foreground operations stripped", req.Operations)
	}
	if _, ok := req.Context["operations"]; ok {
		t.Fatalf("context = %#v, want context operations stripped", req.Context)
	}
	backendResult, ok := body["backendResult"].(map[string]any)
	if !ok {
		t.Fatalf("backendResult = %#v, want sanitized map", body["backendResult"])
	}
	if _, ok := backendResult["operations"]; ok {
		t.Fatalf("backendResult = %#v, want raw operations suppressed", backendResult)
	}
	if backendResult["operationsSuppressed"] != float64(4) {
		t.Fatalf("backendResult = %#v, want suppressed operation count", backendResult)
	}
	metadata, ok := backendResult["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("backendResult = %#v, want metadata preserved", backendResult)
	}
	tags, ok := metadata["tags"].([]any)
	if !ok || len(tags) != 1 || tags[0] != "kept" {
		t.Fatalf("metadata = %#v, want tag array preserved", metadata)
	}
	events, ok := metadata["events"].([]any)
	if !ok || len(events) != 1 {
		t.Fatalf("metadata = %#v, want event array preserved", metadata)
	}
	event, ok := events[0].(map[string]any)
	if !ok || event["type"] != "diagnostic" || event["message"] != "kept" {
		t.Fatalf("events = %#v, want non-operation event map preserved", events)
	}
}

func TestRealtimeSharedAppControlBackendUnavailableFailsFast(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{name: "kwwk", err: errors.New("kwwk_backend_unavailable")}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	start := time.Now()
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","timeoutMs":5000,"instruction":"draw a snake mockup","wait":true}`, http.StatusOK)
	elapsed := time.Since(start)

	if body["ok"] != false || body["error"] != "kwwk_backend_unavailable" || body["provider"] != "kwwk" {
		t.Fatalf("body = %#v, want backend unavailable surfaced", body)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("elapsed = %s, want fail-fast under 2s", elapsed)
	}
}

func TestRealtimeSharedAppControlQueuesByDefaultAndStatusCompletes(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{
		delay:  150 * time.Millisecond,
		name:   "kwwk",
		result: AppControlResult{OK: true, Provider: "kwwk", Status: appControlStatusCompleted, Summary: "queued job finished"},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	start := time.Now()
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a snake mockup"}`, http.StatusOK)
	elapsed := time.Since(start)

	if body["ok"] != true || body["status"] != appControlStatusQueued || strings.TrimSpace(stringFromAny(body["job_id"])) == "" {
		t.Fatalf("body = %#v, want queued app-control job", body)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("elapsed = %s, want queued response before backend delay", elapsed)
	}
	jobID := stringFromAny(body["job_id"])
	var status map[string]any
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		status = performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"job_id":"`+jobID+`"}`, http.StatusOK)
		if status["status"] == appControlStatusCompleted {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status["status"] != appControlStatusCompleted {
		t.Fatalf("status = %#v, want completed queued job", status)
	}
	result := status["result"].(map[string]any)
	if result["summary"] != "queued job finished" {
		t.Fatalf("result = %#v, want backend result on queued job", result)
	}
	poll := performRealtimeJSON(t, router, http.MethodPost, "/worker/poll-realtime", `{"sessionId":"meet_session","markDelivered":false}`, http.StatusOK)
	jobs := poll["jobs"].([]any)
	if len(jobs) != 1 {
		t.Fatalf("poll = %#v, want one app-control completion event", poll)
	}
	report := jobs[0].(map[string]any)
	if report["id"] != jobID || report["status"] != appControlStatusCompleted {
		t.Fatalf("report = %#v, want completed app-control report for queued job", report)
	}
	context := report["context"].(map[string]any)
	if context["session_kind"] != "meeting_app_control" || context["meeting_session_id"] != "meet_session" {
		t.Fatalf("context = %#v, want meeting app-control session scope", context)
	}
	if got := backend.requestCount(); got != 1 {
		t.Fatalf("backend requests = %d, want 1", got)
	}
}

func TestQueuedAppControlWorkerReportResetsRealtimeDeliveryOnTerminalRewrite(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	service := NewService(Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI:           appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = service.Shutdown(ctx)
	})

	ctx := context.Background()
	jobID := "app_control_collision"
	_, err := service.createWorkerReport(ctx, WorkerReportInput{
		ID:       jobID,
		Status:   appControlStatusCompleted,
		Provider: "kwwk",
		Mode:     "app_control",
		Task:     "old app-control report",
		Context: map[string]any{
			"session_kind":       "meeting_app_control",
			"meeting_session_id": "meet_session",
			"source":             "meeting-realtime-shared-app-control",
			"app_control_job_id": jobID,
		},
		Result: `{"summary":"old delivered result"}`,
	})
	if err != nil {
		t.Fatalf("createWorkerReport() error = %v", err)
	}
	if _, err := service.markWorkerDelivered(ctx, jobID, true, DeliveryMeta{Channel: "test_realtime"}); err != nil {
		t.Fatalf("markWorkerDelivered() error = %v", err)
	}

	service.reportQueuedAppControlJob(ctx, appControlJob{
		ID:          jobID,
		Provider:    "kwwk",
		SessionID:   "meet_session",
		Instruction: "Click Chromium",
		Status:      appControlStatusCompleted,
		Result: map[string]any{
			"ok":      true,
			"status":  appControlStatusCompleted,
			"summary": "clicked Chromium",
			"actions": []string{"click"},
			"backendResult": map[string]any{
				"metadata": map[string]any{
					"cursor": map[string]any{
						"schema": "oneesama.kwwk-cursor-events.v1",
						"events": []any{
							map[string]any{"kind": "cursor.click", "x": 0.42, "y": 0.24},
						},
					},
				},
			},
		},
	})

	markDelivered := false
	reports, err := service.pollReadyWorkerReports(ctx, true, WorkerPollRequest{
		SessionID:     "meet_session",
		MarkDelivered: &markDelivered,
	})
	if err != nil {
		t.Fatalf("pollReadyWorkerReports() error = %v", err)
	}
	if len(reports) != 1 {
		t.Fatalf("reports = %#v, want rewritten app-control report ready for realtime", reports)
	}
	report := reports[0]
	if report.ID != jobID || report.Status != appControlStatusCompleted || report.DeliveredToRealtime {
		t.Fatalf("report = %#v, want completed undelivered app-control report", report)
	}
	if report.RealtimeDelivery != nil || report.RealtimeSuppressed {
		t.Fatalf("report = %#v, want previous realtime delivery state reset", report)
	}
	if report.RealtimeDeliveryAttempt == nil || report.RealtimeDeliveryAttempt.SessionID != "meet_session" {
		t.Fatalf("report = %#v, want poll delivery attempt scoped to meet session", report)
	}
	if report.ResultEnvelope == nil || !strings.Contains(report.ResultEnvelope.Result, "cursor.click") {
		t.Fatalf("result envelope = %#v, want cursor metadata in terminal app-control result", report.ResultEnvelope)
	}
}

func TestRealtimeSharedAppControlQueuedTimeoutReportsFailed(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{
		name:   "kwwk",
		result: AppControlResult{OK: false, Provider: "kwwk", Status: string(agentrunner.StatusTimeout)},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Chrome",
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Chrome","instruction":"click Got it"}`, http.StatusOK)
	jobID := stringFromAny(body["job_id"])
	if strings.TrimSpace(jobID) == "" {
		t.Fatalf("body = %#v, want queued app-control job", body)
	}

	var status map[string]any
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		status = performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"job_id":"`+jobID+`"}`, http.StatusOK)
		if status["status"] == string(agentrunner.StatusTimeout) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status["status"] != string(agentrunner.StatusTimeout) || status["ok"] != false || status["error"] != "app_control_timeout" {
		t.Fatalf("status = %#v, want timeout app-control job with explicit error", status)
	}

	var poll map[string]any
	var jobs []any
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		poll = performRealtimeJSON(t, router, http.MethodPost, "/worker/poll-realtime", `{"sessionId":"meet_session","markDelivered":false}`, http.StatusOK)
		jobs = poll["jobs"].([]any)
		if len(jobs) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(jobs) != 1 {
		t.Fatalf("poll = %#v, want one app-control timeout event", poll)
	}
	report := jobs[0].(map[string]any)
	if report["id"] != jobID || report["status"] != appControlStatusFailed || report["error"] != "app_control_timeout" {
		t.Fatalf("report = %#v, want failed app-control timeout report", report)
	}
}

func TestQueuedAppControlWorkerStatusOnlyTreatsExplicitSuccessAsCompleted(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		job        appControlJob
		wantStatus string
		wantOK     bool
	}{
		{
			name:       "completed",
			job:        appControlJob{Status: appControlStatusCompleted},
			wantStatus: appControlStatusCompleted,
			wantOK:     true,
		},
		{
			name:       "done alias",
			job:        appControlJob{Status: "done"},
			wantStatus: appControlStatusCompleted,
			wantOK:     true,
		},
		{
			name:       "failed",
			job:        appControlJob{Status: appControlStatusFailed, Error: "backend_failed"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "blocked",
			job:        appControlJob{Status: "blocked", Blocker: "permission_required"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "error",
			job:        appControlJob{Status: "error", Error: "unexpected_error"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "timeout",
			job:        appControlJob{Status: string(agentrunner.StatusTimeout), Error: "app_control_timeout"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "stale",
			job:        appControlJob{Status: "stale"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "unknown terminal",
			job:        appControlJob{Status: "weird_terminal_state"},
			wantStatus: appControlStatusFailed,
			wantOK:     false,
		},
		{
			name:       "queued",
			job:        appControlJob{Status: appControlStatusQueued},
			wantStatus: "",
			wantOK:     true,
		},
		{
			name:       "running",
			job:        appControlJob{Status: appControlStatusRunning},
			wantStatus: "",
			wantOK:     true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := queuedAppControlWorkerStatus(tc.job); got != tc.wantStatus {
				t.Fatalf("queuedAppControlWorkerStatus(%#v) = %q, want %q", tc.job, got, tc.wantStatus)
			}
			if got := appControlJobMap(tc.job)["ok"]; got != tc.wantOK {
				t.Fatalf("appControlJobMap(%#v)[ok] = %#v, want %#v", tc.job, got, tc.wantOK)
			}
		})
	}
}

func TestRealtimeSharedAppControlRejectsOperationsWithoutInstruction(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{
		name:   "kwwk",
		result: AppControlResult{OK: true, Provider: "kwwk", Status: appControlStatusCompleted, Summary: "state captured", Actions: []string{"state"}},
	}
	rootDir := t.TempDir()
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		AppControlBackend: backend,
		OpenAI:            appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2", BotName: "Meeting Avatar Bot"},
		MeetRunner: fakeMeetRunnerWithRuntime{
			statusActive: map[string]any{
				"sessionId": "meet_session",
				"screenShare": map[string]any{
					"active":          true,
					"applicationName": "Pencil",
					"windowId":        991,
				},
			},
		},
	})

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","operations":[{"kind":"state"}],"wait":true}`, http.StatusOK)

	if body["ok"] != false || body["error"] != "instruction_required" {
		t.Fatalf("body = %#v, want instruction_required", body)
	}
	if backend.requestCount() != 0 {
		t.Fatalf("backend requests = %d, want 0", backend.requestCount())
	}
}

func TestRealtimeSharedAppControlRequiresInstruction(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{RealtimeModel: "gpt-realtime-2"})
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"applicationName":"Pencil"}`, http.StatusOK)
	if body["ok"] != false || body["error"] != "instruction_required" {
		t.Fatalf("body = %#v, want instruction_required", body)
	}
}

type fakeAppControlBackend struct {
	mu       sync.Mutex
	name     string
	result   AppControlResult
	err      error
	delay    time.Duration
	requests []AppControlRequest
}

func (f *fakeAppControlBackend) Name() string {
	if strings.TrimSpace(f.name) == "" {
		return "fake"
	}
	return f.name
}

func (f *fakeAppControlBackend) ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error) {
	if err := ctx.Err(); err != nil {
		return AppControlResult{}, err
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return AppControlResult{}, ctx.Err()
		}
	}
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	if f.err != nil {
		return AppControlResult{}, f.err
	}
	result := f.result
	if strings.TrimSpace(result.Provider) == "" {
		result.Provider = f.Name()
	}
	return result, nil
}

func (f *fakeAppControlBackend) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

var _ meetrunner.Runner = fakeMeetRunnerWithRuntime{}
