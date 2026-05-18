package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	heartbeatSurfaceAuto    = "auto"
	heartbeatSurfaceDM      = "dm"
	heartbeatSurfaceThread  = "thread"
	heartbeatSurfaceChannel = "channel"

	heartbeatSurfaceStatusSent         = "sent"
	heartbeatSurfaceStatusFallbackSent = "fallback_sent"
	heartbeatSurfaceStatusBlocked      = "blocked"
	heartbeatSurfaceStatusFailed       = "failed"

	heartbeatSourceKindDM      = "dm"
	heartbeatSourceKindThread  = "thread"
	heartbeatSourceKindChannel = "channel"
)

func (s *Service) SurfaceSlackFollowups(ctx context.Context, request SlackFollowupSurfaceRequest) (SlackFollowupSurfaceResponse, error) {
	if s.followups == nil {
		return SlackFollowupSurfaceResponse{OK: false, Error: "slack_domain_store_disabled"}, nil
	}
	followups, err := s.pendingHeartbeatFollowups(ctx, request)
	if err != nil {
		return SlackFollowupSurfaceResponse{}, err
	}
	response := SlackFollowupSurfaceResponse{OK: true}
	for _, followup := range followups {
		surface, err := s.surfaceOneFollowup(ctx, followup, request.Surface)
		if err != nil {
			return SlackFollowupSurfaceResponse{}, err
		}
		if surface.Status == "sent" {
			response.Posted = append(response.Posted, *surface)
		} else {
			response.Skipped = append(response.Skipped, *surface)
		}
	}
	return response, nil
}

func (s *Service) pendingHeartbeatFollowups(ctx context.Context, request SlackFollowupSurfaceRequest) ([]SlackHeartbeatFollowup, error) {
	if request.FollowupID > 0 {
		record, err := s.followups.GetFollowup(ctx, request.FollowupID)
		if err != nil || record == nil {
			return nil, err
		}
		return []SlackHeartbeatFollowup{*record}, nil
	}
	records, err := s.followups.ListFollowups(ctx, "open", request.Limit)
	if err != nil {
		return nil, err
	}
	return records, nil
}

func (s *Service) surfaceOneFollowup(ctx context.Context, followup SlackHeartbeatFollowup, requested string) (*SlackHeartbeatSurface, error) {
	now := timeNow().UTC()
	plan, err := s.planHeartbeatDelivery(ctx, requested, &followup, now)
	if err != nil {
		return s.followups.RecordSurface(ctx, heartbeatSurfaceFromPlan(followup, plan, heartbeatSurfaceStatusFailed, "", err.Error()))
	}
	if plan.DeliveredSurface == "" {
		surface, err := s.followups.RecordSurface(ctx, heartbeatSurfaceFromPlan(followup, plan, heartbeatSurfaceStatusBlocked, plan.BlockReason, ""))
		if err == nil && heartbeatFollowupClosesAfterSurface(followup) && plan.BlockReason == "thread_has_newer_activity" {
			followup.Status = "done"
			if followup.Metadata == nil {
				followup.Metadata = map[string]any{}
			}
			followup.Metadata["resolution"] = "thread_has_newer_activity"
			_, _ = s.followups.UpdateFollowup(ctx, followup)
		}
		return surface, err
	}
	message := buildHeartbeatSurfaceMessage(followup.Title, followup.Summary)
	post := s.poster.PostMessage(ctx, PostMessageInput{
		Channel:  plan.ChannelID,
		ThreadTS: heartbeatPostThreadTS(plan),
		Text:     message.FallbackText,
		Blocks:   message.Blocks,
		DedupKey: fmt.Sprintf("heartbeat:%d:%s:%s", followup.ID, plan.ChannelID, plan.ThreadTS),
	})
	status := heartbeatSurfaceStatusSent
	if plan.BlockReason != "" && plan.DeliveredSurface == heartbeatSurfaceDM {
		status = heartbeatSurfaceStatusFallbackSent
	}
	errText := ""
	if !post.OK {
		status = heartbeatSurfaceStatusFailed
		errText = firstNonEmpty(post.Error, post.Detail, "post_failed")
	}
	surface, err := s.followups.RecordSurface(ctx, heartbeatSurfaceFromPlan(followup, plan, status, plan.BlockReason, errText))
	if err != nil {
		return nil, err
	}
	if status == heartbeatSurfaceStatusSent || status == heartbeatSurfaceStatusFallbackSent {
		followup.LastSurfacedAt = now.UTC().Format(time.RFC3339Nano)
		if heartbeatFollowupClosesAfterSurface(followup) {
			followup.Status = "done"
			if followup.Metadata == nil {
				followup.Metadata = map[string]any{}
			}
			followup.Metadata["resolution"] = "surfaced_once"
		}
		_, _ = s.followups.UpdateFollowup(ctx, followup)
		if plan.DeliveredSurface == heartbeatSurfaceThread && plan.ChannelID != "" && plan.ThreadTS != "" && s.cognition != nil {
			_ = s.cognition.RecordOutbound(ctx, "workspace", plan.ChannelID, plan.ThreadTS, message.LedgerText)
		}
	}
	return surface, nil
}

