package meetingagent

import (
	"context"
	"net/http"
	"strings"
	"testing"

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
