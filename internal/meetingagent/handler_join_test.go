package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

type fakeMeetRunner struct{}

func (fakeMeetRunner) Ping(context.Context) (meetrunner.RunnerStatus, error) {
	return meetrunner.RunnerStatus{OK: true, Name: "fake-meet-runner", BridgeMode: "persistent-session"}, nil
}

func (fakeMeetRunner) PrepareGoogleMeet(_ context.Context, input meetrunner.PrepareGoogleMeetInput) (meetrunner.PrepareGoogleMeetResult, error) {
	return meetrunner.PrepareGoogleMeetResult{
		OK:         true,
		Accepted:   true,
		Started:    false,
		BridgeMode: "persistent-session",
		Note:       "prepared through fake runner",
		Session: meetrunner.RunnerSession{
			ID:         firstNonEmpty(input.SessionID, "session_join_test"),
			MeetingURL: input.MeetingURL,
			Status:     "prepared",
			Title:      firstNonEmpty(input.Title, "Join Dry Run"),
		},
		Plan: meetrunner.JoinPlan{
			Entry:                      "google-meet-joiner.ts",
			Mode:                       "playwright-ts",
			DryRun:                     input.DryRun,
			DisplayName:                input.DisplayName,
			AllowNonGoogleMeet:         input.AllowNonGoogleMeet,
			CollectFixtureState:        input.CollectFixtureState,
			CaptureCaptions:            input.CaptureCaptions,
			CaptionLanguage:            input.CaptionLanguage,
			RecordMeeting:              input.RecordMeeting,
			ArtifactsDir:               input.ArtifactsDir,
			MeetAudioBackend:           input.MeetAudioBackend,
			InstallRealtimeBridge:      input.InstallRealtimeBridge,
			RealtimeBridgeMode:         input.RealtimeBridgeMode,
			AutoConnectRealtime:        input.AutoConnectRealtime,
			SendRealtimeSessionUpdate:  input.SendRealtimeSessionUpdate,
			IncludeParticipantAudio:    input.IncludeParticipantAudio,
			ForwardMeetAudioToRealtime: input.ForwardMeetAudioToRealtime,
			RealtimeFallbackToLocalMic: input.RealtimeFallbackToLocalMic,
			InstallLocalDialogBridge:   input.InstallLocalDialogBridge,
			InstallWorkerResultBridge:  input.InstallWorkerResultBridge,
			InstallScreenShareBridge:   input.InstallScreenShareBridge,
			AutoStartScreenShare:       input.AutoStartScreenShare,
		},
	}, nil
}

func (fakeMeetRunner) StopSession(_ context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	return meetrunner.StopSessionResult{
		OK: true,
		Session: meetrunner.RunnerSession{
			ID:     input.SessionID,
			Status: "stopped",
		},
		Reason: input.Reason,
		Runtime: map[string]any{
			"beforeStop": map[string]any{
				"active": map[string]any{
					"captions": map[string]any{
						"tail": []map[string]any{{
							"speaker":   "Peng",
							"text":      "Ship the real join flow.",
							"timestamp": "2026-05-13T10:00:00Z",
							"source":    "live_caption",
						}},
					},
				},
			},
		},
	}, nil
}

type fakeEmptyCaptionMeetRunner struct{ fakeMeetRunner }

func (fakeEmptyCaptionMeetRunner) StopSession(_ context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	return meetrunner.StopSessionResult{
		OK: true,
		Session: meetrunner.RunnerSession{
			ID:     input.SessionID,
			Status: "stopped",
		},
		Reason:  input.Reason,
		Runtime: map[string]any{"beforeStop": map[string]any{"active": map[string]any{"captions": map[string]any{"tail": []map[string]any{}}}}},
	}, nil
}

type fakeMissingStatusMeetRunner struct{ fakeMeetRunner }

func (fakeMissingStatusMeetRunner) StatusSession(context.Context, meetrunner.StatusSessionInput) (meetrunner.StatusSessionResult, error) {
	return meetrunner.StatusSessionResult{}, errors.New("meet-runner session session_join_stale not found")
}

type fakeClosedPipeStatusMeetRunner struct {
	fakeMeetRunner
	service *Service
}