func heartbeatFollowupClosesAfterSurface(followup SlackHeartbeatFollowup) bool {
	if strings.EqualFold(followup.Kind, slackDelayedNoReplyFollowupKind) {
		return true
	}
	return boolFromAny(followup.Metadata["one_shot"], false)
}

type heartbeatDeliveryPlan struct {
	RequestedSurface string
	DeliveredSurface string
	ChannelID        string
	ThreadTS         string
	BlockReason      string
}

type heartbeatDeliveryTargetResult struct {
	channelID   string
	threadTS    string
	blockReason string
}

func heartbeatDeliveryTarget(followup SlackHeartbeatFollowup, requested string) heartbeatDeliveryTargetResult {
	plan := planHeartbeatDeliveryBase(requested, &followup)
	allowDM := heartbeatAllowsDM(plan.RequestedSurface, &followup)
	if plan.DeliveredSurface == "unsupported_surface" {
		plan.BlockReason = "unsupported_surface"
		plan.DeliveredSurface = ""
	}
	if plan.DeliveredSurface == heartbeatSurfaceThread && (plan.ChannelID == "" || plan.ThreadTS == "") {
		heartbeatBlockOrFallbackToDM(&plan, "missing_thread_target", allowDM)
	}
	if plan.DeliveredSurface == heartbeatSurfaceChannel && plan.ChannelID == "" {
		heartbeatBlockOrFallbackToDM(&plan, "missing_channel_target", allowDM)
	}
	if plan.DeliveredSurface == heartbeatSurfaceDM && plan.ChannelID == "" {
		heartbeatBlockOrFallbackToDM(&plan, "missing_channel_target", false)
	}
	return heartbeatDeliveryTargetResult{channelID: plan.ChannelID, threadTS: plan.ThreadTS, blockReason: plan.BlockReason}
}

