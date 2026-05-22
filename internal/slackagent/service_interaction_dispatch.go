package slackagent

import (
	"context"
	"strings"
)

func (s *Service) HandleSlackInteraction(ctx context.Context, payload SlackInteractionPayload) AvatarCommandResponse {
	if pendingAction := parsePendingActionInteraction(payload); pendingAction != nil {
		response := s.HandlePendingActionInteraction(ctx, *pendingAction)
		response.Metadata = nil
		return response
	}

	if replyFeedback := parseReplyFeedbackInteraction(payload); replyFeedback != nil {
		return s.HandleReplyFeedbackInteraction(ctx, *replyFeedback)
	}

	if response, ok := joinSetupCaptionSelectionResponse(payload); ok {
		return response
	}

	if command, ok := joinSetupCommandInputFromInteraction(payload); ok {
		return s.StartJoinSetupInteraction(ctx, command, payload.ResponseURL)
	}

	command := avatarCommandInputFromInteraction(payload)
	if command.Text == "" {
		return AvatarCommandResponse{
			OK:           true,
			ResponseType: "ephemeral",
			Text:         "Action received. This interactive control has no meeting-avatar command attached yet.",
		}
	}

	if slackInteractionHasExplicitUnhandledActionID(payload) {
		return AvatarCommandResponse{
			OK:           true,
			ResponseType: "ephemeral",
			Text:         "Action received. This interactive control is not handled by meeting-avatar.",
		}
	}

	return s.RunAvatarCommand(ctx, command)
}

func slackInteractionHasExplicitUnhandledActionID(payload SlackInteractionPayload) bool {
	for _, action := range payload.Actions {
		if strings.TrimSpace(action.ActionID) != "" {
			return true
		}
	}
	return false
}
