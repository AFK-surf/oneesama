package meetingagent

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

type runtimeMeetRunner struct {
	started bool
	status  string
}

func (r runtimeMeetRunner) Ping(context.Context) (meetrunner.RunnerStatus, error) {
	return meetrunner.RunnerStatus{OK: true, Name: "runtime-fake", BridgeMode: "persistent-session"}, nil
}

func (r runtimeMeetRunner) PrepareGoogleMeet(_ context.Context, input meetrunner.PrepareGoogleMeetInput) (meetrunner.PrepareGoogleMeetResult, error) {
	return meetrunner.PrepareGoogleMeetResult{
		OK:         true,
		Accepted:   true,
		Started:    r.started,
		BridgeMode: "persistent-session",
		Session: meetrunner.RunnerSession{
			ID:         firstNonEmpty(input.SessionID, "meetd-fake"),
			MeetingURL: input.MeetingURL,
			Status:     firstNonEmpty(r.status, "joined"),
			Title:      input.Title,
		},
	}, nil
}

func (runtimeMeetRunner) StopSession(_ context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	return meetrunner.StopSessionResult{OK: true, Session: meetrunner.RunnerSession{ID: input.SessionID, Status: "stopped"}}, nil
}

func (runtimeMeetRunner) StatusSession(_ context.Context, input meetrunner.StatusSessionInput) (meetrunner.StatusSessionResult, error) {
	return meetrunner.StatusSessionResult{OK: true, Session: &meetrunner.RunnerSession{ID: input.SessionID, Status: "joined"}}, nil
}

func (runtimeMeetRunner) InjectWorkerResult(context.Context, meetrunner.WorkerResultInput) (meetrunner.WorkerResultDelivery, error) {
	return meetrunner.WorkerResultDelivery{OK: true, Channel: "meeting-avatar-worker-result"}, nil
}

func (runtimeMeetRunner) StartScreenShare(context.Context, meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true}, nil
}

func (runtimeMeetRunner) PresentScreenShare(context.Context, meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true}, nil
}

func (runtimeMeetRunner) PresentVideoStage(context.Context, meetrunner.VideoStageInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true}, nil
}

func (runtimeMeetRunner) StopScreenShare(context.Context, meetrunner.ScreenShareInput) (meetrunner.ScreenShareResult, error) {
	return meetrunner.ScreenShareResult{"ok": true}, nil
}

