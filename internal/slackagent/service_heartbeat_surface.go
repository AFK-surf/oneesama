package slackagent

import (
	"context"
	"fmt"
	"strings"
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
	target := heartbeatDeliveryTarget(followup, requested)
	if target.blockReason != "" {
		return s.followups.RecordSurface(ctx, heartbeatSurfaceFromFollowup(followup, requested, "", target.blockReason, ""))
	}
	post := s.poster.PostMessage(ctx, PostMessageInput{
		Channel:  target.channelID,
		ThreadTS: target.threadTS,
		Text:     heartbeatSurfaceText(followup),
		DedupKey: fmt.Sprintf("heartbeat:%d:%s:%s", followup.ID, target.channelID, target.threadTS),
	})
	status := "sent"
	errText := ""
	if !post.OK {
		status = "failed"
		errText = firstNonEmpty(post.Error, post.Detail, "post_failed")
	}
	surface, err := s.followups.RecordSurface(ctx, heartbeatSurfaceFromFollowup(followup, requested, status, "", errText))
	if err != nil {
		return nil, err
	}
	if status == "sent" {
		followup.LastSurfacedAt = nowRFC3339()
		_, _ = s.followups.UpdateFollowup(ctx, followup)
	}
	return surface, nil
}

type heartbeatDeliveryTargetResult struct {
	channelID   string
	threadTS    string
	blockReason string
}

func heartbeatDeliveryTarget(followup SlackHeartbeatFollowup, requested string) heartbeatDeliveryTargetResult {
	surface := firstNonEmpty(requested, "auto")
	switch strings.TrimSpace(surface) {
	case "", "auto", "slack_thread":
		if strings.EqualFold(followup.SourceKind, "dm") && followup.ChannelID != "" && followup.ThreadTS == "" {
			return heartbeatDeliveryTargetResult{channelID: followup.ChannelID}
		}
		if followup.ChannelID == "" || followup.ThreadTS == "" {
			return heartbeatDeliveryTargetResult{blockReason: "missing_thread_target"}
		}
		return heartbeatDeliveryTargetResult{channelID: followup.ChannelID, threadTS: followup.ThreadTS}
	case "slack_channel", "slack_dm", "dm":
		if followup.ChannelID == "" {
			return heartbeatDeliveryTargetResult{blockReason: "missing_channel_target"}
		}
		return heartbeatDeliveryTargetResult{channelID: followup.ChannelID}
	default:
		return heartbeatDeliveryTargetResult{blockReason: "unsupported_surface"}
	}
}

func heartbeatSurfaceFromFollowup(followup SlackHeartbeatFollowup, requested string, status string, blockReason string, errText string) SlackHeartbeatSurface {
	delivered := ""
	if blockReason == "" {
		delivered = firstNonEmpty(requested, "slack_thread")
	}
	return SlackHeartbeatSurface{
		FollowupID:       followup.ID,
		Title:            followup.Title,
		Summary:          followup.Summary,
		RequestedSurface: firstNonEmpty(requested, "auto"),
		DeliveredSurface: delivered,
		ChannelID:        followup.ChannelID,
		ThreadTS:         followup.ThreadTS,
		Status:           firstNonEmpty(status, "blocked"),
		BlockReason:      blockReason,
		Error:            errText,
	}
}

func heartbeatSurfaceText(followup SlackHeartbeatFollowup) string {
	return buildHeartbeatSurfaceMessage(followup.Title, followup.Summary).FallbackText
}
