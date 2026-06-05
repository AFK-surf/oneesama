package meetingagent

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type recordingRealtimeJoinMeetRunner struct {
	fakeMeetRunner
	input meetrunner.PrepareGoogleMeetInput
}

func (r *recordingRealtimeJoinMeetRunner) PrepareGoogleMeet(ctx context.Context, input meetrunner.PrepareGoogleMeetInput) (meetrunner.PrepareGoogleMeetResult, error) {
	r.input = input
	return r.fakeMeetRunner.PrepareGoogleMeet(ctx, input)
}

type startedRealtimeJoinMeetRunner struct {
	fakeMeetRunner
}

func (r startedRealtimeJoinMeetRunner) PrepareGoogleMeet(ctx context.Context, input meetrunner.PrepareGoogleMeetInput) (meetrunner.PrepareGoogleMeetResult, error) {
	result, err := r.fakeMeetRunner.PrepareGoogleMeet(ctx, input)
	result.Started = true
	result.Session.Status = joinSessionStatusString(joinSessionStatusJoined)
	return result, err
}

type recordingPrewarmAppControlBackend struct {
	calls chan AppControlPrewarmRequest
}

func newRecordingPrewarmAppControlBackend() *recordingPrewarmAppControlBackend {
	return &recordingPrewarmAppControlBackend{calls: make(chan AppControlPrewarmRequest, 16)}
}

func (b *recordingPrewarmAppControlBackend) Name() string {
	return "kwwk"
}

func (b *recordingPrewarmAppControlBackend) ControlSharedApp(context.Context, AppControlRequest) (AppControlResult, error) {
	return AppControlResult{OK: true, Provider: "kwwk", Status: appControlStatusCompleted, Summary: "ok"}, nil
}

func (b *recordingPrewarmAppControlBackend) PrewarmAppControl(_ context.Context, req AppControlPrewarmRequest) AppControlPrewarmResult {
	b.calls <- req
	now := time.Now().UTC()
	return AppControlPrewarmResult{
		OK:         true,
		Provider:   "kwwk",
		Status:     "ready",
		StartedAt:  now,
		FinishedAt: now.Add(time.Millisecond),
		Duration:   time.Millisecond,
		Evidence: map[string]any{
			"ping": map[string]any{"ok": true, "status": "ready"},
		},
	}
}

func TestJoinRealtimeUsesServerCanonicalToolSurface(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel:          "gpt-realtime-2",
			RealtimeVoice:          "marin",
			RealtimeTurnDetection:  "fast",
			RealtimeSessionSchema:  "realtime-2",
			BotName:                "Meeting Avatar Bot",
			CurrentUserEnglishName: "Peng Xiao",
		},
		MeetRunner: runner,
	})

	configBody := performRealtimeJSON(t, router, http.MethodGet, "/realtime/config", "", http.StatusOK)
	canonicalTools := configBody["tools"].([]any)
	performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_realtime_bridge":true,"auto_connect_realtime":true}`, http.StatusOK)

	if len(runner.input.RealtimeTools) != len(canonicalTools) {
		t.Fatalf("forwarded tools = %d, want canonical config tools %d", len(runner.input.RealtimeTools), len(canonicalTools))
	}
	forwardedTools := realtimeToolMapsAsAny(runner.input.RealtimeTools)
	if !toolNamesInclude(forwardedTools, "delegate_to_worker", "share_existing_app_window", "kwwk_computer_use", "now") {
		t.Fatalf("forwarded tools = %#v, missing canonical core tools", forwardedTools)
	}
	if toolNamesInclude(forwardedTools, "control_shared_app_window") {
		t.Fatalf("forwarded tools = %#v, compatibility app-control alias must not be forwarded by default", forwardedTools)
	}
	if toolNamesInclude(forwardedTools, "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface") {
		t.Fatalf("forwarded tools = %#v, meet runtime must not use demo/browser tool surface by default", forwardedTools)
	}
	if !strings.Contains(runner.input.RealtimeInstructions, "low-latency AI meeting avatar") ||
		!strings.Contains(runner.input.RealtimeInstructions, "share_existing_app_window") {
		t.Fatalf("forwarded instructions = %q, want canonical realtime instructions", runner.input.RealtimeInstructions)
	}
	sessionTools, ok := runner.input.RealtimeSession["tools"].([]map[string]any)
	if !ok {
		t.Fatalf("session tools type = %T, want []map[string]any", runner.input.RealtimeSession["tools"])
	}
	if len(sessionTools) != len(canonicalTools) ||
		toolNamesInclude(realtimeToolMapsAsAny(sessionTools), "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface") {
		t.Fatalf("session tools = %#v, want same hidden-demo canonical surface", sessionTools)
	}
}

