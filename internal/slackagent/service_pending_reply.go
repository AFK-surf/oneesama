package slackagent

import (
	"context"
	"fmt"
	"strings"
)

func (s *Service) executePostThreadReplyPendingAction(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) AvatarCommandResponse {
	message := strings.TrimSpace(stringFromAny(action.Params["message"]))
	channelID := firstNonEmpty(strings.TrimSpace(action.ChannelID), stringFromAny(action.Params["channelId"]), stringFromAny(action.Params["channel_id"]))
	threadTS := firstNonEmpty(strings.TrimSpace(action.ThreadTS), stringFromAny(action.Params["threadTs"]), stringFromAny(action.Params["thread_ts"]))
	if message == "" || channelID == "" {
		text := "post_thread_reply failed: pending action missing message or channel."
		s.updatePostThreadReplyPendingResult(ctx, action.ID, "post_failed:missing_message_or_channel")
		return AvatarCommandResponse{
			OK:              true,
			ResponseType:    "ephemeral",
			Text:            text,
			Blocks:          buildPendingActionResolvedBlocks(action, interaction, "post failed"),
			ReplaceOriginal: true,
			Metadata: map[string]any{
				"pending_action": action,
				"interaction":    interaction,
				"execution":      "failed",
				"reason":         "missing_message_or_channel",
			},
		}
	}
	post := s.PostMessage(ctx, PostMessageInput{
		Channel:  channelID,
		ThreadTS: threadTS,
		Text:     markdownToSlackFallbackText(message),
		Blocks:   buildSlackThreadReplyBlocks(message, "", nil),
		DedupKey: fmt.Sprintf("pending-action-post-thread-reply:%d", action.ID),
	})
	if !post.OK {
		reason := firstNonEmpty(post.Error, post.Detail, "post_failed")
		s.updatePostThreadReplyPendingResult(ctx, action.ID, "post_failed:"+reason)
		return AvatarCommandResponse{
			OK:              true,
			ResponseType:    "ephemeral",
			Text:            "post_thread_reply failed: " + reason,
			Blocks:          buildPendingActionResolvedBlocks(action, interaction, "post failed"),
			ReplaceOriginal: true,
			Metadata: map[string]any{
				"pending_action": action,
				"interaction":    interaction,
				"execution":      "failed",
				"post":           post,
			},
		}
	}
	s.updatePostThreadReplyPendingResult(ctx, action.ID, "posted:"+firstNonEmpty(post.TS, post.ThreadTS))
	if err := s.cognition.RecordOutbound(ctx, "workspace", channelID, threadTS, "Confirmed triage reply: "+firstNonEmpty(stringFromAny(action.Params["title"]), firstLine(message))); err != nil {
		s.logger.Warn("slack pending reply outbound record failed", "pending_action_id", action.ID, "error", err)
	}
	return AvatarCommandResponse{
		OK:              true,
		ResponseType:    "ephemeral",
		Text:            fmt.Sprintf("Pending action %d confirmed; posted thread reply.", action.ID),
		Blocks:          buildPendingActionResolvedBlocks(action, interaction, "posted thread reply"),
		ReplaceOriginal: true,
		Metadata: map[string]any{
			"pending_action": action,
			"interaction":    interaction,
			"execution":      "posted",
			"post":           post,
		},
	}
}

func (s *Service) updatePostThreadReplyPendingResult(ctx context.Context, id int64, result string) {
	if s == nil || s.triage == nil || id == 0 {
		return
	}
	if _, err := s.triage.UpdatePendingAction(ctx, id, func(action *SlackPendingAction) {
		action.Result = result
		if action.Params == nil {
			action.Params = make(map[string]any)
		}
		action.Params["finalOutcome"] = result
		recordSlackVisibleReplyQualitySampleParams(action)
	}); err != nil {
		s.logger.Warn("slack pending reply result update failed", "pending_action_id", id, "error", err)
	}
}