func (s *Service) planHeartbeatDelivery(ctx context.Context, requested string, followup *SlackHeartbeatFollowup, now time.Time) (heartbeatDeliveryPlan, error) {
	plan := planHeartbeatDeliveryBase(requested, followup)
	allowDM := heartbeatAllowsDM(plan.RequestedSurface, followup)

	if plan.DeliveredSurface == "unsupported_surface" {
		plan.BlockReason = "unsupported_surface"
		plan.DeliveredSurface = ""
		return plan, nil
	}
	if plan.DeliveredSurface == heartbeatSurfaceThread && (plan.ChannelID == "" || plan.ThreadTS == "") {
		heartbeatBlockOrFallbackToDM(&plan, "missing_thread_target", allowDM)
	}
	if plan.DeliveredSurface == heartbeatSurfaceChannel && plan.ChannelID == "" {
		heartbeatBlockOrFallbackToDM(&plan, "missing_channel_target", allowDM)
	}
	if plan.DeliveredSurface == heartbeatSurfaceDM && plan.ChannelID == "" {
		heartbeatBlockOrFallbackToDM(&plan, "missing_channel_target", false)
	}

	if followup == nil || plan.DeliveredSurface == heartbeatSurfaceDM || plan.DeliveredSurface == "" {
		return plan, nil
	}

	if lastSurfaced := parseHeartbeatTime(followup.LastSurfacedAt); lastSurfaced != nil && now.Sub(lastSurfaced.UTC()) < 6*time.Hour {
		heartbeatBlockOrFallbackToDM(&plan, "followup_rate_limited", allowDM)
		return plan, nil
	}
	if !strings.EqualFold(followup.Priority, heartbeatFollowupPriorityUrgent) && !heartbeatWithinPublicHours(now.In(shanghaiLocation())) {
		heartbeatBlockOrFallbackToDM(&plan, "quiet_hours", allowDM)
		return plan, nil
	}
	publicCount, err := s.followups.CountRecentPublicHeartbeatSurfaces(ctx, now.Add(-12*time.Hour))
	if err != nil {
		return plan, err
	}
	if publicCount >= 3 {
		heartbeatBlockOrFallbackToDM(&plan, "public_rate_limited", allowDM)
		return plan, nil
	}
	if plan.RequestedSurface != heartbeatSurfaceDM && plan.ThreadTS != "" && s.heartbeatThreadHasNewerActivity(ctx, followup) {
		heartbeatBlockOrFallbackToDM(&plan, "thread_has_newer_activity", allowDM)
	}
	return plan, nil
}

func planHeartbeatDeliveryBase(requested string, followup *SlackHeartbeatFollowup) heartbeatDeliveryPlan {
	surface := normalizeHeartbeatSurfaceName(requested)
	plan := heartbeatDeliveryPlan{RequestedSurface: surface}
	if surface == heartbeatSurfaceAuto {
		switch {
		case followup != nil && normalizeHeartbeatSourceKind(followup.SourceKind, followup.ChannelID, followup.ThreadTS) == heartbeatSourceKindDM && strings.TrimSpace(followup.ChannelID) != "":
			plan.DeliveredSurface = heartbeatSurfaceDM
			plan.ChannelID = strings.TrimSpace(followup.ChannelID)
			plan.ThreadTS = strings.TrimSpace(followup.ThreadTS)
		case followup != nil && strings.TrimSpace(followup.ThreadTS) != "":
			plan.DeliveredSurface = heartbeatSurfaceThread
			plan.ChannelID = strings.TrimSpace(followup.ChannelID)
			plan.ThreadTS = strings.TrimSpace(followup.ThreadTS)
		case followup != nil && strings.TrimSpace(followup.ChannelID) != "":
			plan.DeliveredSurface = heartbeatSurfaceChannel
			plan.ChannelID = strings.TrimSpace(followup.ChannelID)
		default:
			heartbeatBlockOrFallbackToDM(&plan, "no_user_visible_target", heartbeatAllowsDM(surface, followup))
		}
		return plan
	}
	plan.DeliveredSurface = surface
	if followup != nil {
		plan.ChannelID = strings.TrimSpace(followup.ChannelID)
		plan.ThreadTS = strings.TrimSpace(followup.ThreadTS)
	}
	return plan
}

func heartbeatAllowsDM(requestedSurface string, followup *SlackHeartbeatFollowup) bool {
	if normalizeHeartbeatSurfaceName(requestedSurface) == heartbeatSurfaceDM {
		return true
	}
	if followup == nil {
		return false
	}
	return normalizeHeartbeatSourceKind(followup.SourceKind, followup.ChannelID, followup.ThreadTS) == heartbeatSourceKindDM && strings.TrimSpace(followup.ChannelID) != ""
}

func heartbeatBlockOrFallbackToDM(plan *heartbeatDeliveryPlan, reason string, allowDM bool) {
	if plan == nil {
		return
	}
	plan.BlockReason = reason
	if allowDM {
		plan.DeliveredSurface = heartbeatSurfaceDM
		return
	}
	plan.DeliveredSurface = ""
}