func TestJoinRealtimeDefaultsParticipantAudioForAutoConnect(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetRunner:       runner,
	})

	response := performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_audio_default","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_realtime_bridge":true,"auto_connect_realtime":true}`, http.StatusOK)

	if !runner.input.IncludeParticipantAudio || !runner.input.ForwardMeetAudioToRealtime {
		t.Fatalf("runner input audio flags = include:%t forward:%t, want true/true", runner.input.IncludeParticipantAudio, runner.input.ForwardMeetAudioToRealtime)
	}
	plan := response["plan"].(map[string]any)
	if plan["include_participant_audio"] != true || plan["forward_meet_audio_to_realtime"] != true {
		t.Fatalf("plan audio flags = %#v, want default true/true", plan)
	}
	session := response["session"].(map[string]any)
	metadata := session["metadata"].(map[string]any)
	if metadata["include_participant_audio"] != true || metadata["forward_meet_audio_to_realtime"] != true {
		t.Fatalf("metadata audio flags = %#v, want default true/true", metadata)
	}
}

func TestJoinRealtimePreservesExplicitAudioDisable(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetRunner:       runner,
	})

	response := performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_audio_disabled","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_realtime_bridge":true,"auto_connect_realtime":true,"include_participant_audio":false,"forward_meet_audio_to_realtime":false}`, http.StatusOK)

	if runner.input.IncludeParticipantAudio || runner.input.ForwardMeetAudioToRealtime {
		t.Fatalf("runner input audio flags = include:%t forward:%t, want false/false", runner.input.IncludeParticipantAudio, runner.input.ForwardMeetAudioToRealtime)
	}
	plan := response["plan"].(map[string]any)
	if plan["include_participant_audio"] != nil || plan["forward_meet_audio_to_realtime"] != nil {
		t.Fatalf("plan audio flags = %#v, want omitted false fields", plan)
	}
	session := response["session"].(map[string]any)
	metadata := session["metadata"].(map[string]any)
	if metadata["include_participant_audio"] != false || metadata["forward_meet_audio_to_realtime"] != false {
		t.Fatalf("metadata audio flags = %#v, want explicit false/false", metadata)
	}
}

func TestJoinGoogleMeetForwardsBrowserProfileOptions(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetRunner:       runner,
	})

	performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_profile","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true,"meet_profile_mode":"persistent","browser_user_data_dir":"/tmp/oneesama-profile","meet_ui_interaction_mode":"humanized","meet_join_lane":"macos_test_humanized","meet_browser_control_mode":"playwright"}`, http.StatusOK)

	if runner.input.MeetProfileMode != "persistent" {
		t.Fatalf("MeetProfileMode = %q, want persistent", runner.input.MeetProfileMode)
	}
	if runner.input.BrowserUserDataDir != "/tmp/oneesama-profile" {
		t.Fatalf("BrowserUserDataDir = %q, want /tmp/oneesama-profile", runner.input.BrowserUserDataDir)
	}
	if runner.input.MeetUIInteractionMode != "humanized" {
		t.Fatalf("MeetUIInteractionMode = %q, want humanized", runner.input.MeetUIInteractionMode)
	}
	if runner.input.MeetJoinLane != "macos_test_humanized" {
		t.Fatalf("MeetJoinLane = %q, want macos_test_humanized", runner.input.MeetJoinLane)
	}
	if runner.input.MeetBrowserControlMode != "playwright" {
		t.Fatalf("MeetBrowserControlMode = %q, want playwright", runner.input.MeetBrowserControlMode)
	}
}

func TestJoinGoogleMeetDefaultsRealtimeGuestToPlaywrightControl(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetRunner:       runner,
	})

	response := performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_default_playwright","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true,"install_realtime_bridge":true,"auto_connect_realtime":true}`, http.StatusOK)

	if runner.input.MeetBrowserControlMode != "playwright" {
		t.Fatalf("MeetBrowserControlMode = %q, want playwright", runner.input.MeetBrowserControlMode)
	}
	if runner.input.MeetUIInteractionMode != "humanized" {
		t.Fatalf("MeetUIInteractionMode = %q, want humanized", runner.input.MeetUIInteractionMode)
	}
	plan := response["plan"].(map[string]any)
	if plan["meet_browser_control_mode"] != "playwright" {
		t.Fatalf("plan meet_browser_control_mode = %#v, want playwright", plan["meet_browser_control_mode"])
	}
	if plan["meet_ui_interaction_mode"] != "humanized" {
		t.Fatalf("plan meet_ui_interaction_mode = %#v, want humanized", plan["meet_ui_interaction_mode"])
	}
	session := response["session"].(map[string]any)
	metadata := session["metadata"].(map[string]any)
	if metadata["meet_browser_control_mode"] != "playwright" {
		t.Fatalf("metadata meet_browser_control_mode = %#v, want playwright", metadata["meet_browser_control_mode"])
	}
	if metadata["meet_ui_interaction_mode"] != "humanized" {
		t.Fatalf("metadata meet_ui_interaction_mode = %#v, want humanized", metadata["meet_ui_interaction_mode"])
	}
}

