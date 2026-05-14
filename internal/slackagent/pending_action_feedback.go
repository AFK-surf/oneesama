package slackagent

import "strings"

func pendingActionFeedbackSummary(action *SlackPendingAction, resultText string) string {
	resultText = strings.TrimSpace(resultText)
	if summary := summarizePendingActionResult(action, resultText); summary != "" {
		return truncateSlackContextText(summary, 80)
	}
	if summary := summarizePendingActionParams(action); summary != "" {
		return truncateSlackContextText(summary, 80)
	}
	if resultText != "" {
		return truncateSlackContextText(resultText, 80)
	}
	if action != nil && len(action.Params) > 0 {
		return truncateSlackContextText(strings.TrimSpace(stringFromAny(action.Params)), 80)
	}
	return "n/a"
}

func summarizePendingActionResult(action *SlackPendingAction, resultText string) string {
	if action == nil || resultText == "" {
		return ""
	}
	switch action.ActionType {
	case slackActionTypeCreateIssue:
		line := strings.TrimSpace(firstTextLine(resultText))
		if strings.HasPrefix(line, "Created *") {
			return line
		}
	case slackActionTypeAddComment:
		line := strings.TrimSpace(firstTextLine(resultText))
		if line != "" {
			return line
		}
	}
	return ""
}

func summarizePendingActionParams(action *SlackPendingAction) string {
	if action == nil {
		return ""
	}
	switch action.ActionType {
	case slackActionTypeCreateIssue:
		return strings.TrimSpace(stringFromAny(action.Params["title"]))
	case slackActionTypeAddComment:
		target := strings.TrimSpace(firstNonEmpty(
			stringFromAny(action.Params["issue_identifier"]),
			stringFromAny(action.Params["issueIdentifier"]),
			stringFromAny(action.Params["issue_id"]),
			stringFromAny(action.Params["issueId"]),
		))
		body := strings.TrimSpace(stringFromAny(action.Params["body"]))
		switch {
		case target != "" && body != "":
			return target + ": " + body
		case target != "":
			return target
		case body != "":
			return body
		default:
			return ""
		}
	case slackActionTypeCreateEvent:
		return strings.TrimSpace(stringFromAny(action.Params["title"]))
	case slackActionTypeJoinMeeting:
		return firstNonEmpty(stringFromAny(action.Params["title"]), stringFromAny(action.Params["meet_url"]), stringFromAny(action.Params["meetUrl"]))
	case slackActionTypeCreateChannel:
		channelName := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(stringFromAny(action.Params["channel_name"]), stringFromAny(action.Params["channelName"]))), "#")
		if channelName == "" {
			return ""
		}
		return "#" + channelName
	}
	return ""
}
