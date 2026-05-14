package slackagent

import "context"

func (s *Service) HandleSlackInteraction(ctx context.Context, payload SlackInteractionPayload) AvatarCommandResponse {
	if pendingAction := parsePendingActionInteraction(payload); pendingAction != nil {
		return s.HandlePendingActionInteraction(ctx, *pendingAction)
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

	return s.RunAvatarCommand(ctx, command)
}
