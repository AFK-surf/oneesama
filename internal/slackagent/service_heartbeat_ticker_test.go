package slackagent

import (
	"context"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHeartbeatTickerStartSurfacesDueFollowup(t *testing.T) {
	previousInitialDelay := slackHeartbeatTickerInitialDelay
	previousInterval := slackHeartbeatTickerInterval
	previousLimit := slackHeartbeatTickerLimit
	slackHeartbeatTickerInitialDelay = 0
	slackHeartbeatTickerInterval = time.Hour
	slackHeartbeatTickerLimit = 5
	t.Cleanup(func() {
		slackHeartbeatTickerInitialDelay = previousInitialDelay
		slackHeartbeatTickerInterval = previousInterval
		slackHeartbeatTickerLimit = previousLimit
	})

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	_, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:       "commitment",
		Title:      "Follow up owner",
		Summary:    "Ask owner whether the pending task is still blocked.",
		SourceKind: heartbeatSourceKindThread,
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		Priority:   heartbeatFollowupPriorityUrgent,
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	if err := service.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		_ = service.Shutdown(context.Background())
	})
	poster.WaitForCalls(t, 1)

	status := waitForHeartbeatTickerStatus(t, service)
	if !status.Enabled || !status.Running {
		t.Fatalf("heartbeat status = %#v, want enabled running ticker", status)
	}
	if status.LastPosted != 1 || status.LastSkipped != 0 || status.LastTickAt == "" || status.TicksLastWindow != 1 {
		t.Fatalf("heartbeat status = %#v, want one posted tick", status)
	}
	calls := poster.Calls()
	if calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" {
		t.Fatalf("post = %#v, want thread heartbeat target", calls[0])
	}
	if calls[0].DedupKey == "" {
		t.Fatalf("post dedup key empty")
	}
}

func TestHeartbeatTickerSkipsFutureFollowups(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	now := timeNow().UTC()
	_, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Title:       "Later followup",
		Summary:     "This should not surface before its next check.",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		NextCheckAt: now.Add(time.Hour).Format(time.RFC3339Nano),
		Priority:    heartbeatFollowupPriorityUrgent,
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	due, err := service.dueHeartbeatFollowups(context.Background(), now, 10)
	if err != nil {
		t.Fatalf("dueHeartbeatFollowups: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("due followups = %#v, want none", due)
	}
	response, err := service.runHeartbeatTickerOnce(context.Background(), 10)
	if err != nil {
		t.Fatalf("runHeartbeatTickerOnce: %v", err)
	}
	if len(response.Posted) != 0 || len(poster.Calls()) != 0 {
		t.Fatalf("response=%#v calls=%#v, want no surfaced future followup", response, poster.Calls())
	}
}

func waitForHeartbeatTickerStatus(t *testing.T, service *Service) SlackHeartbeatTickerStatus {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status := service.heartbeatTickerStatus()
		if status.LastTickAt != "" {
			return status
		}
		time.Sleep(10 * time.Millisecond)
	}
	return service.heartbeatTickerStatus()
}
