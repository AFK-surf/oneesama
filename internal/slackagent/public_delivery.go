package slackagent

import (
	"context"
	"strings"
)

const (
	slackPublicNotificationSourceTriagePendingCard   = "triage_pending_card"
	slackPublicNotificationSourceSuggestActionCard   = "suggest_action_card"
	slackPublicNotificationSourcePendingJoinResult   = "pending_join_result"
	slackPublicNotificationSourcePendingCanvasResult = "pending_canvas_result"
	slackPublicNotificationSourceMeetingWebhook      = "meeting_webhook"
	slackPublicNotificationSourceJoinSetupStatus     = "join_setup_status"
	slackPublicNotificationSourceDailyReport         = "daily_report"
	slackPublicNotificationSourceMeetingApproval     = "meeting_approval_anchor"
	slackPublicNotificationSourceOperatorDebug       = "operator_debug"
	slackPublicNotificationSurfaceApprovalCard       = "approval_card"
	slackPublicNotificationSurfaceApprovalAnchor     = "approval_anchor"
	slackPublicNotificationSurfaceStatusCard         = "status_card"
	slackPublicNotificationSurfaceMeetingNotice      = "meeting_notification"
	slackPublicNotificationSurfaceDailyReport        = "daily_report"
	slackPublicNotificationSurfaceOperatorNotice     = "operator_notice"
	slackPublicReplySourceTriageDirect               = "triage_direct"
	slackPublicReplySourcePendingApproval            = "pending_approval"
	slackPublicReplySourceWorkerResult               = "worker_result"
	slackPublicReplySourceWorkerFreshnessProbe       = "worker_result_freshness_probe"
	slackPublicReplySourceHeartbeatFollowup          = "heartbeat_followup"
	slackPublicReplySourceCanvasNotification         = "canvas_notification"
	slackPublicReplySourceInternalPostMessage        = "internal_post_message"
	slackPublicReplySourceSlackAPITool               = "slack_api_tool"
	slackPublicReplySourceEventReply                 = "event_reply"
	slackPublicReplySourceEventQueuedAck             = "event_queued_ack"
	slackPublicReplySurfaceThreadReply               = "thread_reply"
	slackPublicReplySurfaceChannelNotice             = "channel_notice"
	slackPublicReplySurfaceCanvasNotification        = "canvas_notification"
)

type slackPublicNotificationDelivery struct {
	Source        string
	Surface       string
	ChannelID     string
	ThreadTS      string
	Text          string
	Blocks        []map[string]any
	DedupKey      string
	WorkspaceID   string
	LedgerSummary string
}

type slackPublicThreadReplyDelivery struct {
	Source                 string
	SurfaceKind            string
	WorkspaceID            string
	ChannelID              string
	ThreadTS               string
	Message                string
	FallbackText           string
	Blocks                 []map[string]any
	DedupKey               string
	SnapshotTS             string
	IgnoreExistingBotReply bool
	FreshnessOnly          bool
	LedgerSummary          string
	Poster                 PosterService
}

type slackPublicDeliveryResult struct {
	Post        PostMessageResult
	Blocked     bool
	BlockReason string
	BlockedTS   string
}

func (r slackPublicDeliveryResult) Posted() bool {
	return !r.Blocked && r.Post.OK
}

type slackPublicNotificationDeliveryResult = slackPublicDeliveryResult
type slackPublicThreadReplyDeliveryResult = slackPublicDeliveryResult

func (s *Service) deliverSlackPublicNotification(ctx context.Context, input slackPublicNotificationDelivery) slackPublicNotificationDeliveryResult {
	source := strings.TrimSpace(input.Source)
	surface := strings.TrimSpace(input.Surface)
	if reason := validateSlackPublicNotificationContract(source, surface, input); reason != "" {
		return slackPublicNotificationDeliveryResult{
			Blocked:     true,
			BlockReason: reason,
			Post:        PostMessageResult{OK: false, Error: reason},
		}
	}
	postInput := slackPublicDeliveryPostInput(input.ChannelID, input.ThreadTS, input.Text, input.Blocks, input.DedupKey)
	post := s.PostMessage(ctx, postInput)
	s.recordPublicDeliveryLedger(ctx, input.WorkspaceID, postInput, post, input.LedgerSummary)
	return slackPublicNotificationDeliveryResult{Post: post}
}

func (s *Service) deliverSlackPublicThreadReply(ctx context.Context, input slackPublicThreadReplyDelivery) slackPublicThreadReplyDeliveryResult {
	source := strings.TrimSpace(input.Source)
	surface := firstNonEmpty(strings.TrimSpace(input.SurfaceKind), slackPublicReplySurfaceThreadReply)
	if reason := validateSlackPublicReplyContract(source, surface, input); reason != "" {
		return slackPublicThreadReplyDeliveryResult{
			Blocked:     true,
			BlockReason: reason,
			Post:        PostMessageResult{OK: false, Error: reason},
		}
	}
	channelID := strings.TrimSpace(input.ChannelID)
	threadTS := strings.TrimSpace(input.ThreadTS)
	snapshotTS := strings.TrimSpace(input.SnapshotTS)
	if newer, newerTS, reason := s.slackTriageThreadHasNewerBlockingActivity(ctx, channelID, threadTS, snapshotTS, input.IgnoreExistingBotReply); newer {
		if s != nil && s.logger != nil {
			s.logger.Info("slack public thread reply suppressed by freshness",
				"source", source,
				"surface", surface,
				"channel", channelID,
				"thread_ts", threadTS,
				"snapshot_ts", snapshotTS,
				"newer_ts", newerTS,
				"reason", reason,
			)
		}
		return slackPublicThreadReplyDeliveryResult{
			Blocked:     true,
			BlockReason: reason,
			BlockedTS:   newerTS,
		}
	}
	if input.FreshnessOnly {
		return slackPublicThreadReplyDeliveryResult{}
	}

	text := strings.TrimSpace(firstNonEmpty(input.FallbackText, markdownToSlackFallbackText(input.Message)))
	postInput := slackPublicDeliveryPostInput(channelID, threadTS, text, input.Blocks, input.DedupKey)
	poster := s.poster
	if input.Poster != nil {
		poster = input.Poster
	}
	post := poster.PostMessage(ctx, postInput)
	s.recordPublicDeliveryLedger(ctx, input.WorkspaceID, postInput, post, input.LedgerSummary)
	return slackPublicThreadReplyDeliveryResult{Post: post}
}

