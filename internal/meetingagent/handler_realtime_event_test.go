package meetingagent

import (
	"context"
	"net/http"
	"testing"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type recordingRealtimeEventRunner struct {
	fakeMeetRunner
	input meetrunner.RealtimeEventInput
	calls int
}

func (r *recordingRealtimeEventRunner) SendRealtimeEvent(_ context.Context, input meetrunner.RealtimeEventInput) (meetrunner.RealtimeEventResult, error) {
	r.input = input
	r.calls++
	return meetrunner.RealtimeEventResult{
		"ok":         true,
		"source":     "fake_realtime_event",
		"session_id": input.SessionID,
		"type":       input.Event["type"],
	}, nil
}

func TestRealtimeEventRouteProxiesToActiveJoinSession(t *testing.T) {
	t.Parallel()

	runner := &recordingRealtimeEventRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/event", `{"event":{"type":"response.cancel","reason":"manual"}}`, http.StatusOK)
	if body["ok"] != true || body["source"] != "fake_realtime_event" || body["type"] != "response.cancel" {
		t.Fatalf("body = %#v, want proxied realtime event", body)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	if runner.input.SessionID != "meet_session" || runner.input.Event["type"] != "response.cancel" {
		t.Fatalf("runner input = %#v", runner.input)
	}
}

func TestRealtimeEventRouteRequiresEvent(t *testing.T) {
	t.Parallel()

	router := newRealtimeTestRouter(t, appconfig.OpenAIConfig{})
	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/event", `{}`, http.StatusBadRequest)
	if body["ok"] != false || body["error"] != "event_required" {
		t.Fatalf("body = %#v, want event_required", body)
	}
}

func TestRealtimeEventRouteAllowsSyntheticTranscriptionEvent(t *testing.T) {
	t.Parallel()

	runner := &recordingRealtimeEventRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/event", `{"event":{"type":"conversation.item.input_audio_transcription.completed","item_id":"synthetic_item","transcript":"Codex build Gomoku web game with sync"}}`, http.StatusOK)
	if body["ok"] != true || body["type"] != "conversation.item.input_audio_transcription.completed" {
		t.Fatalf("body = %#v, want proxied transcription event", body)
	}
	if runner.calls != 1 || runner.input.Event["transcript"] != "Codex build Gomoku web game with sync" {
		t.Fatalf("runner calls=%d input=%#v, want transcription proxied", runner.calls, runner.input)
	}
}

func TestRealtimeEventRouteRejectsSyntheticTranscriptionWithoutTranscript(t *testing.T) {
	t.Parallel()

	runner := &recordingRealtimeEventRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/event", `{"event":{"type":"conversation.item.input_audio_transcription.completed","item_id":"synthetic_item"}}`, http.StatusBadRequest)
	if body["ok"] != false || body["error"] != "realtime_transcript_required" {
		t.Fatalf("body = %#v, want realtime_transcript_required", body)
	}
	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
}

func TestRealtimeEventRouteRejectsRawTurnInjection(t *testing.T) {
	t.Parallel()

	runner := &recordingRealtimeEventRunner{}
	router := newRealtimeTestRouterWithConfig(t, Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	performRealtimeRequest(t, router, http.MethodPost, "/join/google-meet", `{"session_id":"meet_session","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`, http.StatusOK)

	body := performRealtimeJSON(t, router, http.MethodPost, "/realtime/event", `{"event":{"type":"conversation.item.create","item":{"type":"message","role":"user"}}}`, http.StatusBadRequest)
	if body["ok"] != false || body["error"] != "realtime_event_type_not_allowed" {
		t.Fatalf("body = %#v, want realtime_event_type_not_allowed", body)
	}
	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
}