func (fakeClosedPipeStatusMeetRunner) StatusSession(context.Context, meetrunner.StatusSessionInput) (meetrunner.StatusSessionResult, error) {
	return meetrunner.StatusSessionResult{}, errors.New("write meet-runner join.session.status request: write |1: file already closed")
}

func (r *fakeClosedPipeStatusMeetRunner) setService(service *Service) {
	r.service = service
}

type fakeMeetRunnerWithRuntime struct {
	fakeMeetRunner
	runtime map[string]any
}

func (r fakeMeetRunnerWithRuntime) StopSession(_ context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	return meetrunner.StopSessionResult{
		OK: true,
		Session: meetrunner.RunnerSession{
			ID:     input.SessionID,
			Status: "stopped",
		},
		Reason:  input.Reason,
		Runtime: r.runtime,
	}, nil
}

func (fakeMeetRunner) StatusSession(_ context.Context, input meetrunner.StatusSessionInput) (meetrunner.StatusSessionResult, error) {
	return meetrunner.StatusSessionResult{
		OK:      true,
		Active:  map[string]any{"sessionId": input.SessionID, "meetPage": map[string]any{"preJoin": true}},
		Session: &meetrunner.RunnerSession{ID: input.SessionID, Status: "prepared"},
	}, nil
}

func (fakeMeetRunner) InjectWorkerResult(_ context.Context, _ meetrunner.WorkerResultInput) (meetrunner.WorkerResultDelivery, error) {
	return meetrunner.WorkerResultDelivery{OK: true, Channel: "meeting-avatar-worker-result"}, nil
}

func (fakeMeetRunner) SendMeetChat(_ context.Context, _ meetrunner.MeetChatInput) (meetrunner.MeetChatResult, error) {
	return meetrunner.MeetChatResult{OK: true, Success: true}, nil
}

func (fakeMeetRunner) StartScreenShare(_ context.Context, input meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true, "mode": input.Mode, "title": input.Title}, nil
}

func (fakeMeetRunner) PresentScreenShare(_ context.Context, input meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true, "mode": input.Mode, "title": input.Title}, nil
}

func (fakeMeetRunner) PresentVideoStage(_ context.Context, input meetrunner.VideoStageInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true, "videoUrl": input.VideoURL, "stageTitle": input.StageTitle}, nil
}

func (fakeMeetRunner) ListShareableApps(context.Context, meetrunner.ShareableAppsInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{
		"ok":     true,
		"source": "recappi_shareable_content",
		"count":  1,
		"applications": []map[string]any{{
			"processId":        4242,
			"bundleIdentifier": "com.example.Deck",
			"applicationName":  "Deck",
			"source":           "recappi_shareable_content",
		}},
	}, nil
}

func (fakeMeetRunner) PresentAppShare(_ context.Context, input meetrunner.AppShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{
		"ok":              true,
		"applicationName": input.ApplicationName,
		"processId":       input.ProcessID,
		"mode":            input.Mode,
		"title":           input.Title,
	}, nil
}

func (fakeMeetRunner) StopScreenShare(context.Context, meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true, "stopped": true}, nil
}

