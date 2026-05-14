package meetingagent

import (
	"context"
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