func heartbeatSurfaceFromPlan(followup SlackHeartbeatFollowup, plan heartbeatDeliveryPlan, status string, blockReason string, errText string) SlackHeartbeatSurface {
	return SlackHeartbeatSurface{
		FollowupID:       followup.ID,
		Title:            followup.Title,
		Summary:          followup.Summary,
		RequestedSurface: firstNonEmpty(plan.RequestedSurface, heartbeatSurfaceAuto),
		DeliveredSurface: plan.DeliveredSurface,
		ChannelID:        plan.ChannelID,
		ThreadTS:         plan.ThreadTS,
		Status:           firstNonEmpty(status, "blocked"),
		BlockReason:      blockReason,
		Error:            errText,
	}
}

func heartbeatPostThreadTS(plan heartbeatDeliveryPlan) string {
	if plan.DeliveredSurface == heartbeatSurfaceThread {
		return plan.ThreadTS
	}
	if plan.DeliveredSurface == heartbeatSurfaceDM && strings.HasPrefix(plan.ChannelID, "D") {
		return plan.ThreadTS
	}
	return ""
}

func heartbeatSurfaceText(followup SlackHeartbeatFollowup) string {
	return buildHeartbeatSurfaceMessage(followup.Title, followup.Summary).FallbackText
}

func normalizeHeartbeatSurfaceName(surface string) string {
	switch strings.TrimSpace(strings.ToLower(surface)) {
	case heartbeatSurfaceDM, "slack_dm":
		return heartbeatSurfaceDM
	case heartbeatSurfaceThread, "slack_thread":
		return heartbeatSurfaceThread
	case heartbeatSurfaceChannel, "slack_channel":
		return heartbeatSurfaceChannel
	case "", heartbeatSurfaceAuto:
		return heartbeatSurfaceAuto
	default:
		return "unsupported_surface"
	}
}

func normalizeHeartbeatSourceKind(kind string, channelID string, threadTS string) string {
	switch strings.TrimSpace(strings.ToLower(kind)) {
	case heartbeatSourceKindThread, heartbeatSourceKindChannel, "meeting", heartbeatSourceKindDM:
		return strings.TrimSpace(strings.ToLower(kind))
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if strings.HasPrefix(channelID, "D") {
		return heartbeatSourceKindDM
	}
	if threadTS != "" {
		return heartbeatSourceKindThread
	}
	if channelID != "" {
		return heartbeatSourceKindChannel
	}
	return heartbeatSourceKindDM
}

func heartbeatWithinPublicHours(now time.Time) bool {
	hour := now.Hour()
	return hour >= 9 && hour < 21
}

func (s *Service) heartbeatThreadHasNewerActivity(ctx context.Context, followup *SlackHeartbeatFollowup) bool {
	if s == nil || s.cognition == nil || followup == nil {
		return false
	}
	ledger, err := s.cognition.GetThreadLedger(ctx, "workspace", followup.ChannelID, followup.ThreadTS)
	if err != nil || ledger == nil {
		return false
	}
	reference := parseHeartbeatTime(followup.UpdatedAt)
	if reference == nil {
		reference = parseHeartbeatTime(followup.CreatedAt)
	}
	if lastSurfaced := parseHeartbeatTime(followup.LastSurfacedAt); lastSurfaced != nil && (reference == nil || lastSurfaced.After(reference.UTC())) {
		reference = lastSurfaced
	}
	if reference == nil {
		return false
	}
	cutoff := reference.UTC().Add(2 * time.Minute)
	if lastUser := parseHeartbeatTime(ledger.LastUserMessageAt); lastUser != nil && lastUser.After(cutoff) {
		return true
	}
	if lastAssistant := parseHeartbeatTime(ledger.LastAssistantMessageAt); lastAssistant != nil && lastAssistant.After(cutoff) {
		return true
	}
	return false
}

func parseHeartbeatTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return &parsed
	}
	sec, seq, ok := parseSlackTSParts(value)
	if !ok {
		return nil
	}
	parsed := time.Unix(sec, seq*1000).UTC()
	return &parsed
}