func TestHandleJoinLifecycle(t *testing.T) {
	t.Parallel()

	router := newJoinTestRouter(t)

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_test","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"collect_fixture_state":true,"capture_captions":true,"caption_language":"English","record_meeting":true,"install_realtime_bridge":true,"realtime_bridge_mode":"webrtc","auto_connect_realtime":true,"send_realtime_session_update":true,"forward_meet_audio_to_realtime":true,"install_local_dialog_bridge":true,"install_worker_result_bridge":true,"install_screen_share_bridge":true,"auto_start_screen_share":true}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, want 200", joinResponse.Code)
	}
	if !strings.Contains(joinResponse.Body.String(), `"accepted":true`) {
		t.Fatalf("body = %s, want accepted", joinResponse.Body.String())
	}
	if !strings.Contains(joinResponse.Body.String(), `"install_realtime_bridge":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"install_local_dialog_bridge":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"install_worker_result_bridge":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"realtime_bridge_mode":"webrtc"`) ||
		!strings.Contains(joinResponse.Body.String(), `"auto_connect_realtime":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"send_realtime_session_update":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"forward_meet_audio_to_realtime":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"install_screen_share_bridge":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"auto_start_screen_share":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"collect_fixture_state":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"capture_captions":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"record_meeting":true`) ||
		!strings.Contains(joinResponse.Body.String(), `"caption_language":"English"`) {
		t.Fatalf("body = %s, want explicit bridge flags in join plan", joinResponse.Body.String())
	}

	statusResponse := performMeetingRequest(router, http.MethodGet, "/join/status?session_id=session_join_test", "")
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("status code = %d, want 200", statusResponse.Code)
	}
	if !strings.Contains(statusResponse.Body.String(), `"status":"prepared"`) {
		t.Fatalf("body = %s, want prepared session", statusResponse.Body.String())
	}
	if !strings.Contains(statusResponse.Body.String(), `"runtime"`) {
		t.Fatalf("body = %s, want meet-runner runtime status", statusResponse.Body.String())
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_test","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, want 200", stopResponse.Code)
	}
	if !strings.Contains(stopResponse.Body.String(), `"status":"stopped"`) {
		t.Fatalf("body = %s, want stopped", stopResponse.Body.String())
	}
	if !strings.Contains(stopResponse.Body.String(), `"post_meeting"`) ||
		!strings.Contains(stopResponse.Body.String(), `"Ship the real join flow."`) {
		t.Fatalf("body = %s, want post-meeting artifact from flushed captions", stopResponse.Body.String())
	}
}

