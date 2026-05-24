package slackagent

import (
	"context"
	"fmt"
	"strings"
)

func (s *Service) executeJoinMeetingPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	response := s.runJoinMeetingPendingAction(ctx, action, interaction)
	resultText := strings.TrimSpace(response.Text)
	if resultText == "" {
		if response.OK {
			resultText = "join_meeting executed"
		} else {
			resultText = "join_meeting failed"
		}
	}
	if _, err := s.triage.UpdatePendingAction(ctx, action.ID, func(record *SlackPendingAction) {
		record.Result = resultText
	}); err != nil {
		s.logger.Warn("slack pending join result update failed", "pending_action_id", action.ID, "error", err)
	}
}

func (s *Service) runJoinMeetingPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) AvatarCommandResponse {
	meetURL := s.pendingJoinMeetingURL(ctx, action)
	if meetURL == "" {
		response := AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Join failed: join_meeting pending action did not contain a Google Meet URL.",
		}
		s.postPendingJoinMeetingResult(ctx, action, interaction.ResponseURL, response)
		return response
	}

	parsed := parseAvatarCommand("join " + meetURL + " --confirm")
	response := s.runJoinCommand(ctx, AvatarCommandInput{
		Text:      "join " + meetURL,
		ChannelID: action.ChannelID,
		ThreadTS:  action.ThreadTS,
		UserID:    firstNonEmpty(interaction.UserID, action.ConfirmedBy),
		Command:   "pending_action_confirm",
	}, parsed)
	response.ReplaceOriginal = true
	s.postPendingJoinMeetingResult(ctx, action, interaction.ResponseURL, response)
	if response.OK {
		if err := s.cognition.RecordOutbound(ctx, "workspace", action.ChannelID, action.ThreadTS, "joined meeting "+joinMeetingDisplayTitle(meetURL)); err != nil {
			s.logger.Warn("slack pending join outbound record failed", "pending_action_id", action.ID, "error", err)
		}
	}
	return response
}

func (s *Service) pendingJoinMeetingURL(ctx context.Context, action SlackPendingAction) string {
	for _, key := range []string{"meet_url", "meetUrl", "meeting_url", "meetingUrl", "url", "link"} {
		if meetURL := findSlackMeetURL(stringFromAny(action.Params[key])); meetURL != "" {
			return meetURL
		}
	}
	for _, key := range []string{"title", "message", "reason", "summary"} {
		if meetURL := findSlackMeetURL(stringFromAny(action.Params[key])); meetURL != "" {
			return meetURL
		}
	}
	if strings.TrimSpace(action.ChannelID) == "" || strings.TrimSpace(action.ThreadTS) == "" {
		return ""
	}
	response, err := s.callSlackConversationsReplies(ctx, action.ChannelID, action.ThreadTS)
	if err != nil {
		s.logger.Warn("slack pending join thread fetch failed", "pending_action_id", action.ID, "error", err)
		return ""
	}
	for _, message := range response.Messages {
		if meetURL := findSlackMeetURL(message.Text); meetURL != "" {
			return meetURL
		}
	}
	return ""
}

func (s *Service) postPendingJoinMeetingResult(ctx context.Context, action SlackPendingAction, responseURL string, response AvatarCommandResponse) {
	if strings.TrimSpace(responseURL) != "" {
		if err := postSlackInteractionResponse(ctx, responseURL, response); err != nil {
			s.logger.Warn("slack pending join response update failed", "pending_action_id", action.ID, "error", err)
		}
		return
	}
	if strings.TrimSpace(action.ChannelID) == "" || strings.TrimSpace(action.ThreadTS) == "" {
		return
	}
	text := strings.TrimSpace(response.Text)
	if text == "" {
		text = fmt.Sprintf("Pending action %d finished.", action.ID)
	}
	post := s.deliverSlackPublicNotification(ctx, slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourcePendingJoinResult,
		Surface:   slackPublicNotificationSurfaceStatusCard,
		ChannelID: action.ChannelID,
		ThreadTS:  action.ThreadTS,
		Text:      text,
		Blocks:    response.Blocks,
		DedupKey:  fmt.Sprintf("slack-pending-join-result:%d", action.ID),
	}).Post
	if !post.OK {
		s.logger.Warn("slack pending join result post failed", "pending_action_id", action.ID, "error", post.Error, "detail", post.Detail)
	}
}
