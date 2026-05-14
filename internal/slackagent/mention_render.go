package slackagent

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const mentionTimeout = 30 * time.Minute

var replyUnderscoreItalicRe = regexp.MustCompile(`_([^_\n]+?)_`)

func buildSlackThreadReplyBlocks(text string, thinking string, footer []map[string]any) []map[string]any {
	text = softenSlackThreadReplyMarkdown(text)
	var blocks []map[string]any
	if strings.TrimSpace(thinking) != "" {
		if len(thinking) > 2000 {
			thinking = thinking[:2000] + "..."
		}
		blocks = append(blocks, slackContextBlock(":thought_balloon: _"+thinking+"_"))
	}
	blocks = append(blocks, markdownToBlocks(text)...)
	return append(blocks, footer...)
}

func buildReplyFooterBlocks(sessionID string) []map[string]any {
	text := ":robot_face: _Onee Sama Agent_"
	if strings.TrimSpace(sessionID) != "" {
		text += "  |  `" + shortSlackID(sessionID) + "`"
	}
	return []map[string]any{{
		"type":     "section",
		"block_id": replyFeedbackBlockID,
		"text": map[string]any{
			"type": "mrkdwn",
			"text": text,
		},
		"accessory": map[string]any{
			"type":      "overflow",
			"action_id": "reply_feedback",
			"options": []map[string]any{
				{"value": "helpful", "text": map[string]any{"type": "plain_text", "text": "Helpful"}},
				{"value": "not_helpful", "text": map[string]any{"type": "plain_text", "text": "Not helpful"}},
			},
		},
	}}
}

func slackContextBlock(text string) map[string]any {
	return map[string]any{
		"type": "context",
		"elements": []map[string]any{{
			"type": "mrkdwn",
			"text": text,
		}},
	}
}

func shortSlackID(id string) string {
	id = strings.TrimSpace(id)
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

func softenSlackThreadReplyMarkdown(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	text = mdBoldItalicRe.ReplaceAllString(text, phBIOpen+"$1"+phBIClose)
	text = mdBoldRe.ReplaceAllString(text, phBOpen+"$1"+phBClose)
	text = mdItalicRe.ReplaceAllString(text, "$1")
	text = replyUnderscoreItalicRe.ReplaceAllString(text, "$1")
	text = strings.ReplaceAll(text, phBIOpen, "***")
	text = strings.ReplaceAll(text, phBIClose, "***")
	text = strings.ReplaceAll(text, phBOpen, "**")
	text = strings.ReplaceAll(text, phBClose, "**")
	return text
}

func messageSummaryForFeedback(message SlackMessage) string {
	if text := strings.TrimSpace(message.Text); text != "" {
		return text
	}
	var parts []string
	for _, block := range message.Blocks {
		if block.BlockID == replyFeedbackBlockID || block.BlockID == replyFeedbackSavedBlockID {
			continue
		}
		switch block.Type {
		case "section":
			if block.Text != nil && strings.TrimSpace(block.Text.Text) != "" {
				parts = append(parts, strings.TrimSpace(block.Text.Text))
			}
		case "context":
			for _, element := range block.Elements {
				if element.Text != nil && strings.TrimSpace(element.Text.Text) != "" {
					parts = append(parts, strings.TrimSpace(element.Text.Text))
				}
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func mentionFailureReply(ctxErr error, errMsg string) string {
	switch {
	case errors.Is(ctxErr, context.DeadlineExceeded):
		return fmt.Sprintf(":warning: Request timed out after %v.\n```%s```", mentionTimeout, errMsg)
	case errors.Is(ctxErr, context.Canceled):
		return fmt.Sprintf(":warning: Request was interrupted before completion.\n```%s```", errMsg)
	default:
		return fmt.Sprintf(":warning: Request was interrupted.\n```%s```", errMsg)
	}
}

func mentionCompactionReply() string {
	return ":hourglass_flowing_sand: Context is getting long, so I'm compressing it before I continue."
}

func mentionLoopError(runErr error, result AvatarCommandResponse) error {
	if runErr != nil {
		return runErr
	}
	if !result.OK && strings.TrimSpace(result.Text) != "" {
		return errors.New(strings.TrimSpace(result.Text))
	}
	return nil
}

func latestAssistantTextSince(history []slackHistoryMessage, since time.Time) string {
	for i := len(history) - 1; i >= 0; i-- {
		msg := history[i]
		if msg.Type != slackHistoryMessageTypeMessage || msg.Role != slackHistoryRoleAssistant {
			continue
		}
		if !msg.Timestamp.IsZero() && msg.Timestamp.Before(since) {
			break
		}
		text := historyMessageText(msg)
		if strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}