func TestHandleJoinRejectsArtifactsDirOutsideRoot(t *testing.T) {
	t.Parallel()

	router := newJoinTestRouter(t)
	outsideDir := t.TempDir()
	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{
		"session_id":"session_join_outside_artifacts",
		"meeting_url":"https://meet.google.com/abc-defg-hij",
		"dry_run":true,
		"record_meeting":true,
		"artifacts_dir":`+quoteJSONString(t, outsideDir)+`
	}`)
	if joinResponse.Code != http.StatusBadRequest {
		t.Fatalf("join status = %d body=%s, want 400", joinResponse.Code, joinResponse.Body.String())
	}
}

func TestJoinStatusMarksPersistedSessionStaleWhenRunnerSessionMissing(t *testing.T) {
	t.Parallel()

	router := newJoinTestRouterWithWebhookAndRunner(t, "", "", fakeMissingStatusMeetRunner{})
	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_stale","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	statusResponse := performMeetingRequest(router, http.MethodGet, "/join/status?session_id=session_join_stale", "")
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("status code = %d, body = %s", statusResponse.Code, statusResponse.Body.String())
	}
	body := statusResponse.Body.String()
	if !strings.Contains(body, `"status":"stale"`) {
		t.Fatalf("body = %s, want stale session status", body)
	}
	if !strings.Contains(body, `"stale_reason":"meet_runner_session_missing"`) {
		t.Fatalf("body = %s, want stale reason metadata", body)
	}
}

func TestJoinStatusFinalizesStaleSessionWhenRunnerPipeCloses(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", &fakeClosedPipeStatusMeetRunner{})
	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_pipe_closed","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	statusResponse := performMeetingRequest(router, http.MethodGet, "/join/status?session_id=session_join_pipe_closed", "")
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("status code = %d, body = %s", statusResponse.Code, statusResponse.Body.String())
	}
	body := statusResponse.Body.String()
	if !strings.Contains(body, `"status":"stale"`) {
		t.Fatalf("body = %s, want stale session status", body)
	}
	if !strings.Contains(body, `"stale_reason":"meet_runner_session_unavailable"`) {
		t.Fatalf("body = %s, want unavailable stale reason metadata", body)
	}
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "failed" || result.Error != staleJoinFailureMessage || !result.ForceDelivery {
		t.Fatalf("result = %+v, want forced stale failure", result)
	}
	if result.SlackRef == nil || result.SlackRef.ChannelID != "C123" || result.SlackRef.ThreadTS != "123.456" {
		t.Fatalf("slack ref = %+v, want C123/123.456", result.SlackRef)
	}
}

func TestJoinStopProcessesCaptionsAndSendsSlackWebhook(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhook(t, webhookURL, "secret")

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_webhook","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, want 200", joinResponse.Code)
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_webhook","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.SlackRef == nil || result.SlackRef.ChannelID != "C123" || result.SlackRef.ThreadTS != "123.456" {
		t.Fatalf("result slack ref = %+v, want C123/123.456", result.SlackRef)
	}
	if result.Status != "done" || result.Summary == nil || len(result.Summary.KeyPoints) == 0 {
		t.Fatalf("result = %+v, want done summary", result)
	}
	if strings.TrimSpace(result.TimeFrom) == "" || strings.TrimSpace(result.TimeTo) == "" {
		t.Fatalf("result times = from %q to %q, want session start/end carried to Slack canvas", result.TimeFrom, result.TimeTo)
	}
}

func TestJoinStopFixtureTranscriptSendsSlackCanvasWebhook(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", fakeEmptyCaptionMeetRunner{})

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_fixture","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	stopBody := `{
		"session_id":"session_join_fixture",
			"reason":"dogfood_fixture",
			"fixture_transcript":"Peng: Decision: ship the synthetic transcript harness.\nAlice: Action item: Alice will send the launch notes by Friday."
		}`
	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", stopBody)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	if !strings.Contains(stopResponse.Body.String(), `"post_meeting"`) ||
		!strings.Contains(stopResponse.Body.String(), "Alice will send the launch notes by Friday") ||
		strings.Contains(stopResponse.Body.String(), "no transcript captured") {
		t.Fatalf("body = %s, want fixture transcript post-meeting result", stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || result.Summary == nil {
		t.Fatalf("result = %+v, want done summary from fixture transcript", result)
	}
	if !containsString(result.Summary.Decisions, "Decision: ship the synthetic transcript harness.") ||
		!containsActionDescription(result.Summary.ActionItems, "Action item: Alice will send the launch notes by Friday.") {
		t.Fatalf("summary = %+v, want decision and action item from fixture transcript", result.Summary)
	}
}

func TestJoinStopIncludesRecordedAudioArtifactWhenRunnerCapturedIt(t *testing.T) {
	artifactsDir := t.TempDir()
	rawAudio := filepath.Join(artifactsDir, "audio.wav")
	if err := os.WriteFile(rawAudio, []byte("wav"), 0o644); err != nil {
		t.Fatalf("write raw audio: %v", err)
	}
	originalTranscode := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(_ context.Context, _, outputPath string) error {
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	t.Cleanup(func() { transcodeMeetingAudioToMP3 = originalTranscode })

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", fakeMeetRunnerWithRuntime{
		runtime: map[string]any{
			"beforeStop": map[string]any{
				"active": map[string]any{
					"artifactsDir": artifactsDir,
					"recorder":     map[string]any{"audioPath": rawAudio},
					"captions": map[string]any{
						"tail": []map[string]any{{
							"speaker": "Peng",
							"text":    "Audio should be attached to the Canvas.",
							"source":  "live_caption",
						}},
					},
				},
			},
		},
	})

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_audio","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"record_meeting":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_audio","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if !strings.HasSuffix(result.Artifacts.AudioPath, "audio.mp3") {
		t.Fatalf("audio path = %q, want finalized mp3 artifact", result.Artifacts.AudioPath)
	}
	if !strings.HasSuffix(result.Artifacts.TranscriptPath, "transcript.txt") {
		t.Fatalf("transcript path = %q, want text transcript artifact", result.Artifacts.TranscriptPath)
	}
}

func TestJoinStopOmitsSilentRecordedAudioArtifact(t *testing.T) {
	artifactsDir := t.TempDir()
	rawAudio := filepath.Join(artifactsDir, "audio.wav")
	if err := os.WriteFile(rawAudio, []byte("wav"), 0o644); err != nil {
		t.Fatalf("write raw audio: %v", err)
	}
	originalTranscode := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(_ context.Context, _, outputPath string) error {
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	originalInspect := inspectMeetingAudioSignal
	inspectMeetingAudioSignal = func(context.Context, string) (bool, bool) {
		return false, true
	}
	t.Cleanup(func() {
		transcodeMeetingAudioToMP3 = originalTranscode
		inspectMeetingAudioSignal = originalInspect
	})

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", fakeMeetRunnerWithRuntime{
		runtime: map[string]any{
			"beforeStop": map[string]any{
				"active": map[string]any{
					"artifactsDir": artifactsDir,
					"recorder":     map[string]any{"audioPath": rawAudio},
					"captions": map[string]any{
						"tail": []map[string]any{{
							"speaker": "Peng",
							"text":    "Silent audio must not be treated as a valid recording artifact.",
							"source":  "live_caption",
						}},
					},
				},
			},
		},
	})

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_silent_audio","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"record_meeting":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_silent_audio","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Artifacts.AudioPath != "" {
		t.Fatalf("audio path = %q, want silent recording omitted", result.Artifacts.AudioPath)
	}
	if !strings.HasSuffix(result.Artifacts.TranscriptPath, "transcript.txt") {
		t.Fatalf("transcript path = %q, want text transcript artifact", result.Artifacts.TranscriptPath)
	}
}

func TestJoinStopReadsRuntimeCaptionAndAudioPathsFromMeetRunnerDir(t *testing.T) {
	t.Parallel()

	artifactsDir := filepath.Join("meet-runner", "runtime", "meeting-artifacts", "runner-session_join_runner_paths")
	if err := os.MkdirAll(artifactsDir, 0o755); err != nil {
		t.Fatalf("create runner artifacts dir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(filepath.Join("meet-runner", "runtime", "meeting-artifacts", "runner-session_join_runner_paths"))
	})
	if err := os.WriteFile(filepath.Join(artifactsDir, "captions.json"), []byte(`{"ok":true,"captions":[{"speaker":"You","text":"Local bot self-caption should be ignored.","source":"google-meet-caption-dom"},{"speaker":"Peng","text":"Runtime captions should become transcript text.","source":"google-meet-caption-dom"}]}`), 0o644); err != nil {
		t.Fatalf("write captions: %v", err)
	}
	if err := os.WriteFile(filepath.Join(artifactsDir, "audio.wav"), []byte("wav"), 0o644); err != nil {
		t.Fatalf("write raw audio: %v", err)
	}
	originalTranscode := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(_ context.Context, _, outputPath string) error {
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	t.Cleanup(func() { transcodeMeetingAudioToMP3 = originalTranscode })

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", fakeMeetRunnerWithRuntime{
		runtime: map[string]any{
			"beforeStop": map[string]any{
				"active": map[string]any{
					"artifactsDir": "runtime/meeting-artifacts/runner-session_join_runner_paths",
					"recorder":     map[string]any{"audioPath": "runtime/meeting-artifacts/runner-session_join_runner_paths/audio.wav"},
					"captions": map[string]any{
						"count": 1,
						"tail": []map[string]any{{
							"speaker": "Peng",
							"text":    "Tail captions should not win over the flushed caption artifact.",
							"source":  "google-meet-caption-dom",
						}},
						"paths": map[string]any{"json": "runtime/meeting-artifacts/runner-session_join_runner_paths/captions.json"},
					},
				},
			},
		},
	})

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_runner_paths","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"record_meeting":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_runner_paths","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	if strings.Contains(stopResponse.Body.String(), "no transcript captured") ||
		!strings.Contains(stopResponse.Body.String(), "Runtime captions should become transcript text.") ||
		strings.Contains(stopResponse.Body.String(), "Local bot self-caption") {
		t.Fatalf("body = %s, want post-meeting result from runner captions path", stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || result.Artifacts.CaptionsCount != 1 {
		t.Fatalf("result = %+v, want done result with caption", result)
	}
	if !strings.HasSuffix(result.Artifacts.AudioPath, "audio.mp3") || !strings.HasSuffix(result.Artifacts.TranscriptPath, "transcript.txt") {
		t.Fatalf("artifacts = %+v, want transcript.txt and audio.mp3", result.Artifacts)
	}
}

func TestCaptionsFromStopRuntimePrefersFlushedCaptionFileOverTail(t *testing.T) {
	t.Parallel()

	captionsPath := filepath.Join(t.TempDir(), "captions.json")
	if err := os.WriteFile(captionsPath, []byte(`{"ok":true,"captions":[{"speaker":"You","text":"Bot self-caption should be ignored."},{"speaker":"Peng","text":"Full flushed caption wins."}]}`), 0o644); err != nil {
		t.Fatalf("write captions: %v", err)
	}

	segments := captionsFromStopRuntime(map[string]any{
		"beforeStop": map[string]any{
			"active": map[string]any{
				"captions": map[string]any{
					"tail": []map[string]any{{
						"speaker": "Peng",
						"text":    "Tail captions should not win.",
					}},
					"paths": map[string]any{"json": captionsPath},
				},
			},
		},
	})
	if len(segments) != 1 || segments[0].Speaker != "Peng" || segments[0].Text != "Full flushed caption wins." {
		t.Fatalf("segments = %#v, want full captions file with local speaker filtered", segments)
	}
}

func TestJoinStopFallsBackToMeetPageCaptionTextHead(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	router := newJoinTestRouterWithWebhookAndRunner(t, webhookURL, "secret", fakeMeetRunnerWithRuntime{
		runtime: map[string]any{
			"beforeStop": map[string]any{
				"active": map[string]any{
					"captions": map[string]any{
						"tail":  []map[string]any{},
						"paths": map[string]any{},
					},
					"meetPage": map[string]any{
						"textHead": strings.Join([]string{
							"External participants joined",
							"domain_disabled",
							"Peng Xiao",
							"Meeting Avatar Bot",
							"language",
							"English",
							"closed_caption",
							"Live captions",
							"format_size",
							"Font size",
							"groups",
							"Peng Xiao & 1 others",
							"AI in an operating system that I've seen so far. You want just rain and wind speed in your weather app.",
						}, "\n"),
					},
				},
			},
		},
	})

	joinResponse := performMeetingRequest(router, http.MethodPost, "/join/google-meet", `{"session_id":"session_join_texthead_fallback","meeting_url":"https://meet.google.com/abc-defg-hij","display_name":"Onee-sama","dry_run":true,"capture_captions":true,"slack_channel_id":"C123","slack_thread_ts":"123.456"}`)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join status = %d, body = %s", joinResponse.Code, joinResponse.Body.String())
	}

	stopResponse := performMeetingRequest(router, http.MethodPost, "/join/stop", `{"session_id":"session_join_texthead_fallback","reason":"done"}`)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("stop code = %d, body = %s", stopResponse.Code, stopResponse.Body.String())
	}
	if strings.Contains(stopResponse.Body.String(), "no transcript captured") ||
		!strings.Contains(stopResponse.Body.String(), "rain and wind speed") {
		t.Fatalf("body = %s, want post-meeting result from Meet page caption fallback", stopResponse.Body.String())
	}
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || result.Summary == nil {
		t.Fatalf("result = %+v, want done summary from Meet page caption fallback", result)
	}
	if result.Artifacts.CaptionsCount != 1 {
		t.Fatalf("captions count = %d, want 1 fallback caption", result.Artifacts.CaptionsCount)
	}
}

func newJoinTestRouter(t *testing.T) http.Handler {
	return newJoinTestRouterWithWebhook(t, "", "")
}

func newJoinTestRouterWithWebhook(t *testing.T, webhookURL string, secret string) http.Handler {
	return newJoinTestRouterWithWebhookAndRunner(t, webhookURL, secret, fakeMeetRunner{})
}

func newJoinTestRouterWithWebhookAndRunner(t *testing.T, webhookURL string, secret string, runner meetrunner.Runner) http.Handler {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewService(Config{
		Logger:             logger,
		Persistence:        appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:   t.TempDir(),
		InternalAuthKey:    "secret-key",
		MeetRunner:         runner,
		MeetdWebhookURL:    webhookURL,
		MeetdWebhookSecret: secret,
	})
	if aware, ok := runner.(interface{ setService(*Service) }); ok {
		aware.setService(service)
	}
	return httpserver.New("meeting-agent", logger, []string{"*"}, NewHandler(service))
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func quoteJSONString(t *testing.T, value string) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON string: %v", err)
	}
	return string(raw)
}

func containsActionDescription(values []MeetdActionItem, target string) bool {
	for _, value := range values {
		if value.Description == target {
			return true
		}
	}
	return false
}
