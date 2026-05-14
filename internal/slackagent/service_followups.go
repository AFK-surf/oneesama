package slackagent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

func (s *Service) SlackFollowupStatus(ctx context.Context, status string, limit int) (SlackFollowupStatus, error) {
	if s.followups == nil {
		return SlackFollowupStatus{OK: true}, nil
	}
	outbound, err := s.followups.ListOutboundActions(ctx, limit)
	if err != nil {
		return SlackFollowupStatus{}, err
	}
	recommendations, err := s.followups.ListRecommendations(ctx, limit)
	if err != nil {
		return SlackFollowupStatus{}, err
	}
	followups, err := s.followups.ListFollowups(ctx, strings.TrimSpace(status), limit)
	if err != nil {
		return SlackFollowupStatus{}, err
	}
	surfaces, err := s.followups.ListSurfaces(ctx, limit)
	if err != nil {
		return SlackFollowupStatus{}, err
	}
	return SlackFollowupStatus{
		OK:                    true,
		OutboundActions:       outbound,
		ThreadRecommendations: recommendations,
		HeartbeatFollowups:    followups,
		HeartbeatSurfaces:     surfaces,
	}, nil
}

func (s *Service) CreateSlackFollowupSurface(ctx context.Context, input SlackFollowupCreateRequest) (SlackFollowupCreateResponse, error) {
	if s.followups == nil {
		return SlackFollowupCreateResponse{OK: false, Error: "slack_domain_store_disabled"}, nil
	}
	channelID := firstNonEmpty(input.ChannelID, input.Channel, "C_FOLLOWUP")
	threadTS := firstNonEmpty(input.ThreadTS, input.ThreadTSAlt, "channel-root")
	title := firstNonEmpty(input.Title, "Follow up on Slack activity")
	summary := firstNonEmpty(input.Summary, title)
	followup, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        firstNonEmpty(input.Kind, "followup"),
		Title:       title,
		Summary:     summary,
		SourceKind:  firstNonEmpty(input.SourceKind, input.SourceKindAlt, "thread"),
		ChannelID:   channelID,
		ThreadTS:    threadTS,
		SourceRef:   firstNonEmpty(input.SourceRef, input.SourceRefAlt, channelID+":"+threadTS),
		Priority:    firstNonEmpty(input.Priority, "normal"),
		DueAt:       firstNonEmpty(input.DueAt, input.DueAtAlt),
		NextCheckAt: firstNonEmpty(input.NextCheckAt, input.NextCheckAtAlt),
		Metadata:    input.Metadata,
	})
	if err != nil {
		return SlackFollowupCreateResponse{}, err
	}
	surface, err := s.followups.RecordSurface(ctx, SlackHeartbeatSurface{
		FollowupID:       followup.ID,
		SessionID:        firstNonEmpty(input.SessionID, input.SessionIDAlt),
		Title:            title,
		Summary:          summary,
		RequestedSurface: firstNonEmpty(input.RequestedSurface, input.RequestedSurfaceAlt, "slack_thread"),
		DeliveredSurface: firstNonEmpty(input.DeliveredSurface, input.DeliveredSurfaceAlt, "slack_thread"),
		ChannelID:        channelID,
		ThreadTS:         threadTS,
		Status:           firstNonEmpty(input.SurfaceStatus, input.SurfaceStatusAlt, "sent"),
		BlockReason:      firstNonEmpty(input.BlockReason, input.BlockReasonAlt),
		Error:            input.Error,
	})
	if err != nil {
		return SlackFollowupCreateResponse{}, err
	}
	recommendation, outbound, err := s.createFollowupSideEffects(ctx, input, channelID, threadTS, surface.ID, summary)
	if err != nil {
		return SlackFollowupCreateResponse{}, err
	}
	status := firstNonEmpty(input.FollowupStatus, input.FollowupStatusAlt)
	if status != "" {
		followup.Status = status
		followup, err = s.followups.UpdateFollowup(ctx, *followup)
		if err != nil {
			return SlackFollowupCreateResponse{}, err
		}
	}
	current, err := s.SlackFollowupStatus(ctx, "", followupLimit(input.Limit))
	if err != nil {
		return SlackFollowupCreateResponse{}, err
	}
	return SlackFollowupCreateResponse{OK: true, Followup: followup, Surface: surface, Recommendation: recommendation, Outbound: outbound, Status: current}, nil
}

func followupLimit(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case float64:
		return int(typed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 20
	}
}

func (s *Service) createFollowupSideEffects(ctx context.Context, input SlackFollowupCreateRequest, channelID string, threadTS string, surfaceID int64, summary string) (*SlackThreadRecommendation, *SlackOutboundAction, error) {
	var recommendation *SlackThreadRecommendation
	if recType := firstNonEmpty(input.RecommendationType, input.RecommendationTypeAlt); recType != "" {
		record, err := s.followups.ReserveThreadRecommendation(ctx, SlackThreadRecommendation{
			ChannelID:          channelID,
			ThreadTS:           threadTS,
			RecommendationType: recType,
			Status:             firstNonEmpty(input.RecommendationStatus, input.RecommendationStatusAlt, "active"),
			CardTS:             firstNonEmpty(input.CardTS, input.CardTSAlt, fmt.Sprint(surfaceID)),
		})
		if err != nil {
			return nil, nil, err
		}
		recommendation = record
	}
	var outbound *SlackOutboundAction
	if actionType := firstNonEmpty(input.OutboundActionType, input.OutboundActionTypeAlt); actionType != "" {
		record, err := s.followups.ReserveOutboundAction(ctx, SlackOutboundAction{
			ActionType: actionType,
			Target:     firstNonEmpty(input.Target, channelID),
			Reference:  firstNonEmpty(input.Reference, fmt.Sprintf("%s:%s:%d", channelID, threadTS, surfaceID)),
			SessionID:  firstNonEmpty(input.SessionID, input.SessionIDAlt),
			Summary:    summary,
			Status:     firstNonEmpty(input.OutboundStatus, input.OutboundStatusAlt, "sent"),
		})
		if err != nil {
			return nil, nil, err
		}
		outbound = record
	}
	return recommendation, outbound, nil
}
