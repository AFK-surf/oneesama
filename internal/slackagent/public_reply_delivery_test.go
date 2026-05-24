package slackagent

import (
	"context"
	"testing"
	"time"
)

func TestDeliverSlackPublicThreadReplyBlocksStaleThreadConsistentlyAcrossSources(t *testing.T) {
	now := time.Date(2026, time.May, 24, 10, 0, 0, 0, time.UTC)
	snapshotTS := formatSlackTimestamp(now)
	newerTS := formatSlackTimestamp(now.Add(time.Second))
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: snapshotTS, User: "U_ASKER", Text: "这条需要帮忙看一下"},
		{TS: newerTS, User: "U_HUMAN", Text: "我已经回答了，不需要再发。"},
	})
	defer restore()

	for _, source := range []string{slackPublicReplySourceTriageDirect, slackPublicReplySourcePendingApproval, slackPublicReplySourceWorkerResult} {
		t.Run(source, func(t *testing.T) {
			service, poster := newPublicDeliveryTestService(t)

			result := service.deliverSlackPublicThreadReply(context.Background(), slackPublicThreadReplyDelivery{
				Source:        source,
				SurfaceKind:   slackPublicReplySurfaceThreadReply,
				WorkspaceID:   "workspace",
				ChannelID:     "C123",
				ThreadTS:      snapshotTS,
				Message:       "这是本来准备公开发出的回复。",
				Blocks:        buildSlackThreadReplyBlocks("这是本来准备公开发出的回复。", "", nil),
				DedupKey:      "test-public-reply:" + source,
				SnapshotTS:    snapshotTS,
				LedgerSummary: source + ": test reply",
			})

			if !result.Blocked || result.BlockReason != "thread_has_newer_activity" || result.BlockedTS != newerTS {
				t.Fatalf("delivery result = %#v, want consistent freshness block", result)
			}
			if calls := poster.Calls(); len(calls) != 0 {
				t.Fatalf("poster calls = %#v, want no stale public reply", calls)
			}
		})
	}
}

func TestDeliverSlackPublicThreadReplyRejectsUnknownSourceBeforePosting(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicThreadReply(context.Background(), slackPublicThreadReplyDelivery{
		Source:      "surprise_public_post",
		SurfaceKind: slackPublicReplySurfaceThreadReply,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		Message:     "this should not post",
		DedupKey:    "surprise",
	})

	if !result.Blocked || result.BlockReason != "invalid_public_reply_source" {
		t.Fatalf("delivery result = %#v, want invalid source block", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want unknown source rejected before post", calls)
	}
}

func TestDeliverSlackPublicThreadReplyRequiresThreadForThreadReplySurface(t *testing.T) {
	service, poster := newPublicDeliveryTestService(t)

	result := service.deliverSlackPublicThreadReply(context.Background(), slackPublicThreadReplyDelivery{
		Source:      slackPublicReplySourceTriageDirect,
		SurfaceKind: slackPublicReplySurfaceThreadReply,
		ChannelID:   "C123",
		Message:     "this should not post without a thread",
		DedupKey:    "missing-thread",
	})

	if !result.Blocked || result.BlockReason != "missing_public_reply_thread" {
		t.Fatalf("delivery result = %#v, want missing thread block", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want missing thread rejected before post", calls)
	}
}
