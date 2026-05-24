package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunCreateCanvasPendingActionBlocksStaleThreadBeforePublisher(t *testing.T) {
	now := time.Date(2026, time.May, 24, 10, 0, 0, 0, time.UTC)
	rootTS := formatSlackTimestamp(now)
	newerTS := formatSlackTimestamp(now.Add(time.Second))
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: rootTS, User: "U_ASKER", Text: "整理成 Canvas 吧"},
		{TS: newerTS, User: "U_HUMAN", Text: "我已经整理好了，不用再发。"},
	})
	defer restore()

	service, poster := newPublicDeliveryTestService(t)

	response := service.runCreateCanvasPendingAction(context.Background(), SlackPendingAction{
		ID:        42,
		ChannelID: "C123",
		ThreadTS:  rootTS,
		CreatedAt: now.Format(time.RFC3339Nano),
		Params: map[string]any{
			"title":    "Thread notes",
			"markdown": "# Thread notes\n",
		},
	}, SlackPendingActionInteraction{})

	if response.OK || !strings.Contains(response.Text, "thread_has_newer_activity") {
		t.Fatalf("response = %#v, want stale canvas block", response)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != rootTS {
		t.Fatalf("poster calls = %#v, want blocked status in source thread", calls)
	}
	if !strings.Contains(calls[0].Text, "create_canvas blocked") {
		t.Fatalf("status text = %q, want blocked canvas status", calls[0].Text)
	}
	if calls[0].DedupKey != "slack-pending-create_canvas-result:42" {
		t.Fatalf("status dedup = %q, want pending canvas result dedup", calls[0].DedupKey)
	}
}
