package meetingagent

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

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
			ExposeRealtimeTools:  true,
			Mode:                 "safe",
			Adapter:              "fake",
			RootDir:              rootDir + "/demo-surfaces",
			URLAllowlistPatterns: []string{"https://example.test/"},
			DryRun:               true,
		},
	})

	configBody := performRealtimeJSON(t, router, http.MethodGet, "/realtime/config", "", http.StatusOK)
	if !toolNamesInclude(configBody["tools"].([]any), "create_shared_workspace") {
		t.Fatalf("tools = %#v, want demo execution tool when Realtime demo surface tools are exposed", configBody["tools"])
	}
	if !strings.Contains(stringFromAny(configBody["instructions"]), "做一个贪吃蛇") ||
		!strings.Contains(stringFromAny(configBody["instructions"]), "create a shared workspace") ||
		!strings.Contains(stringFromAny(configBody["instructions"]), "共享 VS Code 屏幕") ||
		!strings.Contains(stringFromAny(configBody["instructions"]), "把 Pencil 共享一下") ||
		!strings.Contains(stringFromAny(configBody["instructions"]), "用编辑器演示") {
		t.Fatalf("instructions = %q, want semantic shared-workspace routing examples", stringFromAny(configBody["instructions"]))
	}

	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_screen_share_bridge":true}`, http.StatusOK)

	startBody := performRealtimeJSON(t, router, http.MethodPost, "/tools/create_shared_workspace", `{"session_id":"meet_session","demo_session_id":"snake_demo","task":"做一个贪吃蛇，然后给我看屏幕，不要先讲规划","task_url":"https://example.test/tasks/snake","demo_url":"https://example.test/tasks/snake","issue_id":"MOCK-1","request_issue_close":true,"user_instruction":"短一点，进度走屏幕"}`, http.StatusOK)
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
			ExposeRealtimeTools:  true,
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
	router.ServeHTTP(start, realtimeRequest(http.MethodPost, "/tools/open_shared_browser_surface", `{"session_id":"meet_session","demo_session_id":"demo_codex_flag","url":"https://example.test/demo","goal":"show it"}`))
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
