package meetingagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

func TestRuntimeJoinStateDetectsSoloParticipantCount(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"inMeeting":        true,
			"participantCount": 1,
		},
	})
	if !state.Joined || !state.Alone || state.ParticipantCount != 1 || state.Reason != "empty_room" {
		t.Fatalf("state = %+v, want joined solo empty_room", state)
	}
}

func TestJoinDigestTranscriptPrefersCumulativeCaptionJSONOverTail(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "captions.json")
	if err := os.WriteFile(path, []byte(`{"captions":[{"speaker":"Peng","text":"windows 怎么说，要不要考虑一下"},{"speaker":"Bridge Bot","text":"已记 Windows 评估项"}]}`), 0o644); err != nil {
		t.Fatalf("write captions: %v", err)
	}
	transcript := joinDigestTranscriptFromRuntimeCaptions(map[string]any{
		"paths": map[string]any{"json": path},
		"tail":  []map[string]any{{"speaker": "Bridge Bot", "text": "已记 Windows 评估项"}},
	})
	for _, want := range []string{"Peng: windows 怎么说", "Bridge Bot: 已记 Windows 评估项"} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript = %q, want %q", transcript, want)
		}
	}
}

func TestRuntimeJoinStateDetectsSoloParticipantButton(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"inMeeting": true,
			"buttons": []map[string]any{{
				"label": "1",
				"rect":  map[string]any{"y": 14},
			}},
		},
	})
	if !state.Joined || !state.Alone || state.ParticipantCount != 1 {
		t.Fatalf("state = %+v, want joined solo from top participant button", state)
	}
}

func TestRuntimeJoinStatePrefersTopParticipantButtonOverStaleCount(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"inMeeting":        true,
			"participantCount": 2,
			"buttons": []map[string]any{{
				"label": "1",
				"rect":  map[string]any{"y": 14},
			}},
		},
	})
	if !state.Joined || !state.Alone || state.ParticipantCount != 1 || state.Reason != "empty_room" {
		t.Fatalf("state = %+v, want top participant button to override stale count", state)
	}
}

func TestRuntimeJoinStateDoesNotMarkMultiParticipantMeetingAlone(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"inMeeting":        true,
			"participantCount": 2,
		},
	})
	if !state.Joined || state.Alone || state.ParticipantCount != 2 {
		t.Fatalf("state = %+v, want joined non-solo", state)
	}
}

func TestRuntimeJoinStatePrefersJoinedEvidenceOverCannotJoin(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"cannotJoin":       true,
			"inMeeting":        true,
			"participantCount": 18,
		},
		"captions": map[string]any{
			"count": 6,
		},
	})
	if !state.Joined || state.Failed || state.ParticipantCount != 18 {
		t.Fatalf("state = %+v, want joined evidence to override cannot_join", state)
	}
}

func TestRuntimeJoinStateMarksClosedPageStaleBeforeCaptionFallback(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"ok":    false,
			"error": "page.evaluate: Target page, context or browser has been closed",
		},
		"captions": map[string]any{
			"count": 733,
		},
	})
	if !state.Stale || state.Joined || state.Reason != "meet_runner_page_closed" {
		t.Fatalf("state = %+v, want stale page closed before captions fake joined", state)
	}
}

func TestRuntimeJoinStateStillFailsPureCannotJoin(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"cannotJoin": true,
		},
	})
	if !state.Failed || state.Joined || state.Reason != "cannot_join" {
		t.Fatalf("state = %+v, want pure cannot_join failure", state)
	}
}

