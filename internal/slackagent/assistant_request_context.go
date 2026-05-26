//go:build cueboardparity

package slackagent

import "strings"

type assistantRequestContext struct {
	Channel         string
	ThreadTS        string
	ThreadPermalink string
	UserText        string
}

func latestAssistantRequestContext(history []slackHistoryMessage) assistantRequestContext {
	for i := len(history) - 1; i >= 0; i-- {
		msg := history[i]
		if msg.Type != slackHistoryMessageTypeMessage || msg.Role != slackHistoryRoleUser {
			continue
		}
		text := historyMessageText(msg)
		if strings.TrimSpace(text) == "" {
			continue
		}
		ctx := parseAssistantRequestContext(text)
		if ctx.Channel != "" || ctx.ThreadTS != "" || ctx.ThreadPermalink != "" || ctx.UserText != "" {
			return ctx
		}
	}
	return assistantRequestContext{}
}

func parseAssistantRequestContext(text string) assistantRequestContext {
	var ctx assistantRequestContext

	if metadataIdx := strings.Index(text, "Thread metadata:\n"); metadataIdx != -1 {
		metadataBlock := text[metadataIdx+len("Thread metadata:\n"):]
		if end := strings.Index(metadataBlock, "\n\n"); end != -1 {
			metadataBlock = metadataBlock[:end]
		}
		for _, line := range strings.Split(metadataBlock, "\n") {
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "- channel: "):
				ctx.Channel = strings.TrimSpace(strings.TrimPrefix(line, "- channel: "))
			case strings.HasPrefix(line, "- thread_ts: "):
				ctx.ThreadTS = strings.TrimSpace(strings.TrimPrefix(line, "- thread_ts: "))
			case strings.HasPrefix(line, "- thread_permalink: "):
				ctx.ThreadPermalink = strings.TrimSpace(strings.TrimPrefix(line, "- thread_permalink: "))
			}
		}
	}

	const userMarker = "\n---\nUser <@"
	if markerIdx := strings.LastIndex(text, userMarker); markerIdx != -1 {
		userBlock := text[markerIdx+len("\n---\n"):]
		if saysIdx := strings.Index(userBlock, "> says:\n"); saysIdx != -1 {
			ctx.UserText = strings.TrimSpace(userBlock[saysIdx+len("> says:\n"):])
		}
	}

	return ctx
}

func resolveSlackUploadTarget(history []slackHistoryMessage, params map[string]any) (string, string) {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(firstNonEmpty(stringFromAny(params["thread_ts"]), stringFromAny(params["threadTs"])))

	reqCtx := latestAssistantRequestContext(history)
	if channel == "" {
		channel = strings.TrimSpace(reqCtx.Channel)
	}
	if threadTS == "" {
		threadTS = strings.TrimSpace(reqCtx.ThreadTS)
	}
	return channel, threadTS
}
