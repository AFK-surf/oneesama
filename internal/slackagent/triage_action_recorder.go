package slackagent

import (
	"fmt"
	"strings"
	"sync"
)

type triageActionRecorder struct {
	mu        sync.Mutex
	toolCalls []SlackTriageToolCall
	actions   []SlackTriageAction
}

func (r *triageActionRecorder) mutationCount() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.actions)
}

func (r *triageActionRecorder) failureCount() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	failures := 0
	for _, call := range r.toolCalls {
		if !call.Success {
			failures++
		}
	}
	return failures
}

func (r *triageActionRecorder) record(tool string, args map[string]any, result slackAPIToolResult) {
	success := result.Success
	call := SlackTriageToolCall{
		Tool:    tool,
		Success: success,
	}
	action, channel, brief := triageActionFromToolCall(tool, args)
	call.Action = action
	call.Args = triageToolCallArgsSummary(tool, args)
	call.Result = strings.TrimSpace(result.GetTextOutput())
	call.Brief = truncateSlackContextText(firstNonEmpty(call.Result, brief), 80)
	if call.Brief == "" {
		call.Brief = action
	}

	r.mu.Lock()
	r.toolCalls = append(r.toolCalls, call)
	r.mu.Unlock()
	if !success {
		return
	}
	if outbound, ok := triageOutboundActionFromToolCall(tool, args, action, channel, brief); ok {
		r.mu.Lock()
		r.actions = append(r.actions, outbound)
		r.mu.Unlock()
	}
}

func triageActionFromToolCall(tool string, args map[string]any) (action string, channel string, brief string) {
	method := strings.TrimSpace(stringFromAny(args["method"]))
	if method == "" {
		method = strings.TrimSpace(stringFromAny(args["action"]))
	}
	if method == "" {
		method = tool
	}
	params, _ := mapFromAny(args["params"])
	switch strings.ToLower(method) {
	case "slack.postthreadreply", "post_thread_reply", "chat.postthreadreply":
		action = "post_thread_reply"
	case "slack.postmessage", "chat.postmessage", "post_message":
		action = "post_message"
	case "slack.addreaction", "reactions.add", "add_reaction":
		action = "add_reaction"
	case "slack.deletemessage", "chat.delete", "delete_message":
		action = "delete_message"
	case "slack.editmessage", "chat.update", "edit_message":
		action = "edit_message"
	case "suggest_action":
		action = strings.TrimSpace(stringFromAny(args["action_type"]))
	case "followup_memory":
		action = strings.TrimSpace(stringFromAny(args["action"]))
	default:
		action = firstNonEmpty(strings.TrimPrefix(strings.ToLower(method), "slack."), tool)
	}
	channel = firstNonEmpty(stringFromAny(params["channel"]), stringFromAny(params["channel_id"]), stringFromAny(params["channelId"]), stringFromAny(args["channel"]), "unknown")
	brief = triageActionBrief(action, args, params)
	return action, channel, brief
}

func triageOutboundActionFromToolCall(tool string, args map[string]any, action string, channel string, brief string) (SlackTriageAction, bool) {
	switch tool {
	case "slack_api":
		switch action {
		case "post_thread_reply", "add_reaction", "delete_message", "edit_message":
			return SlackTriageAction{Tool: action, Channel: channel, Brief: brief}, true
		default:
			return SlackTriageAction{}, false
		}
	case "suggest_action":
		actionType := strings.TrimSpace(stringFromAny(args["action_type"]))
		return SlackTriageAction{Tool: "suggest_action", Channel: firstNonEmpty(stringFromAny(args["channel"]), channel), Brief: actionType}, actionType != ""
	case "followup_memory":
		followupAction := strings.TrimSpace(stringFromAny(args["action"]))
		if followupAction == "" {
			return SlackTriageAction{}, false
		}
		brief := strings.TrimSpace(stringFromAny(args["title"]))
		if brief == "" && followupAction == "resolve" {
			if id := int64FromAny(args["followup_id"]); id > 0 {
				brief = fmt.Sprintf("resolve #%d", id)
			}
		}
		if brief == "" {
			brief = followupAction
		}
		return SlackTriageAction{
			Tool:    "followup_memory",
			Channel: firstNonEmpty(stringFromAny(args["channel_id"]), stringFromAny(args["channel"]), "heartbeat"),
			Brief:   truncateSlackContextText(brief, 60),
		}, true
	default:
		return SlackTriageAction{}, false
	}
}

func triageToolCallArgsSummary(tool string, args map[string]any) string {
	switch tool {
	case "slack_api":
		params, _ := mapFromAny(args["params"])
		var parts []string
		if channel := strings.TrimSpace(stringFromAny(params["channel"])); channel != "" {
			parts = append(parts, "channel="+channel)
		}
		if threadTS := strings.TrimSpace(stringFromAny(params["thread_ts"])); threadTS != "" {
			parts = append(parts, "thread_ts="+threadTS)
		} else if ts := strings.TrimSpace(stringFromAny(params["ts"])); ts != "" {
			parts = append(parts, "ts="+ts)
		}
		return strings.Join(parts, " ")
	case "run_command":
		return truncateSlackContextText(stringFromAny(args["command"]), 80)
	case "linear_api":
		return truncateSlackContextText(stringFromAny(args["body"]), 80)
	case "memory_write", "memory_get", "read_doc":
		return stringFromAny(args["path"])
	case "memory_search":
		return truncateSlackContextText(stringFromAny(args["query"]), 60)
	case "suggest_action":
		return stringFromAny(args["action_type"])
	case "followup_memory":
		if title := stringFromAny(args["title"]); title != "" {
			return truncateSlackContextText(title, 80)
		}
		if ref := stringFromAny(args["message_ref"]); ref != "" {
			return ref
		}
		if id := int64FromAny(args["followup_id"]); id > 0 {
			return fmt.Sprintf("#%d", id)
		}
	}
	return ""
}

func triageActionBrief(action string, args map[string]any, params map[string]any) string {
	switch action {
	case "post_thread_reply", "edit_message":
		return truncateSlackContextText(firstLine(stringFromAny(params["text"])), 60)
	case "add_reaction":
		return ":" + firstNonEmpty(stringFromAny(params["emoji"]), stringFromAny(params["name"]), stringFromAny(params["reaction"]), "reaction") + ":"
	case "delete_message":
		return "deleted msg"
	default:
		return firstNonEmpty(truncateSlackContextText(firstLine(stringFromAny(params["text"])), 60), truncateSlackContextText(stringFromAny(args["title"]), 60), action)
	}
}

func firstLine(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.IndexByte(value, '\n'); idx >= 0 {
		value = value[:idx]
	}
	return strings.TrimSpace(value)
}
