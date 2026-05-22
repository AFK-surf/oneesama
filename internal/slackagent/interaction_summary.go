package slackagent

import "strings"

const (
	slackActionTypeCreateIssue   = "create_issue"
	slackActionTypeAddComment    = "add_comment"
	slackActionTypeCreateEvent   = "create_event"
	slackActionTypeJoinMeeting   = "join_meeting"
	slackActionTypeCreateChannel = "create_channel"
	slackActionTypeCreateCanvas  = "create_canvas"
	slackActionTypeEditCanvas    = "edit_canvas"
	slackActionTypeThreadReply   = "post_thread_reply"
)

func summarizeHandledThreadAction(actionType, resultText string) string {
	rawText := strings.TrimSpace(resultText)
	text := trimSlackResultMarkup(rawText)
	if text == "" {
		return ""
	}

	switch actionType {
	case slackActionTypeCreateIssue:
		if ident := betweenText(text, "Created ", ":"); ident != "" {
			return "created Linear issue " + strings.TrimSpace(ident)
		}
		return "created Linear issue"
	case slackActionTypeAddComment:
		if ident := strings.TrimSpace(strings.TrimPrefix(text, "Comment added to ")); ident != "" {
			return "added comment to " + ident
		}
		return "added Linear comment"
	case slackActionTypeCreateEvent:
		if title := strings.TrimSpace(strings.TrimPrefix(trimSlackResultMarkup(firstTextLine(rawText)), "Created meeting: ")); title != "" {
			return "created meeting " + title
		}
		return "created meeting"
	case slackActionTypeJoinMeeting:
		if title := strings.TrimSpace(strings.TrimPrefix(trimSlackResultMarkup(firstTextLine(rawText)), "Bot is joining ")); title != "" {
			return "joined meeting " + title
		}
		return "joined meeting"
	case slackActionTypeCreateChannel:
		if name := strings.TrimSpace(strings.TrimPrefix(text, "Created channel ")); name != "" {
			return "created Slack channel " + name
		}
		return "created Slack channel"
	default:
		return truncateSlackContextText(text, channelBrainNoteMaxLen)
	}
}

func trimSlackResultMarkup(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	replacer := strings.NewReplacer("*", "", "`", "", "_", "")
	text = replacer.Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

func firstTextLine(text string) string {
	if idx := strings.IndexAny(text, "\r\n"); idx >= 0 {
		return text[:idx]
	}
	return text
}

func betweenText(text, start, end string) string {
	startIdx := strings.Index(text, start)
	if startIdx == -1 {
		return ""
	}
	startIdx += len(start)
	endIdx := strings.Index(text[startIdx:], end)
	if endIdx == -1 {
		return strings.TrimSpace(text[startIdx:])
	}
	return strings.TrimSpace(text[startIdx : startIdx+endIdx])
}