func TestMeetdRuntimeTickClaimsReadyMeetingAndSendsJoinedWebhook(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	service, router := newMeetdRuntimeTestRouter(t, runtimeMeetRunner{started: true, status: "joined"}, webhookURL, "secret")
	now := time.Now().UTC().Truncate(time.Second)
	meetingID := createMeetdMeetingForTest(t, router, meetdCreateBodyAt(t, "runtime-ready", now))

	response := performMeetdRequest(router, http.MethodPost, "/meetings/runtime/tick", fmt.Sprintf(`{"now":%q}`, now.Format(time.RFC3339)))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"action":"join_claimed"`) {
		t.Fatalf("tick response = %d %s", response.Code, response.Body.String())
	}
	payload := waitMeetdWebhook(t, webhooks, "meeting.joined")
	if payload.MeetingID != meetingID || payload.Title != "Meetd Ops" {
		t.Fatalf("joined payload = %+v", payload)
	}
	meeting, err := service.GetMeetdMeeting(context.Background(), meetingID)
	if err != nil {
		t.Fatalf("get meeting: %v", err)
	}
	if meeting.Status != "active" || meeting.SessionID != "meetd-1" {
		t.Fatalf("meeting = %+v, want active meetd-1", meeting)
	}
}

func TestMeetdRuntimeTickCleansStaleAndCancelsMissedMeetings(t *testing.T) {
	t.Parallel()

	service, router := newMeetdRuntimeTestRouter(t, runtimeMeetRunner{}, "", "")
	now := time.Now().UTC().Truncate(time.Second)
	missedID := createMeetdMeetingForTest(t, router, meetdCreateBodyAt(t, "runtime-missed", now.Add(-10*time.Minute)))
	staleID := createMeetdMeetingForTest(t, router, meetdCreateBodyAt(t, "runtime-stale", now))
	if _, err := service.UpdateMeetdMeetingState(context.Background(), staleID, "joining", "", now.Add(-time.Hour)); err != nil {
		t.Fatalf("mark stale joining: %v", err)
	}

	response := performMeetdRequest(router, http.MethodPost, "/meetings/runtime/tick", fmt.Sprintf(`{"now":%q,"stale_ms":1000}`, now.Format(time.RFC3339)))
	if response.Code != http.StatusOK {
		t.Fatalf("tick status = %d, body = %s", response.Code, response.Body.String())
	}
	missed, _ := service.GetMeetdMeeting(context.Background(), missedID)
	stale, _ := service.GetMeetdMeeting(context.Background(), staleID)
	if missed.Status != "cancelled" || missed.ErrorMessage != "missed start window" {
		t.Fatalf("missed = %+v, want cancelled missed start window", missed)
	}
	if stale.Status != "failed" || stale.ErrorMessage != "daemon restart" {
		t.Fatalf("stale = %+v, want failed daemon restart", stale)
	}
}

func TestMeetdProcessingSendsProcessingAndResultWebhooks(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	service, router := newMeetdRuntimeTestRouter(t, runtimeMeetRunner{}, webhookURL, "secret")
	now := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{
		"event_id":"runtime-processing",
		"meet_url":"https://meet.google.com/runtime-processing",
		"title":"Runtime Processing",
		"start_at":%q,
		"end_at":%q,
		"status":"processing",
		"captions":[{"speaker":"Peng","text":"Ship the watcher.","timestamp":%q,"source":"live_caption"}]
	}`, now.Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339), now.Add(time.Minute).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)
	if _, err := service.SetMeetdMeetingArtifactsDir(context.Background(), meetingID, t.TempDir()); err != nil {
		t.Fatalf("set artifacts dir: %v", err)
	}
	meeting, _ := service.GetMeetdMeeting(context.Background(), meetingID)

	service.ProcessMeetdMeetingEnd(context.Background(), *meeting, true)
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "done" || !result.ForceDelivery || result.Summary == nil || len(result.Summary.KeyPoints) == 0 {
		t.Fatalf("result payload = %+v, want done forced summary", result)
	}
	updated, _ := service.GetMeetdMeeting(context.Background(), meetingID)
	if updated.Status != "done" || updated.ErrorMessage != "" {
		t.Fatalf("updated meeting = %+v, want done", updated)
	}
}

func newMeetdRuntimeTestRouter(t *testing.T, runner meetrunner.Runner, webhookURL string, secret string) (*Service, http.Handler) {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()
	service := NewService(Config{
		Logger:             logger,
		Persistence:        appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:   rootDir,
		InternalAuthKey:    "secret-key",
		Pipeline:           postmeeting.NewPipeline(rootDir),
		MeetRunner:         runner,
		MeetdWebhookURL:    webhookURL,
		MeetdWebhookSecret: secret,
		MeetdWatchInterval: time.Hour,
	})
	handler := NewHandler(service)
	return service, httpserver.New("meeting-agent", logger, []string{"*"}, handler)
}

func meetdCreateBodyAt(t *testing.T, eventID string, start time.Time) string {
	t.Helper()
	return fmt.Sprintf(`{"event_id":%q,"meet_url":"https://meet.google.com/%s","title":"Meetd Ops","start_at":%q,"end_at":%q}`,
		eventID,
		eventID,
		start.Format(time.RFC3339),
		start.Add(time.Hour).Format(time.RFC3339),
	)
}

func meetdWebhookTestServer(t *testing.T, secret string, sink chan<- MeetdWebhookPayload) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read webhook body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got, want := r.Header.Get("X-Webhook-Signature"), meetdWebhookTestSignature(body, secret); got != want {
			t.Errorf("signature = %q, want %q", got, want)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var payload MeetdWebhookPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode webhook body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sink <- payload
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func waitMeetdWebhook(t *testing.T, sink <-chan MeetdWebhookPayload, event string) MeetdWebhookPayload {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case payload := <-sink:
			if payload.Event == event {
				return payload
			}
		case <-deadline:
			t.Fatalf("timed out waiting for webhook %s", event)
		}
	}
}

func meetdWebhookTestSignature(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