func TestJoinMonitorStopsSoloMeetingAfterTimeout(t *testing.T) {
	oldInterval := joinMonitorIntervalOverrideNanos.Swap(int64(time.Millisecond))
	oldAloneTimeout := joinMonitorAloneTimeoutOverrideNanos.Swap(int64(time.Millisecond))
	t.Cleanup(func() {
		joinMonitorIntervalOverrideNanos.Store(oldInterval)
		joinMonitorAloneTimeoutOverrideNanos.Store(oldAloneTimeout)
	})

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &soloMeetRunner{stopCh: make(chan meetrunner.StopSessionInput, 1)}
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)
	_ = router

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         "session_solo",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "joined",
		Title:      "Solo Room",
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "123.456",
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	done := make(chan struct{})
	go func() {
		service.monitorJoinSession(context.Background(), session.ID)
		close(done)
	}()

	select {
	case stop := <-runner.stopCh:
		if stop.SessionID != "session_solo" || stop.Reason != "empty_room" {
			t.Fatalf("stop = %+v, want empty_room for session_solo", stop)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for empty-room StopSession")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("monitor did not exit after empty-room stop")
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "failed" || result.Error != "no transcript captured" {
		t.Fatalf("result = %+v, want fail-loud no transcript", result)
	}
}

func TestJoinMonitorFinalizesStaleSessionWhenRunnerPipeCloses(t *testing.T) {
	oldInterval := joinMonitorIntervalOverrideNanos.Swap(int64(time.Millisecond))
	t.Cleanup(func() {
		joinMonitorIntervalOverrideNanos.Store(oldInterval)
	})

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &fakeClosedPipeStatusMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         "session_pipe_closed_monitor",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "joined",
		Title:      "Pipe Closed",
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "123.456",
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	done := make(chan struct{})
	go func() {
		service.monitorJoinSession(context.Background(), session.ID)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("monitor did not exit after stale runner pipe")
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "failed" || result.Error != staleJoinFailureMessage || !result.ForceDelivery {
		t.Fatalf("result = %+v, want forced stale failure", result)
	}
	stale, err := service.GetSession(context.Background(), session.ID)
	if err != nil || stale == nil {
		t.Fatalf("get stale session: session=%+v err=%v", stale, err)
	}
	if stale.Status != "stale" || stringFromMap(stale.Metadata, "stale_reason") != "meet_runner_session_unavailable" {
		t.Fatalf("stale session = %+v, want stale unavailable", stale)
	}
}

func TestJoinMonitorRecoversStaleSessionFromCapturedArtifacts(t *testing.T) {
	oldInterval := joinMonitorIntervalOverrideNanos.Swap(int64(time.Millisecond))
	t.Cleanup(func() {
		joinMonitorIntervalOverrideNanos.Store(oldInterval)
	})

	sessionID := "session_pipe_closed_with_artifacts"
	artifactDir := filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", sessionID)
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("create artifact dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(artifactDir) })
	if err := os.WriteFile(filepath.Join(artifactDir, "captions.json"), []byte(`{"ok":true,"captions":[{"speaker":"Peng","text":"Captured captions should be delivered even if the runner pipe closes.","source":"google-meet-caption-dom"}]}`), 0o644); err != nil {
		t.Fatalf("write captions: %v", err)
	}
	if err := os.WriteFile(filepath.Join(artifactDir, "audio.wav"), []byte("wav"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	originalInspect := inspectMeetingAudioSignal
	inspectMeetingAudioSignal = func(context.Context, string) (bool, bool) { return true, true }
	t.Cleanup(func() { inspectMeetingAudioSignal = originalInspect })
	originalTranscode := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(_ context.Context, inputPath, outputPath string) error {
		if inputPath != filepath.Join(artifactDir, "audio.wav") {
			t.Fatalf("transcode input = %q, want stale raw audio", inputPath)
		}
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	t.Cleanup(func() { transcodeMeetingAudioToMP3 = originalTranscode })

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &fakeClosedPipeStatusMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         sessionID,
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "joined",
		Title:      "Pipe Closed With Artifacts",
		Metadata: map[string]any{
			"record_meeting":    true,
			"slack_channel_id":  "C123",
			"slack_thread_ts":   "123.456",
			"capture_captions":  true,
			"caption_language":  "Chinese (Simplified)",
			"runner_name":       "meet-runner",
			"started":           true,
			"started_from_test": true,
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	done := make(chan struct{})
	go func() {
		service.monitorJoinSession(context.Background(), session.ID)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("monitor did not exit after stale runner pipe")
	}
	processing := waitMeetdWebhook(t, webhooks, "meeting.processing")
	if processing.SlackRef == nil || processing.SlackRef.ChannelID != "C123" || processing.SlackRef.ThreadTS != "123.456" {
		t.Fatalf("processing result = %+v, want C123/123.456 slack ref", processing)
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || result.Summary == nil || result.Artifacts.CaptionsCount != 1 {
		t.Fatalf("result = %+v, want recovered done result with captured captions", result)
	}
	if result.Artifacts.TranscriptPath == "" || result.Artifacts.AudioPath == "" {
		t.Fatalf("artifacts = %+v, want transcript and audio paths", result.Artifacts)
	}
	if filepath.Base(result.Artifacts.AudioPath) != "audio.mp3" {
		t.Fatalf("audio artifact = %q, want compressed audio.mp3", result.Artifacts.AudioPath)
	}
	recovered, err := service.GetSession(context.Background(), session.ID)
	if err != nil || recovered == nil {
		t.Fatalf("get recovered session: session=%+v err=%v", recovered, err)
	}
	if recovered.Status != "done" || !boolField(recovered.Metadata, "stale_recovered_from_artifacts") {
		t.Fatalf("recovered session = %+v, want done with stale recovery metadata", recovered)
	}
}

func TestRecoverUnavailableJoinSessionsRecoversStartedSessionFromCapturedArtifacts(t *testing.T) {
	sessionID := "session_startup_recovery_with_artifacts"
	artifactDir := filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", sessionID)
	if err := os.RemoveAll(artifactDir); err != nil {
		t.Fatalf("remove old artifact dir: %v", err)
	}
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("create artifact dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(artifactDir) })
	if err := os.WriteFile(filepath.Join(artifactDir, "captions.json"), []byte(`{"ok":true,"captions":[{"speaker":"Peng","text":"Startup recovery should deliver captured captions.","source":"google-meet-caption-dom"}]}`), 0o644); err != nil {
		t.Fatalf("write captions: %v", err)
	}
	if err := os.WriteFile(filepath.Join(artifactDir, "audio.wav"), []byte("wav"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	originalInspect := inspectMeetingAudioSignal
	inspectMeetingAudioSignal = func(context.Context, string) (bool, bool) { return true, true }
	t.Cleanup(func() { inspectMeetingAudioSignal = originalInspect })
	originalTranscode := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(_ context.Context, inputPath, outputPath string) error {
		if inputPath != filepath.Join(artifactDir, "audio.wav") {
			t.Fatalf("transcode input = %q, want startup raw audio", inputPath)
		}
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	t.Cleanup(func() { transcodeMeetingAudioToMP3 = originalTranscode })

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &fakeClosedPipeStatusMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         sessionID,
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "joined",
		StartedAt:  time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
		Title:      "Startup Recovery With Artifacts",
		Metadata: map[string]any{
			"record_meeting":    true,
			"slack_channel_id":  "C123",
			"slack_thread_ts":   "123.456",
			"capture_captions":  true,
			"caption_language":  "Chinese (Simplified)",
			"runner_name":       "meet-runner",
			"started":           true,
			"started_from_test": true,
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	recoveredCount, err := service.RecoverUnavailableJoinSessions(context.Background())
	if err != nil {
		t.Fatalf("recover unavailable sessions: %v", err)
	}
	if recoveredCount != 1 {
		t.Fatalf("recovered count = %d, want 1", recoveredCount)
	}

	processing := waitMeetdWebhook(t, webhooks, "meeting.processing")
	if processing.SlackRef == nil || processing.SlackRef.ChannelID != "C123" || processing.SlackRef.ThreadTS != "123.456" {
		t.Fatalf("processing result = %+v, want C123/123.456 slack ref", processing)
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || result.Summary == nil || result.Artifacts.CaptionsCount != 1 {
		t.Fatalf("result = %+v, want recovered done result with captured captions", result)
	}
	recovered, err := service.GetSession(context.Background(), session.ID)
	if err != nil || recovered == nil {
		t.Fatalf("get recovered session: session=%+v err=%v", recovered, err)
	}
	if recovered.Status != "done" || !boolField(recovered.Metadata, "stale_recovered_from_artifacts") {
		t.Fatalf("recovered session = %+v, want done with stale recovery metadata", recovered)
	}
	if stringFromMap(recovered.Metadata, "stale_recovery_source") != joinStartupRecoverySource {
		t.Fatalf("recovered metadata = %+v, want startup recovery source", recovered.Metadata)
	}
}

func TestRecoverUnavailableJoinSessionsMarksStartedSessionStaleWithoutArtifacts(t *testing.T) {
	sessionID := "session_startup_recovery_without_artifacts"
	artifactDir := filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", sessionID)
	if err := os.RemoveAll(artifactDir); err != nil {
		t.Fatalf("remove old artifact dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(artifactDir) })

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &fakeClosedPipeStatusMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         sessionID,
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "joined",
		StartedAt:  time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
		Title:      "Startup Recovery Without Artifacts",
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "123.456",
			"started":          true,
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	recoveredCount, err := service.RecoverUnavailableJoinSessions(context.Background())
	if err != nil {
		t.Fatalf("recover unavailable sessions: %v", err)
	}
	if recoveredCount != 1 {
		t.Fatalf("recovered count = %d, want 1 stale finalization", recoveredCount)
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "failed" || result.Error != staleJoinFailureMessage || !result.ForceDelivery {
		t.Fatalf("result = %+v, want forced stale failure", result)
	}
	stale, err := service.GetSession(context.Background(), session.ID)
	if err != nil || stale == nil {
		t.Fatalf("get stale session: session=%+v err=%v", stale, err)
	}
	if stale.Status != "stale" || stringFromMap(stale.Metadata, "stale_reason") != "meet_runner_session_missing" {
		t.Fatalf("stale session = %+v, want stale missing", stale)
	}
	if stringFromMap(stale.Metadata, "stale_recovery_source") != joinStartupRecoverySource {
		t.Fatalf("stale metadata = %+v, want startup recovery source", stale.Metadata)
	}
}

func TestRecoverUnavailableJoinSessionsSkipsUnstartedSession(t *testing.T) {
	webhooks := make(chan MeetdWebhookPayload, 1)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	runner := &fakeClosedPipeStatusMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", runner)

	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}
	session, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         "session_startup_recovery_unstarted",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     "prepared",
		Title:      "Prepared Only",
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "123.456",
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	recoveredCount, err := service.RecoverUnavailableJoinSessions(context.Background())
	if err != nil {
		t.Fatalf("recover unavailable sessions: %v", err)
	}
	if recoveredCount != 0 {
		t.Fatalf("recovered count = %d, want 0", recoveredCount)
	}
	current, err := service.GetSession(context.Background(), session.ID)
	if err != nil || current == nil {
		t.Fatalf("get current session: session=%+v err=%v", current, err)
	}
	if current.Status != "prepared" {
		t.Fatalf("session status = %q, want prepared", current.Status)
	}
	select {
	case payload := <-webhooks:
		t.Fatalf("unexpected webhook for unstarted session: %+v", payload)
	default:
	}
}

type soloMeetRunner struct {
	fakeEmptyCaptionMeetRunner
	service *Service
	stopCh  chan meetrunner.StopSessionInput
}

func (r *soloMeetRunner) StatusSession(_ context.Context, input meetrunner.StatusSessionInput) (meetrunner.StatusSessionResult, error) {
	return meetrunner.StatusSessionResult{
		OK: true,
		Active: map[string]any{
			"sessionId": input.SessionID,
			"meetPage": map[string]any{
				"inMeeting":        true,
				"participantCount": 1,
			},
		},
		Session: &meetrunner.RunnerSession{ID: input.SessionID, Status: "joined"},
	}, nil
}

func (r *soloMeetRunner) StopSession(ctx context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	select {
	case r.stopCh <- input:
	default:
	}
	return r.fakeEmptyCaptionMeetRunner.StopSession(ctx, input)
}

func (r *soloMeetRunner) setService(service *Service) {
	r.service = service
}