func TestJoinGoogleMeetForwardsRetryPolicyNone(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetRunner:       runner,
	})

	response := performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_no_retry","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true,"retry_policy":"none"}`, http.StatusOK)

	if runner.input.RetryPolicy != "none" {
		t.Fatalf("RetryPolicy = %q, want none", runner.input.RetryPolicy)
	}
	plan := response["plan"].(map[string]any)
	if plan["retry_policy"] != "none" {
		t.Fatalf("plan retry_policy = %#v, want none", plan["retry_policy"])
	}
	session := response["session"].(map[string]any)
	metadata := session["metadata"].(map[string]any)
	if metadata["retry_policy"] != "none" {
		t.Fatalf("metadata retry_policy = %#v, want none", metadata["retry_policy"])
	}
}

func TestJoinGoogleMeetMergesRealtimeSessionOverride(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	runner := &recordingRealtimeJoinMeetRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		OpenAI: appconfig.OpenAIConfig{
			RealtimeModel:         "gpt-realtime-2",
			RealtimeVoice:         "marin",
			RealtimeTurnDetection: "fast",
			RealtimeSessionSchema: "realtime-2",
		},
		MeetRunner: runner,
	})

	performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true,"install_realtime_bridge":true,"realtime_session":{"audio":{"input":{"turn_detection":{"type":"server_vad","create_response":false,"interrupt_response":false}}}}}`, http.StatusOK)

	if len(runner.input.RealtimeTools) == 0 || runner.input.RealtimeSession["tools"] == nil {
		t.Fatalf("realtime session lost canonical tools: %#v", runner.input.RealtimeSession)
	}
	audio, ok := runner.input.RealtimeSession["audio"].(map[string]any)
	if !ok {
		t.Fatalf("audio = %T, want map", runner.input.RealtimeSession["audio"])
	}
	input, ok := audio["input"].(map[string]any)
	if !ok {
		t.Fatalf("audio.input = %T, want map", audio["input"])
	}
	if input["transcription"] == nil {
		t.Fatalf("audio.input = %#v, default transcription must survive override", input)
	}
	turn, ok := input["turn_detection"].(map[string]any)
	if !ok {
		t.Fatalf("turn_detection = %T, want map", input["turn_detection"])
	}
	if turn["create_response"] != false || turn["interrupt_response"] != false {
		t.Fatalf("turn_detection = %#v, want automatic responses disabled", turn)
	}
	output, ok := audio["output"].(map[string]any)
	if !ok || output["voice"] != "marin" {
		t.Fatalf("audio.output = %#v, default output config must survive override", audio["output"])
	}
}

