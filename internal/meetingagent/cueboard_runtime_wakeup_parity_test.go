//go:build cueboardparity

package meetingagent

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityScheduleMeetingWakesRuntimeImmediately(t *testing.T) {
	t.Parallel()

	service := NewService(Config{
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:        appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:   t.TempDir(),
		Pipeline:           postmeeting.NewPipeline(t.TempDir()),
		MeetRunner:         runtimeMeetRunner{started: false, status: "failed"},
		MeetdWatchInterval: time.Hour,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.StartMeetdRuntime(ctx)

	now := time.Now().UTC().Truncate(time.Second)
	meetingID, err := service.ScheduleMeetdMeeting(context.Background(), MeetdMeetingBrief{
		EventID: "wakeup-test",
		MeetURL: "https://meet.google.com/wakeup-test",
		Title:   "Wakeup Test",
		StartAt: now.Format(time.RFC3339),
		EndAt:   now.Add(15 * time.Minute).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("ScheduleMeetdMeeting: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		meeting, getErr := service.GetMeetdMeeting(context.Background(), meetingID)
		if getErr != nil {
			t.Fatalf("GetMeetdMeeting: %v", getErr)
		}
		if meeting != nil && meeting.Status == "joining" {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}

	meeting, err := service.GetMeetdMeeting(context.Background(), meetingID)
	if err != nil {
		t.Fatalf("GetMeetdMeeting(final): %v", err)
	}
	if meeting == nil {
		t.Fatal("meeting unexpectedly missing")
	}
	t.Fatalf("meeting status = %q, want joining after immediate runtime wakeup", meeting.Status)
}
