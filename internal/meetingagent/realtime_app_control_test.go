package meetingagent

import (
	"net/http"
	"strings"
	"testing"

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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas"}`, http.StatusOK)

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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas"}`, http.StatusOK)

	if body["ok"] != false || body["error"] != "app_control_blocked" || body["blocker"] != "computer_use_unavailable" {
		t.Fatalf("body = %#v, want worker blocker surfaced", body)
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

var _ meetrunner.Runner = fakeMeetRunnerWithRuntime{}
