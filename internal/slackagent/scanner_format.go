package slackagent

import (
	"fmt"
	"strings"
)

func formatMessageLine(msg SlackMessage, resolveName func(string) string, ref string) string {
	var sb strings.Builder
	senderName := resolveName(firstNonEmpty(msg.User, msg.UserID, msg.UserIDCamel))
	if msg.BotID != "" && firstNonEmpty(msg.User, msg.UserID, msg.UserIDCamel) == "" {
		if msg.Username != "" {
			senderName = msg.Username
		} else {
			senderName = "bot"
		}
		senderName += " [app]"
	}

	text := truncateString(resolveTextMentions(msg.Text, resolveName), 200)
	ts := firstNonEmpty(msg.TS, msg.EventTS)
	if strings.TrimSpace(ref) != "" {
		fmt.Fprintf(&sb, "• [ref:%s msg_ts:%s] %s: %q", ref, ts, senderName, text)
	} else {
		fmt.Fprintf(&sb, "• [msg_ts:%s] %s: %q", ts, senderName, text)
	}

	if msg.ReplyCount > 0 {
		fmt.Fprintf(&sb, " [thread_ts:%s, %d replies, %d participants]", ts, msg.ReplyCount, len(msg.Replies))
	} else if msg.ThreadTS != "" && msg.ThreadTS != ts {
		fmt.Fprintf(&sb, " [reply in thread_ts:%s]", msg.ThreadTS)
	}

	for _, file := range msg.Files {
		fmt.Fprintf(&sb, " [file_id:%s, name: %s, type: %s]", file.ID, file.Name, file.Mimetype)
	}
	if len(msg.Reactions) > 0 {
		sb.WriteString(" [reactions: ")
		for i, reaction := range msg.Reactions {
			if i > 0 {
				sb.WriteString(", ")
			}
			fmt.Fprintf(&sb, ":%s: ×%d", reaction.Name, reaction.Count)
		}
		sb.WriteString("]")
	}
	return sb.String()
}

func resolveTextMentions(text string, resolveName func(string) string) string {
	if resolveName == nil {
		return text
	}
	for {
		start := strings.Index(text, "<@")
		if start == -1 {
			break
		}
		end := strings.Index(text[start:], ">")
		if end == -1 {
			break
		}
		end += start
		uid := text[start+2 : end]
		name := resolveName(uid)
		text = text[:start] + "@" + name + text[end+1:]
	}
	return text
}

func truncateString(value string, maxLen int) string {
	if len(value) <= maxLen {
		return value
	}
	return value[:maxLen] + "..."
}
