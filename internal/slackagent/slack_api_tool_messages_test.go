package slackagent

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSlackAPIToolPostThreadReplyUsesPublicReplyContract(t *testing.T) {
	var captured slackPublicThreadReplyDelivery
	tool := &slackAPITool{
		role: slackAPIRolePlanner,
		publicReplyDelivery: func(_ context.Context, input slackPublicThreadReplyDelivery) slackPublicThreadReplyDeliveryResult {
			captured = input
			return slackPublicThreadReplyDeliveryResult{Post: PostMessageResult{OK: true, TS: "177.999"}}
		},
	}

	result, err := tool.Execute(context.Background(), map[string]any{
		"method": "slack.postThreadReply",
		"params": map[string]any{
			"channel":        "C123",
			"thread_ts":      "177.123",
			"snapshot_ts":    "177.122",
			"text":           "visible reply",
			"ledger_summary": "planner reply",
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.Success {
		t.Fatalf("result = %#v, want success through public reply delivery", result)
	}
	if captured.Source != slackPublicReplySourceSlackAPITool ||
		captured.SurfaceKind != slackPublicReplySurfaceThreadReply ||
		captured.ChannelID != "C123" ||
		captured.ThreadTS != "177.123" ||
		captured.FallbackText != "visible reply" ||
		captured.SnapshotTS != "177.122" ||
		captured.LedgerSummary != "planner reply" {
		t.Fatalf("captured delivery = %#v, want slack_api public thread reply contract", captured)
	}
}

func TestSlackAPIToolPostThreadReplyBlocksNewerThreadActivity(t *testing.T) {
	now := time.Date(2026, time.May, 24, 10, 0, 0, 0, time.UTC)
	rootTS := formatSlackTimestamp(now)
	newerTS := formatSlackTimestamp(now.Add(time.Second))
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: rootTS, User: "U_ASKER", Text: "帮我确认一下这个"},
		{TS: newerTS, User: "U_HUMAN", Text: "我刚刚已经处理了。"},
	})
	defer restore()

	service, poster := newPublicDeliveryTestService(t)
	response, err := service.executeSlackAPITool(context.Background(), slackAPIRolePlanner, map[string]any{
		"method": "slack.postThreadReply",
		"params": map[string]any{
			"channel":     "C123",
			"thread_ts":   rootTS,
			"snapshot_ts": rootTS,
			"text":        "这条本来会公开回复。",
		},
	})
	if err != nil {
		t.Fatalf("executeSlackAPITool: %v", err)
	}
	if response.OK || !strings.Contains(response.Text, "thread_has_newer_activity") {
		t.Fatalf("response = %#v, want stale thread block", response)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no stale public post", calls)
	}
}

func TestSlackAPIToolChatPostMessagePublicChannelNoticeAllowsNoThread(t *testing.T) {
	var captured slackPublicThreadReplyDelivery
	tool := &slackAPITool{
		role: slackAPIRoleAssistant,
		publicReplyDelivery: func(_ context.Context, input slackPublicThreadReplyDelivery) slackPublicThreadReplyDeliveryResult {
			captured = input
			return slackPublicThreadReplyDeliveryResult{Post: PostMessageResult{OK: true, TS: "177.456"}}
		},
	}

	result, err := tool.Execute(context.Background(), map[string]any{
		"method": "chat.postMessage",
		"params": map[string]any{
			"purpose": "public_channel_notice",
			"channel": "C123",
			"text":    "channel notice",
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.Success {
		t.Fatalf("result = %#v, want channel notice success", result)
	}
	if captured.SurfaceKind != slackPublicReplySurfaceChannelNotice || captured.ThreadTS != "" || captured.ChannelID != "C123" {
		t.Fatalf("captured delivery = %#v, want channel notice without thread", captured)
	}
}

func TestSlackAPIToolChatPostMessagePurposeContractRejectsInvalidPublicWrites(t *testing.T) {
	tests := []struct {
		name     string
		params   map[string]any
		wantText string
	}{
		{
			name:     "missing purpose",
			params:   map[string]any{"channel": "C123", "text": "scheduled diary ready"},
			wantText: "explicit purpose",
		},
		{
			name:     "manual override without bypass reason",
			params:   map[string]any{"purpose": "manual_override", "channel": "C123", "text": "force post"},
			wantText: "bypass_reason",
		},
		{
			name: "status without dedup key",
			params: map[string]any{
				"purpose":   "status",
				"channel":   "C123",
				"thread_ts": "177.123",
				"text":      "I am still working on this.",
			},
			wantText: "dedup_key",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			httpCalls := 0
			tool := &slackAPITool{
				role:   slackAPIRoleAssistant,
				apiURL: "https://slack.example",
				token:  "xoxb-test",
				httpTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
					httpCalls++
					return nil, nil
				}),
			}

			result, err := tool.Execute(context.Background(), map[string]any{
				"method": "chat.postMessage",
				"params": tt.params,
			})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if result.Success || !strings.Contains(result.Text, tt.wantText) {
				t.Fatalf("result = %#v, want rejection containing %q", result, tt.wantText)
			}
			if httpCalls != 0 {
				t.Fatalf("httpCalls = %d, want no direct Slack call", httpCalls)
			}
		})
	}
}