func TestJoinPrewarmsKWWKComputerUseBeforeAndAfterStartedMeeting(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	backend := newRecordingPrewarmAppControlBackend()
	service := NewService(Config{
		Persistence:       appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:  rootDir,
		InternalAuthKey:   "secret-key",
		Pipeline:          postmeeting.NewPipeline(rootDir),
		MeetRunner:        startedRealtimeJoinMeetRunner{},
		AppControlBackend: backend,
		AgentRunner:       appconfig.AgentRunnerConfig{DryRun: true},
	})
	t.Cleanup(func() {
		_ = service.Shutdown(context.Background())
	})

	response, err := service.JoinGoogleMeet(context.Background(), JoinGoogleMeetRequest{
		SessionID:             "meet_prewarm",
		MeetingURL:            "https://meet.google.com/abc-defg-hij",
		DisplayName:           "Onee-sama",
		InstallRealtimeBridge: true,
		AutoConnectRealtime:   true,
	})
	if err != nil {
		t.Fatalf("JoinGoogleMeet() error = %v", err)
	}
	if !response.Started {
		t.Fatalf("response.Started = false, want started fake meeting")
	}
	select {
	case call := <-backend.calls:
		if call.SessionID != "meet_prewarm" || call.Reason != "meeting_join_pre_admission" {
			t.Fatalf("prewarm call = %#v, want pre-admission meeting session prewarm", call)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for pre-admission KWWK prewarm call")
	}
	select {
	case call := <-backend.calls:
		if call.SessionID != "meet_prewarm" || call.Reason != "meeting_join" {
			t.Fatalf("prewarm call = %#v, want post-start meeting session prewarm", call)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for post-start KWWK prewarm call")
	}

	var prewarm map[string]any
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		session, err := service.GetSession(context.Background(), "meet_prewarm")
		if err != nil {
			t.Fatalf("GetSession() error = %v", err)
		}
		if session != nil {
			if candidate, ok := session.Metadata["kwwk_cu_prewarm"].(map[string]any); ok {
				prewarm = candidate
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if prewarm == nil {
		t.Fatal("session metadata missing kwwk_cu_prewarm after prewarm")
	}
	if prewarm["ok"] != true || prewarm["provider"] != "kwwk" || prewarm["status"] != "ready" {
		t.Fatalf("prewarm metadata = %#v, want ready KWWK prewarm", prewarm)
	}
}

func TestJoinKeepsKWWKComputerUseWarmDuringActiveRealtimeSession(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	backend := newRecordingPrewarmAppControlBackend()
	service := NewService(Config{
		Persistence:                        appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:                   rootDir,
		InternalAuthKey:                    "secret-key",
		Pipeline:                           postmeeting.NewPipeline(rootDir),
		MeetRunner:                         startedRealtimeJoinMeetRunner{},
		AppControlBackend:                  backend,
		AppControlPrewarmKeepaliveInterval: 10 * time.Millisecond,
		AgentRunner:                        appconfig.AgentRunnerConfig{DryRun: true},
	})
	t.Cleanup(func() {
		_ = service.Shutdown(context.Background())
	})

	if _, err := service.JoinGoogleMeet(context.Background(), JoinGoogleMeetRequest{
		SessionID:             "meet_keepalive",
		MeetingURL:            "https://meet.google.com/abc-defg-hij",
		DisplayName:           "Onee-sama",
		InstallRealtimeBridge: true,
		AutoConnectRealtime:   true,
	}); err != nil {
		t.Fatalf("JoinGoogleMeet() error = %v", err)
	}

	seenJoin := false
	seenPreAdmission := false
	seenKeepalive := false
	deadline := time.After(time.Second)
	for !seenPreAdmission || !seenJoin || !seenKeepalive {
		select {
		case call := <-backend.calls:
			if call.SessionID != "meet_keepalive" {
				t.Fatalf("prewarm call session = %q, want meet_keepalive", call.SessionID)
			}
			switch call.Reason {
			case "meeting_join_pre_admission":
				seenPreAdmission = true
			case "meeting_join":
				seenJoin = true
			case "meeting_keepalive":
				seenKeepalive = true
			}
		case <-deadline:
			t.Fatalf("timed out waiting for pre-admission, join, and keepalive prewarm calls; seenPreAdmission=%t seenJoin=%t seenKeepalive=%t", seenPreAdmission, seenJoin, seenKeepalive)
		}
	}

	var keepalive map[string]any
	deadlineAt := time.Now().Add(time.Second)
	for time.Now().Before(deadlineAt) {
		session, err := service.GetSession(context.Background(), "meet_keepalive")
		if err != nil {
			t.Fatalf("GetSession() error = %v", err)
		}
		if session != nil {
			if candidate, ok := session.Metadata["kwwk_cu_keepalive"].(map[string]any); ok {
				keepalive = candidate
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	if keepalive == nil {
		t.Fatal("session metadata missing kwwk_cu_keepalive after keepalive")
	}
	if keepalive["ok"] != true || keepalive["reason"] != "meeting_keepalive" || intFromAny(keepalive["count"]) < 1 {
		t.Fatalf("keepalive metadata = %#v, want successful meeting_keepalive count", keepalive)
	}

	if _, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:     "meet_keepalive",
		Status: joinSessionStatusString(joinSessionStatusStopped),
	}); err != nil {
		t.Fatalf("UpsertSession(stopped) error = %v", err)
	}
	deadlineAt = time.Now().Add(time.Second)
	for time.Now().Before(deadlineAt) {
		service.appControlPrewarmMu.Lock()
		_, active := service.appControlPrewarmKeepalives["meet_keepalive"]
		service.appControlPrewarmMu.Unlock()
		if !active {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("KWWK app-control keepalive did not stop after terminal session status")
}

func TestJoinRealtimeToolSchemaHashMatchesExposedToolSurface(t *testing.T) {
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

	body := performRealtimeJSON(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_hash","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"install_realtime_bridge":true}`, http.StatusOK)
	session := body["session"].(map[string]any)
	metadata := session["metadata"].(map[string]any)
	withoutDemoSurface, err := RealtimeToolSchemaStableHash(false)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(false): %v", err)
	}
	withDemoSurface, err := RealtimeToolSchemaStableHash(true)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(true): %v", err)
	}
	if metadata["realtime_tool_schema_hash"] != withoutDemoSurface {
		t.Fatalf("metadata hash = %#v, want hidden/default hash %s", metadata["realtime_tool_schema_hash"], withoutDemoSurface)
	}
	if metadata["realtime_tool_schema_hash"] == withDemoSurface {
		t.Fatalf("metadata hash = %s, must not advertise demo-surface schema when only bridge is enabled", withDemoSurface)
	}
}

func realtimeToolMapsAsAny(tools []map[string]any) []any {
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		out = append(out, tool)
	}
	return out
}