func slackPublicDeliveryPostInput(channelID string, threadTS string, text string, blocks []map[string]any, dedupKey string) PostMessageInput {
	return PostMessageInput{
		Channel:  strings.TrimSpace(channelID),
		ThreadTS: strings.TrimSpace(threadTS),
		Text:     strings.TrimSpace(text),
		Blocks:   blocks,
		DedupKey: strings.TrimSpace(dedupKey),
	}
}

func (s *Service) recordPublicDeliveryLedger(ctx context.Context, workspaceID string, postInput PostMessageInput, post PostMessageResult, ledgerSummary string) {
	if !post.OK || strings.TrimSpace(ledgerSummary) == "" {
		return
	}
	s.recordSlackOutboundLedger(ctx, firstNonEmpty(strings.TrimSpace(workspaceID), "workspace"), postInput, post, ledgerSummary)
}

func validateSlackPublicNotificationContract(source string, surface string, input slackPublicNotificationDelivery) string {
	if !slackPublicNotificationSourceAllowed(source) {
		return "invalid_public_notification_source"
	}
	if !slackPublicNotificationSurfaceAllowed(surface) {
		return "invalid_public_notification_surface"
	}
	if strings.TrimSpace(input.ChannelID) == "" {
		return "missing_public_notification_channel"
	}
	if strings.TrimSpace(input.Text) == "" {
		return "empty_public_notification_message"
	}
	if strings.TrimSpace(input.DedupKey) == "" {
		return "missing_public_notification_dedup_key"
	}
	return ""
}

func validateSlackPublicReplyContract(source string, surface string, input slackPublicThreadReplyDelivery) string {
	if !slackPublicReplySourceAllowed(source) {
		return "invalid_public_reply_source"
	}
	if !slackPublicReplySurfaceAllowed(surface) {
		return "invalid_public_reply_surface"
	}
	if strings.TrimSpace(input.ChannelID) == "" {
		return "missing_public_reply_channel"
	}
	if surface == slackPublicReplySurfaceThreadReply && strings.TrimSpace(input.ThreadTS) == "" {
		return "missing_public_reply_thread"
	}
	if input.FreshnessOnly {
		return ""
	}
	if strings.TrimSpace(firstNonEmpty(input.FallbackText, input.Message)) == "" {
		return "empty_public_reply_message"
	}
	return ""
}

func slackPublicNotificationSourceAllowed(source string) bool {
	return slackPublicDeliveryValueAllowed(source,
		slackPublicNotificationSourceTriagePendingCard,
		slackPublicNotificationSourceSuggestActionCard,
		slackPublicNotificationSourcePendingJoinResult,
		slackPublicNotificationSourcePendingCanvasResult,
		slackPublicNotificationSourceMeetingWebhook,
		slackPublicNotificationSourceJoinSetupStatus,
		slackPublicNotificationSourceDailyReport,
		slackPublicNotificationSourceMeetingApproval,
		slackPublicNotificationSourceOperatorDebug,
	)
}

func slackPublicNotificationSurfaceAllowed(surface string) bool {
	return slackPublicDeliveryValueAllowed(surface,
		slackPublicNotificationSurfaceApprovalCard,
		slackPublicNotificationSurfaceApprovalAnchor,
		slackPublicNotificationSurfaceStatusCard,
		slackPublicNotificationSurfaceMeetingNotice,
		slackPublicNotificationSurfaceDailyReport,
		slackPublicNotificationSurfaceOperatorNotice,
	)
}

func slackPublicReplySourceAllowed(source string) bool {
	return slackPublicDeliveryValueAllowed(source,
		slackPublicReplySourceTriageDirect,
		slackPublicReplySourcePendingApproval,
		slackPublicReplySourceWorkerResult,
		slackPublicReplySourceWorkerFreshnessProbe,
		slackPublicReplySourceHeartbeatFollowup,
		slackPublicReplySourceCanvasNotification,
		slackPublicReplySourceInternalPostMessage,
		slackPublicReplySourceSlackAPITool,
		slackPublicReplySourceEventReply,
		slackPublicReplySourceEventQueuedAck,
	)
}

func slackPublicReplySurfaceAllowed(surface string) bool {
	return slackPublicDeliveryValueAllowed(surface,
		slackPublicReplySurfaceThreadReply,
		slackPublicReplySurfaceChannelNotice,
		slackPublicReplySurfaceCanvasNotification,
	)
}

func slackPublicDeliveryValueAllowed(value string, allowed ...string) bool {
	value = strings.TrimSpace(value)
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
