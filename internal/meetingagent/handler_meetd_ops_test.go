package meetingagent

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

func TestMeetdArtifactDownloadMatchesCueboard(t *testing.T) {
	t.Parallel()

	service, router := newMeetdOpsTestRouter(t, nil)
	meetingID := createMeetdMeetingForTest(t, router, meetdCreateBody(t, "artifact-event"))
	artifactsDir := t.TempDir()
	writeFile(t, filepath.Join(artifactsDir, "transcript.txt"), "hello transcript")
	writeFile(t, filepath.Join(artifactsDir, "audio.mp3"), "mp3")
	if _, err := service.SetMeetdMeetingArtifactsDir(context.Background(), meetingID, artifactsDir); err != nil {
		t.Fatalf("set artifacts dir: %v", err)
	}

	transcript := performMeetdRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/artifacts/transcript", meetingID), "")
	if transcript.Code != http.StatusOK {
		t.Fatalf("transcript status = %d, body = %s", transcript.Code, transcript.Body.String())
	}
	if got := transcript.Header().Get("Content-Disposition"); got != `attachment; filename="meeting-1-transcript.txt"` {
		t.Fatalf("transcript disposition = %q", got)
	}
	if transcript.Body.String() != "hello transcript" {
		t.Fatalf("transcript body = %q", transcript.Body.String())
	}

	audio := performMeetdRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/artifacts/audio", meetingID), "")
	if audio.Code != http.StatusOK || audio.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("audio status/header = %d %q", audio.Code, audio.Header().Get("Content-Type"))
	}
	if got := audio.Header().Get("Content-Disposition"); got != `attachment; filename="meeting-1-recording.mp3"` {
		t.Fatalf("audio disposition = %q", got)
	}
}

func TestMeetdRedeliverForcesStoredResult(t *testing.T) {
	t.Parallel()

	var captured MeetdMeetingResult
	service, router := newMeetdOpsTestRouter(t, func(_ context.Context, _ MeetdMeetingRecord, result MeetdMeetingResult) error {
		captured = result
		return nil
	})
	meetingID := createMeetdMeetingForTest(t, router, meetdCreateBody(t, "redeliver-event"))
	artifactsDir := t.TempDir()
	writeFile(t, filepath.Join(artifactsDir, "transcript.txt"), "summary transcript")
	if _, err := service.SetMeetdMeetingArtifactsDir(context.Background(), meetingID, artifactsDir); err != nil {
		t.Fatalf("set artifacts dir: %v", err)
	}
	if _, err := service.UpdateMeetdMeetingState(context.Background(), meetingID, "done", "", time.Now().UTC()); err != nil {
		t.Fatalf("mark done: %v", err)
	}
	if err := service.SetMeetdMeetingSummary(context.Background(), meetingID, MeetdSummaryData{Title: "Summary", KeyPoints: []string{"Done."}}); err != nil {
		t.Fatalf("set summary: %v", err)
	}

	response := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", meetingID), "")
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"redelivered"}` {
		t.Fatalf("redeliver response = %d %s", response.Code, response.Body.String())
	}
	if !captured.ForceDelivery || captured.Status != "done" || captured.Summary == nil || len(captured.Summary.KeyPoints) != 1 {
		t.Fatalf("captured result = %+v, want forced done summary", captured)
	}
	if captured.Artifacts.TranscriptPath == "" {
		t.Fatalf("captured artifacts = %+v, want transcript path", captured.Artifacts)
	}

	get := performMeetdRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d", meetingID), "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"result"`) || !strings.Contains(get.Body.String(), `"Done."`) {
		t.Fatalf("get body = %s, want stored result", get.Body.String())
	}
}

