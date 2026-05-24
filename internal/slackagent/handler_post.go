package slackagent

import (
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type postMessageRequest struct {
	Channel       string           `json:"channel"`
	Text          string           `json:"text"`
	ThreadTS      string           `json:"thread_ts"`
	DedupKey      string           `json:"dedup_key"`
	Blocks        []map[string]any `json:"blocks"`
	Purpose       string           `json:"purpose"`
	SurfaceKind   string           `json:"surface_kind"`
	WorkspaceID   string           `json:"workspace_id"`
	SnapshotTS    string           `json:"snapshot_ts"`
	LedgerSummary string           `json:"ledger_summary"`
	BypassReason  string           `json:"bypass_reason"`
}

func (h *Handler) handlePostMessage(c *gin.Context) {
	var request postMessageRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid post message body", gin.H{"reason": err.Error()}))
		return
	}

	purpose := normalizePostMessagePurpose(request.Purpose)
	if purpose == "" && strings.TrimSpace(request.Purpose) != "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid post message purpose", gin.H{"purpose": request.Purpose}))
		return
	}
	if purpose == postMessagePurposeManualOverride && strings.TrimSpace(request.BypassReason) == "" {
		httputil.AbortWithError(c, httputil.InvalidRequestError("manual override requires bypass_reason", gin.H{"purpose": request.Purpose}))
		return
	}
	if purpose == "" && !strings.HasPrefix(strings.TrimSpace(request.Channel), "D") {
		httputil.AbortWithError(c, httputil.InvalidRequestError("public Slack post requires purpose", gin.H{"purpose": "required"}))
		return
	}
	if postMessagePurposeUsesPublicReplyHelper(purpose) {
		surfaceKind := postMessagePublicSurfaceKind(purpose, request.SurfaceKind)
		delivery := h.service.deliverSlackPublicThreadReply(c.Request.Context(), slackPublicThreadReplyDelivery{
			Source:        slackPublicReplySourceInternalPostMessage,
			SurfaceKind:   surfaceKind,
			WorkspaceID:   request.WorkspaceID,
			ChannelID:     request.Channel,
			ThreadTS:      request.ThreadTS,
			FallbackText:  request.Text,
			Blocks:        request.Blocks,
			DedupKey:      request.DedupKey,
			SnapshotTS:    request.SnapshotTS,
			LedgerSummary: request.LedgerSummary,
		})
		status := postMessageDeliveryStatus(delivery)
		c.JSON(status, gin.H{
			"ok":           delivery.Posted(),
			"posted":       delivery.Post,
			"blocked":      delivery.Blocked,
			"block_reason": delivery.BlockReason,
			"blocked_ts":   delivery.BlockedTS,
			"purpose":      purpose,
		})
		return
	}

	result := h.service.PostMessage(c.Request.Context(), PostMessageInput{
		Channel:  request.Channel,
		Text:     request.Text,
		ThreadTS: request.ThreadTS,
		DedupKey: request.DedupKey,
		Blocks:   request.Blocks,
	})
	c.JSON(postMessageStatus(result), gin.H{
		"ok":            result.OK,
		"posted":        result,
		"purpose":       firstNonEmpty(purpose, "legacy_unspecified"),
		"escape_hatch":  purpose != "",
		"legacy_direct": purpose == "",
	})
}

const (
	postMessagePurposePublicThreadReply   = "public_thread_reply"
	postMessagePurposePublicChannelNotice = "public_channel_notice"
	postMessagePurposeCanvasNotification  = "canvas_notification"
	postMessagePurposeOperatorNotice      = "operator_notice"
	postMessagePurposeStatus              = "status"
	postMessagePurposeStatusUpdate        = "status_update"
	postMessagePurposeControlPlane        = "control_plane"
	postMessagePurposeManualOverride      = "manual_override"
	postMessagePurposeMeetingNotification = "meeting_notification"
)

func normalizePostMessagePurpose(purpose string) string {
	switch strings.TrimSpace(strings.ToLower(purpose)) {
	case "":
		return ""
	case postMessagePurposePublicThreadReply,
		postMessagePurposePublicChannelNotice,
		postMessagePurposeCanvasNotification,
		postMessagePurposeOperatorNotice,
		postMessagePurposeStatus,
		postMessagePurposeStatusUpdate,
		postMessagePurposeControlPlane,
		postMessagePurposeManualOverride,
		postMessagePurposeMeetingNotification:
		return strings.TrimSpace(strings.ToLower(purpose))
	default:
		return ""
	}
}

func postMessagePurposeUsesPublicReplyHelper(purpose string) bool {
	switch purpose {
	case postMessagePurposePublicThreadReply,
		postMessagePurposePublicChannelNotice,
		postMessagePurposeCanvasNotification:
		return true
	default:
		return false
	}
}

func postMessagePublicSurfaceKind(purpose string, requested string) string {
	if surface := strings.TrimSpace(requested); surface != "" {
		return surface
	}
	switch purpose {
	case postMessagePurposePublicChannelNotice:
		return slackPublicReplySurfaceChannelNotice
	case postMessagePurposeCanvasNotification:
		return slackPublicReplySurfaceCanvasNotification
	default:
		return slackPublicReplySurfaceThreadReply
	}
}

func postMessageDeliveryStatus(result slackPublicThreadReplyDeliveryResult) int {
	if result.Blocked {
		switch result.BlockReason {
		case "thread_has_newer_activity", "thread_has_newer_bot_activity":
			return http.StatusOK
		default:
			return http.StatusBadRequest
		}
	}
	return postMessageStatus(result.Post)
}

func postMessageStatus(result PostMessageResult) int {
	if result.OK {
		return http.StatusOK
	}
	if strings.HasPrefix(result.Error, "missing_") {
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}
