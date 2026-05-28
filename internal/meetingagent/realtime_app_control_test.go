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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas","wait":true}`, http.StatusOK)

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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","applicationName":"Pencil","instruction":"draw a small circle in the canvas","wait":true}`, http.StatusOK)

	if body["ok"] != false || body["error"] != "app_control_blocked" || body["blocker"] != "computer_use_unavailable" {
		t.Fatalf("body = %#v, want worker blocker surfaced", body)
	}
}

func TestRealtimeSharedAppControlUsesInjectedKWWKBackendWithWindowTarget(t *testing.T) {
	t.Parallel()

	backend := &fakeAppControlBackend{
		name: "kwwk",
		result: AppControlResult{
			OK:       true,
			Provider: "kwwk",
			Status:   appControlStatusCompleted,
			Summary:  "updated the shared Pencil canvas",
			Actions:  []string{"state", "click", "type_text", "drag"},
			Raw: []KWWKAppControlOperation{
				{Kind: KWWKAppControlState},
				{Kind: KWWKAppControlClick, X: 120, Y: 80},
				{Kind: KWWKAppControlTypeText, Text: "snake"},
				{Kind: KWWKAppControlDrag, FromX: 140, FromY: 120, ToX: 220, ToY: 120},
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
	body := performRealtimeJSON(t, router, http.MethodPost, "/tools/control_shared_app_window", `{"session_id":"meet_session","instruction":"draw a snake mockup","wait":true,"operations":[{"kind":"state"},{"kind":"click","x":120,"y":80},{"kind":"type_text","text":"snake"},{"kind":"drag","from_x":140,"from_y":120,"to_x":220,"to_y":120}]}`, http.StatusOK)

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
	if len(req.Operations) != 4 || req.Operations[1].Kind != KWWKAppControlClick || req.Operations[2].Text != "snake" {
		t.Fatalf("operations = %#v, want structured app-control operations forwarded", req.Operations)
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

func TestRealtimeSharedAppControlAllowsStructuredOperationsWithoutInstruction(t *testing.T) {
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

	if body["ok"] != true || body["summary"] != "state captured" {
		t.Fatalf("body = %#v, want operations-only app-control success", body)
	}
	if backend.requestCount() != 1 {
		t.Fatalf("backend requests = %d, want 1", backend.requestCount())
	}
	if got := backend.requests[0].Instruction; got != "execute structured app-control operations" {
		t.Fatalf("instruction = %q, want synthesized operations instruction", got)
	}
	if len(backend.requests[0].Operations) != 1 || backend.requests[0].Operations[0].Kind != KWWKAppControlState {
		t.Fatalf("operations = %#v, want state operation forwarded", backend.requests[0].Operations)
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
