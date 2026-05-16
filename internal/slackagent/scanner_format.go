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
		participants := len(msg.ReplyUsers)
		if participants == 0 {
			participants = len(msg.Replies)
		}
		fmt.Fprintf(&sb, " [thread_ts:%s, %d replies, %d participants]", ts, msg.ReplyCount, participants)
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
	var sb strings.Builder
	remaining := text
	for {
		start := strings.Index(remaining, "<@")
		if start == -1 {
			sb.WriteString(remaining)
			break
		}
		end := strings.Index(remaining[start:], ">")
		if end == -1 {
			sb.WriteString(remaining)
			break
		}
		end += start
		sb.WriteString(remaining[:start])
		uid := remaining[start+2 : end]
		name := resolveName(uid)
		sb.WriteString(formatResolvedMention(name, uid))
		remaining = remaining[end+1:]
	}
	return sb.String()
}

func formatResolvedMention(name string, uid string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.TrimSpace(uid)
	}
	if strings.HasPrefix(name, "@") || (strings.HasPrefix(name, "<@") && strings.HasSuffix(name, ">")) {
		return name
	}
	return "@" + name
}

func truncateString(value string, maxLen int) string {
	if len(value) <= maxLen {
		return value
	}
	return value[:maxLen] + "..."
}
