package slackagent

import (
	"context"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestDeliverSlackPublicNotificationRejectsUnknownSourceBeforePosting(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicNotification(context.Background(), slackPublicNotificationDelivery{
		Source:    "surprise_status",
		Surface:   slackPublicNotificationSurfaceStatusCard,
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Text:      "status update",
		DedupKey:  "status-1",
	})

	if !result.Blocked || result.BlockReason != "invalid_public_notification_source" {
		t.Fatalf("delivery result = %#v, want invalid source block", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want unknown source rejected before post", calls)
	}
}

func TestDeliverSlackPublicNotificationRequiresDedupKey(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicNotification(context.Background(), slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourcePendingJoinResult,
		Surface:   slackPublicNotificationSurfaceStatusCard,
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Text:      "join finished",
	})

	if !result.Blocked || result.BlockReason != "missing_public_notification_dedup_key" {
		t.Fatalf("delivery result = %#v, want missing dedup block", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want missing dedup rejected before post", calls)
	}
}

func TestDeliverSlackPublicNotificationPostsApprovalCard(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicNotification(context.Background(), slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceTriagePendingCard,
		Surface:   slackPublicNotificationSurfaceApprovalCard,
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Text:      "Triage suggestion: review this",
		DedupKey:  "approval-1",
	})

	if !result.Posted() {
		t.Fatalf("delivery result = %#v, want posted approval card", result)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" || calls[0].DedupKey != "approval-1" {
		t.Fatalf("poster calls = %#v, want approval card post contract", calls)
	}
}

func TestDeliverSlackPublicNotificationAllowsDailyReportSurface(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicNotification(context.Background(), slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceDailyReport,
		Surface:   slackPublicNotificationSurfaceDailyReport,
		ChannelID: "C_REPORT",
		Text:      "Daily report",
		DedupKey:  "daily-report:C_REPORT:2026-05-24",
	})

	if !result.Posted() {
		t.Fatalf("delivery result = %#v, want posted daily report", result)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C_REPORT" || calls[0].ThreadTS != "" {
		t.Fatalf("poster calls = %#v, want root channel daily report", calls)
	}
}

func TestDeliverSlackPublicNotificationAllowsOperatorDebugNotice(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicNotification(context.Background(), slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceOperatorDebug,
		Surface:   slackPublicNotificationSurfaceOperatorNotice,
		ChannelID: "CDEBUG",
		Text:      "operator diagnostic",
		DedupKey:  "debug_channel:CDEBUG:abc",
	})

	if !result.Posted() {
		t.Fatalf("delivery result = %#v, want posted operator debug notice", result)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "CDEBUG" || calls[0].DedupKey != "debug_channel:CDEBUG:abc" {
		t.Fatalf("poster calls = %#v, want operator debug notice contract", calls)
	}
}

func newPublicDeliveryTestService(t *testing.T) (*Service, *recordingPoster) {
	t.Helper()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	return NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		Poster: poster,
	}), poster
}