func TestMeetdRedeliverSyntheticJoinSessionReprocessesDirectJoin(t *testing.T) {
	t.Parallel()

	var capturedMeeting MeetdMeetingRecord
	var capturedResult MeetdMeetingResult
	service, router := newMeetdOpsTestRouter(t, func(_ context.Context, meeting MeetdMeetingRecord, result MeetdMeetingResult) error {
		capturedMeeting = meeting
		capturedResult = result
		return nil
	})
	sessionID := "session_direct_redeliver"
	_, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:               sessionID,
		MeetingID:        sessionID,
		MeetingURL:       "https://meet.google.com/direct-redeliver",
		Status:           "stopped",
		Title:            "Direct Join",
		ParticipantCount: 1,
		StartedAt:        time.Now().UTC().Add(-10 * time.Minute).Format(time.RFC3339Nano),
		EndedAt:          time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "111.222",
		},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}
	if _, err := service.PostProcessMeeting(context.Background(), postmeeting.PostProcessInput{
		ArtifactID: "join-" + sessionID,
		MeetingID:  meetingIDString(syntheticMeetingID(sessionID)),
		SessionID:  sessionID,
		Title:      "Direct Join",
		MeetURL:    "https://meet.google.com/direct-redeliver",
		Captions: []postmeeting.TranscriptSegmentInput{{
			Speaker: "Peng Xiao",
			Text:    "第一版字幕很差，需要重新交付。",
			Source:  "google_meet_caption",
		}},
		Source: "join-stop",
	}); err != nil {
		t.Fatalf("postprocess seed: %v", err)
	}

	meetingID := syntheticMeetingID(sessionID)
	response := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", meetingID), "")
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"redelivered"}` {
		t.Fatalf("redeliver response = %d %s", response.Code, response.Body.String())
	}
	if capturedMeeting.ID != meetingID || capturedMeeting.SessionID != sessionID {
		t.Fatalf("captured meeting = %+v, want synthetic direct join meeting", capturedMeeting)
	}
	if !capturedResult.ForceDelivery || capturedResult.Status != "done" || capturedResult.Summary == nil {
		t.Fatalf("captured result = %+v, want forced done summary", capturedResult)
	}
	if capturedResult.Artifacts.TranscriptPath == "" || capturedResult.Artifacts.CaptionsCount == 0 {
		t.Fatalf("captured artifacts = %+v, want transcript and caption count", capturedResult.Artifacts)
	}
}

func TestMeetdRedeliverStaleSyntheticJoinSessionFromCapturedArtifacts(t *testing.T) {
	t.Parallel()

	var capturedResult MeetdMeetingResult
	service, router := newMeetdOpsTestRouter(t, func(_ context.Context, _ MeetdMeetingRecord, result MeetdMeetingResult) error {
		capturedResult = result
		return nil
	})
	sessionID := "session_stale_redeliver"
	artifactDir := filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", sessionID)
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("create artifact dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(artifactDir) })
	writeFile(t, filepath.Join(artifactDir, "captions.json"), `{"ok":true,"captions":[{"speaker":"Peng Xiao","text":"Stale runner artifacts still need post-meeting delivery.","source":"google-meet-caption-dom"}]}`)
	if _, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         sessionID,
		MeetingID:  sessionID,
		MeetingURL: "https://meet.google.com/stale-redeliver",
		Status:     "stale",
		Title:      "Stale Redeliver",
		StartedAt:  time.Now().UTC().Add(-10 * time.Minute).Format(time.RFC3339Nano),
		EndedAt:    time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "111.222",
			"stale_reason":     "meet_runner_session_unavailable",
		},
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}
	meetingID := syntheticMeetingID(sessionID)
	if _, err := service.upsertSyntheticMeetdMeeting(context.Background(), syntheticMeetdMeeting(SessionRecord{
		ID:         sessionID,
		MeetingID:  sessionID,
		MeetingURL: "https://meet.google.com/stale-redeliver",
		Status:     "stale",
		Title:      "Stale Redeliver",
		StartedAt:  time.Now().UTC().Add(-10 * time.Minute).Format(time.RFC3339Nano),
		EndedAt:    time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "111.222",
		},
	}, "C123", "111.222"), "failed", staleJoinFailureMessage, ""); err != nil {
		t.Fatalf("seed synthetic meeting: %v", err)
	}

	response := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", meetingID), "")
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"redelivered"}` {
		t.Fatalf("redeliver stale synthetic meeting = %d %s", response.Code, response.Body.String())
	}
	if capturedResult.Status != "done" || capturedResult.Summary == nil || capturedResult.Artifacts.CaptionsCount != 1 {
		t.Fatalf("captured result = %+v, want recovered done summary", capturedResult)
	}
}

