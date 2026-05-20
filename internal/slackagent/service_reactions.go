package slackagent

import (
	"context"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	slackReactionEyes  = "eyes"
	slackReactionOK    = "white_check_mark"
	slackReactionWarn  = "warning"
	slackReactionNoEnt = "no_entry"
)

func (s *Service) addSlackReaction(ctx context.Context, channelID, timestamp, name string) {
	s.callSlackReaction(ctx, true, channelID, timestamp, name)
}

func (s *Service) removeSlackReaction(ctx context.Context, channelID, timestamp, name string) {
	s.callSlackReaction(ctx, false, channelID, timestamp, name)
}

func (s *Service) callSlackReaction(ctx context.Context, add bool, channelID, timestamp, name string) {
	if s == nil || s.reactions == nil || strings.TrimSpace(channelID) == "" || strings.TrimSpace(timestamp) == "" || strings.TrimSpace(name) == "" {
		return
	}
	input := SlackReactionInput{Channel: channelID, Timestamp: timestamp, Name: name}
	var result SlackReactionResult
	if add {
		result = s.reactions.AddReaction(ctx, input)
	} else {
		result = s.reactions.RemoveReaction(ctx, input)
	}
	if result.OK || reactionErrorIsIgnored(add, result.Error) {
		return
	}
	action := "remove"
	if add {
		action = "add"
	}
	s.logger.Warn("slack reaction update failed", "action", action, "channel", channelID, "timestamp", timestamp, "emoji", name, "error", result.Error, "detail", result.Detail, "status", result.Status)
}

func reactionErrorIsIgnored(add bool, err string) bool {
	if add {
		return err == "already_reacted"
	}
	return err == "no_reaction"
}

func slackReactionBodyError(result SlackReactionResult) string {
	if result.Body == nil {
		return ""
	}
	return strings.TrimSpace(result.Body.Error)
}

func (s *Service) finishMentionReaction(ctx context.Context, ref AssistantThreadRef, emoji string) {
	if strings.TrimSpace(ref.ReactionTS) == "" {
		return
	}
	s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
	s.addSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, emoji)
}

func reactionEmojiForCommand(response AvatarCommandResponse) string {
	status, hasJob := avatarCommandJobStatus(response)
	if !response.OK || (hasJob && (status == agentrunner.StatusFailed || status == agentrunner.StatusTimeout)) {
		return slackReactionWarn
	}
	return slackReactionOK
}
