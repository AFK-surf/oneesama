package meetingagent

import (
	"context"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type recordingMeetChatRunner struct {
	fakeMeetRunner
	input meetrunner.MeetChatInput
	calls int
}

func (r *recordingMeetChatRunner) SendMeetChat(_ context.Context, input meetrunner.MeetChatInput) (meetrunner.MeetChatResult, error) {
	r.input = input
	r.calls++
	return meetrunner.MeetChatResult{OK: true, Success: true, Text: input.Text}, nil
}

func TestSendMeetdChatUsesActiveJoinSession(t *testing.T) {
	t.Parallel()

	runner := &recordingMeetChatRunner{}
	service := NewService(Config{
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: t.TempDir(),
		MeetRunner:       runner,
	})
	start := time.Now().UTC().Truncate(time.Second)
	meetingID, err := service.ScheduleMeetdMeeting(context.Background(), MeetdMeetingBrief{
		EventID: "chat-active",
		MeetURL: "https://meet.google.com/chat-active",
		Title:   "Chat Active",
		StartAt: start.Format(time.RFC3339),
		EndAt:   start.Add(time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("ScheduleMeetdMeeting: %v", err)
	}
	if _, err := service.SetMeetdMeetingSession(context.Background(), meetingID, "session_live_chat"); err != nil {
		t.Fatalf("SetMeetdMeetingSession: %v", err)
	}
	if _, err := service.UpdateMeetdMeetingState(context.Background(), meetingID, "active", "", start); err != nil {
		t.Fatalf("UpdateMeetdMeetingState: %v", err)
	}

	ok, err := service.SendMeetdChat(context.Background(), meetingID, "📋 已记：Windows 也纳入评估。")
	if err != nil {
		t.Fatalf("SendMeetdChat: %v", err)
	}
	if !ok {
		t.Fatal("SendMeetdChat ok = false, want true")
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	if runner.input.SessionID != "session_live_chat" || runner.input.Text != "📋 已记：Windows 也纳入评估。" {
		t.Fatalf("runner input = %#v", runner.input)
	}
}