func TestFinalizeStoppedJoinRegistersSyntheticMeetdMeeting(t *testing.T) {
	t.Parallel()

	var capturedResult MeetdMeetingResult
	service, router := newMeetdOpsTestRouter(t, func(_ context.Context, _ MeetdMeetingRecord, result MeetdMeetingResult) error {
		capturedResult = result
		return nil
	})
	session := SessionRecord{
		ID:         "session_finalize_redeliver",
		MeetingID:  "session_finalize_redeliver",
		MeetingURL: "https://meet.google.com/finalize-redeliver",
		Status:     "stopped",
		Title:      "Finalize Redeliver",
		StartedAt:  time.Now().UTC().Add(-10 * time.Minute).Format(time.RFC3339Nano),
		EndedAt:    time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"slack_channel_id": "C123",
			"slack_thread_ts":  "111.222",
		},
	}
	if _, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         session.ID,
		MeetingID:  session.MeetingID,
		MeetingURL: session.MeetingURL,
		Status:     session.Status,
		Title:      session.Title,
		StartedAt:  session.StartedAt,
		EndedAt:    session.EndedAt,
		Metadata:   session.Metadata,
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}
	result, warning := service.finalizeStoppedJoin(context.Background(), session, meetrunner.StopSessionResult{OK: true}, []postmeeting.TranscriptSegmentInput{{
		Speaker: "Peng Xiao",
		Text:    "结束入会后应该自动注册 redeliver 记录。",
	}})
	if warning != "" || result == nil {
		t.Fatalf("finalizeStoppedJoin() result=%#v warning=%q", result, warning)
	}

	meetingID := syntheticMeetingID(session.ID)
	get := performMeetdRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d", meetingID), "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"status":"done"`) || !strings.Contains(get.Body.String(), `"result"`) {
		t.Fatalf("get synthetic meeting = %d %s, want done result", get.Code, get.Body.String())
	}
	if err := service.SetMeetdMeetingSummary(context.Background(), meetingID, MeetdSummaryData{
		Title:     "stale stored summary",
		KeyPoints: []string{"old result must not be reused for direct join redeliver"},
	}); err != nil {
		t.Fatalf("set stale summary: %v", err)
	}
	redeliver := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", meetingID), "")
	if redeliver.Code != http.StatusOK || strings.TrimSpace(redeliver.Body.String()) != `{"status":"redelivered"}` {
		t.Fatalf("redeliver synthetic meeting = %d %s", redeliver.Code, redeliver.Body.String())
	}
	if capturedResult.Summary == nil || capturedResult.Summary.Title == "stale stored summary" {
		t.Fatalf("redeliver result summary = %+v, want reprocessed direct join summary", capturedResult.Summary)
	}
	if capturedResult.Artifacts.CaptionsCount == 0 || capturedResult.Artifacts.TranscriptPath == "" {
		t.Fatalf("redeliver artifacts = %+v, want reprocessed transcript artifacts", capturedResult.Artifacts)
	}
}

func TestCueboardParityMeetdStoresSummaryCreatedAtAcrossUpsert(t *testing.T) {
	t.Parallel()

	service, _ := newMeetdOpsTestRouter(t, nil)
	meetingID, err := service.ScheduleMeetdMeeting(context.Background(), MeetdMeetingBrief{
		EventID: "summary-upsert-event",
		MeetURL: "https://meet.google.com/summary-upsert",
		Title:   "Summary Upsert",
		StartAt: time.Now().UTC().Format(time.RFC3339),
		EndAt:   time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("ScheduleMeetdMeeting: %v", err)
	}
	if err := service.SetMeetdMeetingSummary(context.Background(), meetingID, MeetdSummaryData{Title: "v1", KeyPoints: []string{"first"}}); err != nil {
		t.Fatalf("SetMeetdMeetingSummary(v1): %v", err)
	}
	first, err := service.meetdMeetingSummary(context.Background(), meetingID)
	if err != nil {
		t.Fatalf("meetdMeetingSummary(v1): %v", err)
	}
	if first == nil || first.Summary.Title != "v1" {
		t.Fatalf("first summary = %#v", first)
	}
	if err := service.SetMeetdMeetingSummary(context.Background(), meetingID, MeetdSummaryData{Title: "v2", KeyPoints: []string{"second"}}); err != nil {
		t.Fatalf("SetMeetdMeetingSummary(v2): %v", err)
	}
	second, err := service.meetdMeetingSummary(context.Background(), meetingID)
	if err != nil {
		t.Fatalf("meetdMeetingSummary(v2): %v", err)
	}
	if second == nil || second.Summary.Title != "v2" {
		t.Fatalf("second summary = %#v", second)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("CreatedAt changed across upsert: first=%s second=%s", first.CreatedAt, second.CreatedAt)
	}
	if !second.UpdatedAt.After(first.UpdatedAt) && !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("UpdatedAt moved backwards: first=%s second=%s", first.UpdatedAt, second.UpdatedAt)
	}
}

func TestMeetdRedeliverErrorsMatchCueboard(t *testing.T) {
	t.Parallel()

	_, noSenderRouter := newMeetdOpsTestRouter(t, nil)
	meetingID := createMeetdMeetingForTest(t, noSenderRouter, meetdCreateBody(t, "missing-sender"))
	missingSender := performMeetdRequest(noSenderRouter, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", meetingID), "")
	if missingSender.Code != http.StatusNotImplemented || strings.TrimSpace(missingSender.Body.String()) != `{"error":"webhook sender not configured"}` {
		t.Fatalf("missing sender response = %d %s", missingSender.Code, missingSender.Body.String())
	}

	_, router := newMeetdOpsTestRouter(t, func(context.Context, MeetdMeetingRecord, MeetdMeetingResult) error { return nil })
	pendingID := createMeetdMeetingForTest(t, router, meetdCreateBody(t, "redeliver-pending"))
	pending := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/redeliver", pendingID), "")
	if pending.Code != http.StatusConflict {
		t.Fatalf("pending status = %d, want 409", pending.Code)
	}
	want := fmt.Sprintf(`{"error":"meeting %d is in \"pending\" state, cannot redeliver"}`, pendingID)
	if strings.TrimSpace(pending.Body.String()) != want {
		t.Fatalf("pending body = %s, want %s", pending.Body.String(), want)
	}
}

func TestMeetdResummarizeProcessingRulesMatchCueboard(t *testing.T) {
	t.Parallel()

	service, router := newMeetdOpsTestRouter(t, nil)
	meetingID := createMeetdMeetingForTest(t, router, meetdCreateBody(t, "resummarize-event"))
	if _, err := service.UpdateMeetdMeetingState(context.Background(), meetingID, "processing", "", time.Now().UTC()); err != nil {
		t.Fatalf("mark fresh processing: %v", err)
	}
	fresh := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/resummarize", meetingID), "")
	if fresh.Code != http.StatusConflict || !strings.Contains(fresh.Body.String(), "still actively processing") {
		t.Fatalf("fresh response = %d %s", fresh.Code, fresh.Body.String())
	}

	stale := time.Now().UTC().Add(-10 * time.Minute)
	if _, err := service.UpdateMeetdMeetingState(context.Background(), meetingID, "processing", "", stale); err != nil {
		t.Fatalf("mark stale processing: %v", err)
	}
	staleResponse := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/resummarize", meetingID), "")
	if staleResponse.Code != http.StatusOK || strings.TrimSpace(staleResponse.Body.String()) != `{"status":"resummarizing"}` {
		t.Fatalf("stale response = %d %s", staleResponse.Code, staleResponse.Body.String())
	}

	pendingID := createMeetdMeetingForTest(t, router, meetdCreateBody(t, "resummarize-pending"))
	pending := performMeetdRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/resummarize", pendingID), "")
	want := fmt.Sprintf(`{"error":"meeting %d is in \"pending\" state, cannot resummarize"}`, pendingID)
	if pending.Code != http.StatusConflict || strings.TrimSpace(pending.Body.String()) != want {
		t.Fatalf("pending response = %d %s, want %s", pending.Code, pending.Body.String(), want)
	}
}

func newMeetdOpsTestRouter(t *testing.T, sender MeetdWebhookSender) (*Service, http.Handler) {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()
	service := NewService(Config{
		Logger:           logger,
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		MeetdWebhook:     sender,
	})
	handler := NewHandler(service)
	return service, httpserver.New("meeting-agent", logger, []string{"*"}, handler)
}

func meetdCreateBody(t *testing.T, eventID string) string {
	t.Helper()
	start := time.Now().UTC().Truncate(time.Second)
	return fmt.Sprintf(`{"event_id":%q,"meet_url":"https://meet.google.com/%s","title":"Meetd Ops","start_at":%q,"end_at":%q}`,
		eventID,
		eventID,
		start.Format(time.RFC3339),
		start.Add(time.Hour).Format(time.RFC3339),
	)
}

func performMeetdRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	requestBody := strings.NewReader(body)
	request := httptest.NewRequest(method, path, requestBody)
	request.Header.Set(internalauth.HeaderName, "secret-key")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(response, request)
	return response
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
