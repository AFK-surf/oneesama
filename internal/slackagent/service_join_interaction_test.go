package slackagent

import (
	"context"
	"strings"
	"testing"
)

func TestFinishJoinSetupInteractionWithoutResponseURLPostsStatusWithDedup(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	service.finishJoinSetupInteraction(context.Background(), AvatarCommandInput{
		Text:      "join not-a-meet-url",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U123",
	}, "")

	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" {
		t.Fatalf("poster calls = %#v, want join setup fallback status in source thread", calls)
	}
	if !strings.Contains(calls[0].Text, "Usage error") {
		t.Fatalf("status text = %q, want join setup failure details", calls[0].Text)
	}
	if calls[0].DedupKey != "join-setup:fallback:join-card:C123:123.456:meet" {
		t.Fatalf("dedup key = %q, want stable join setup fallback key", calls[0].DedupKey)
	}
}
