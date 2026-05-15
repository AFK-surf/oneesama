package slackagent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func isSlackTriageJob(job agentrunner.Job) bool {
	return strings.EqualFold(stringFromContext(job.Context, "source"), "slack-triage")
}

func normalizeSlackInboundMessages(messages []SlackInboundMessage) []SlackInboundMessage {
	out := make([]SlackInboundMessage, 0, len(messages))
	for _, message := range messages {
		out = append(out, normalizeSlackInboundMessage(message))
	}
	return out
}

func filterTriageContextsForChannel(contexts []SlackTriageContext, channelID string) []SlackTriageContext {
	filtered := make([]SlackTriageContext, 0, len(contexts))
	for _, context := range contexts {
		if channelID == "" || len(context.Channels) == 0 || stringSliceContains(context.Channels, channelID) {
			filtered = append(filtered, context)
		}
	}
	return filtered
}

func firstMessageTeamID(messages []SlackInboundMessage) string {
	if len(messages) == 0 {
		return ""
	}
	return messages[0].TeamID
}

func lastMessageThreadTS(messages []SlackInboundMessage) string {
	if len(messages) == 0 {
		return ""
	}
	last := messages[len(messages)-1]
	return firstNonEmpty(last.ThreadTS, last.TS)
}

func stringFromContext(context map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringFromAny(context[key]); value != "" {
			return value
		}
	}
	return ""
}

func int64FromContext(context map[string]any, keys ...string) int64 {
	for _, key := range keys {
		if value := int64FromAny(context[key]); value != 0 {
			return value
		}
	}
	return 0
}

func int64FromAny(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		var out int64
		_, _ = fmt.Sscan(typed, &out)
		return out
	default:
		return 0
	}
}

func messagesFromContext(value any) []SlackInboundMessage {
	switch typed := value.(type) {
	case []SlackInboundMessage:
		return normalizeSlackInboundMessages(typed)
	case []any:
		return messagesFromAnySlice(typed)
	default:
		return nil
	}
}

func messagesFromAnySlice(values []any) []SlackInboundMessage {
	out := make([]SlackInboundMessage, 0, len(values))
	for _, item := range values {
		if mapped, ok := mapFromAny(item); ok {
			out = append(out, SlackInboundMessage{
				TeamID:     firstNonEmpty(stringFromAny(mapped["teamId"]), stringFromAny(mapped["team_id"])),
				ChannelID:  firstNonEmpty(stringFromAny(mapped["channelId"]), stringFromAny(mapped["channel_id"])),
				UserID:     firstNonEmpty(stringFromAny(mapped["userId"]), stringFromAny(mapped["user_id"]), stringFromAny(mapped["user"])),
				Text:       stringFromAny(mapped["text"]),
				TS:         firstNonEmpty(stringFromAny(mapped["ts"]), stringFromAny(mapped["eventTs"]), stringFromAny(mapped["event_ts"])),
				ThreadTS:   firstNonEmpty(stringFromAny(mapped["threadTs"]), stringFromAny(mapped["thread_ts"])),
				ReplyCount: intFromAny(mapped["reply_count"]),
			})
		}
	}
	return normalizeSlackInboundMessages(out)
}

func marshalTriageArgs(provider string, jobID string, parseOK bool) string {
	payload, _ := json.Marshal(map[string]any{"provider": provider, "jobId": jobID, "parseOk": parseOK})
	return string(payload)
}

func mapBool(value bool, whenTrue string, whenFalse string) string {
	if value {
		return whenTrue
	}
	return whenFalse
}

func valueOrZero(run *SlackTriageContext) int64 {
	if run == nil {
		return 0
	}
	return run.ID
}

func stringSliceContains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
