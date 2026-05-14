package slackagent

import (
	"strings"
)

type triageActionRecorder struct {
	toolCalls []SlackTriageToolCall
	actions   []SlackTriageAction
}

func (r *triageActionRecorder) record(tool string, args map[string]any, result slackAPIToolResult) {
	action, channel, brief := triageActionFromToolCall(tool, args)
	if brief == "" {
		brief = firstNonEmpty(result.GetTextOutput(), action)
	}
	call := SlackTriageToolCall{
		Tool:    tool,
		Action:  action,
		Args:    marshalTriageArgs(tool, "", result.Success),
		Success: result.Success,
		Brief:   brief,
		Result:  result.GetTextOutput(),
	}
	r.toolCalls = append(r.toolCalls, call)
	if action != "" {
		r.actions = append(r.actions, SlackTriageAction{Tool: action, Channel: channel, Brief: brief})
	}
}

func triageActionFromToolCall(tool string, args map[string]any) (action string, channel string, brief string) {
	method := strings.TrimSpace(stringFromAny(args["method"]))
	params, _ := mapFromAny(args["params"])
	channel = firstNonEmpty(stringFromAny(params["channel"]), stringFromAny(params["channel_id"]), stringFromAny(params["channelId"]), "unknown")
	switch strings.ToLower(method) {
	case "slack.postthreadreply", "post_thread_reply":
		action = "post_thread_reply"
		brief = firstNonEmpty(firstLine(stringFromAny(params["text"])), "posted a thread reply")
	case "slack.postmessage", "chat.postmessage", "post_message":
		action = "post_message"
		brief = firstNonEmpty(firstLine(stringFromAny(params["text"])), "posted a message")
	case "slack.addreaction", "reactions.add", "add_reaction":
		action = "add_reaction"
		brief = "added reaction " + firstNonEmpty(stringFromAny(params["name"]), stringFromAny(params["reaction"]), "reaction")
	default:
		action = firstNonEmpty(strings.TrimPrefix(strings.ToLower(method), "slack."), tool)
		brief = firstNonEmpty(firstLine(stringFromAny(params["text"])), action)
	}
	return action, channel, brief
}

func firstLine(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.IndexByte(value, '\n'); idx >= 0 {
		value = value[:idx]
	}
	return strings.TrimSpace(value)
}
