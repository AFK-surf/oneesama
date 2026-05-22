package meetingagent

import (
	"context"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

type shutdownStopMeetRunner struct {
	fakeEmptyCaptionMeetRunner
	service    *Service
	events     []string
	stopInputs []meetrunner.StopSessionInput
}

func (r *shutdownStopMeetRunner) setService(service *Service) {
	r.service = service
}

func (r *shutdownStopMeetRunner) StopSession(ctx context.Context, input meetrunner.StopSessionInput) (meetrunner.StopSessionResult, error) {
	r.events = append(r.events, "stop:"+input.SessionID)
	r.stopInputs = append(r.stopInputs, input)
	return r.fakeEmptyCaptionMeetRunner.StopSession(ctx, input)
}

func (r *shutdownStopMeetRunner) Shutdown(context.Context) error {
	r.events = append(r.events, "shutdown")
	return nil
}

func TestServiceShutdownStopsStartedJoinBeforeRunnerShutdown(t *testing.T) {
	runner := &shutdownStopMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, "", "", runner)
	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}

	_, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         "session_shutdown_active",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     joinSessionStatusString(joinSessionStatusJoined),
		StartedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Title:      "Shutdown Active",
		Metadata:   map[string]any{"started": true},
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	if err := service.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if len(runner.events) != 2 || runner.events[0] != "stop:session_shutdown_active" || runner.events[1] != "shutdown" {
		t.Fatalf("events = %v, want stop before runner shutdown", runner.events)
	}
	if len(runner.stopInputs) != 1 || runner.stopInputs[0].Reason != joinShutdownStopReason {
		t.Fatalf("stop inputs = %+v, want service_shutdown reason", runner.stopInputs)
	}
	stopped, err := service.GetSession(context.Background(), "session_shutdown_active")
	if err != nil || stopped == nil {
		t.Fatalf("get stopped session: session=%+v err=%v", stopped, err)
	}
	if stopped.Status != joinSessionStatusString(joinSessionStatusStopped) || stringFromMap(stopped.Metadata, "stop_reason") != joinShutdownStopReason {
		t.Fatalf("stopped session = %+v, want stopped with shutdown reason", stopped)
	}
}

func TestServiceShutdownSkipsUnstartedPreparedJoinSessions(t *testing.T) {
	runner := &shutdownStopMeetRunner{}
	_ = newJoinTestRouterWithWebhookAndRunner(t, "", "", runner)
	service := runner.service
	if service == nil {
		t.Fatal("expected test service to be wired")
	}

	_, err := service.UpsertSession(context.Background(), SessionUpsertInput{
		ID:         "session_shutdown_prepared",
		MeetingURL: "https://meet.google.com/abc-defg-hij",
		Status:     joinSessionStatusString(joinSessionStatusPrepared),
		Title:      "Shutdown Prepared",
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	if err := service.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if len(runner.events) != 1 || runner.events[0] != "shutdown" {
		t.Fatalf("events = %v, want runner shutdown only", runner.events)
	}
	if len(runner.stopInputs) != 0 {
		t.Fatalf("stop inputs = %+v, want none", runner.stopInputs)
	}
	prepared, err := service.GetSession(context.Background(), "session_shutdown_prepared")
	if err != nil || prepared == nil {
		t.Fatalf("get prepared session: session=%+v err=%v", prepared, err)
	}
	if prepared.Status != joinSessionStatusString(joinSessionStatusPrepared) {
		t.Fatalf("prepared session = %+v, want status preserved", prepared)
	}
}
