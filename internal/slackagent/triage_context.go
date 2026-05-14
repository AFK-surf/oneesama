package slackagent

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const triageContextCharBudget = 1600

func formatTriageContexts(contexts []SlackTriageContext) string {
	if len(contexts) == 0 {
		return ""
	}
	contexts = filterPromptRelevantTriageContexts(contexts)
	if len(contexts) == 0 {
		return ""
	}

	var builder strings.Builder
	builder.WriteString("=== Previous Triage ===\n")
	for _, context := range contexts {
		builder.WriteString(formatTriageContextLine(context))
		builder.WriteString("\n")
		if builder.Len() > triageContextCharBudget {
			break
		}
	}
	builder.WriteString("===")

	result := builder.String()
	if len(result) > triageContextCharBudget {
		result = result[:triageContextCharBudget-3] + "..."
	}
	return result
}

func filterPromptRelevantTriageContexts(contexts []SlackTriageContext) []SlackTriageContext {
	out := make([]SlackTriageContext, 0, len(contexts))
	for _, context := range contexts {
		if strings.EqualFold(context.Status, "ok") && len(context.Actions) == 0 {
			continue
		}
		out = append(out, context)
	}
	return out
}

func formatTriageContextLine(context SlackTriageContext) string {
	return fmt.Sprintf("[%s] %s", triageContextClock(context.Timestamp), strings.Join(formatTriageChannelSummaries(context), " | "))
}

func formatTriageChannelSummaries(context SlackTriageContext) []string {
	channelActions, channels := triageChannelActions(context)
	parts := make([]string, 0, len(channels))
	for _, channel := range channels {
		parts = append(parts, formatTriageChannelSummary(channel, channelActions[channel], context.Status))
	}
	return parts
}

func triageChannelActions(context SlackTriageContext) (map[string][]string, []string) {
	channelActions := make(map[string][]string, len(context.Channels))
	for _, channel := range context.Channels {
		channelActions[channel] = nil
	}
	for _, action := range context.Actions {
		channel := triageActionChannel(action)
		channelActions[channel] = append(channelActions[channel], formatTriageActionSummary(action))
	}
	channels := make([]string, 0, len(channelActions))
	for channel := range channelActions {
		channels = append(channels, channel)
	}
	sort.Strings(channels)
	return channelActions, channels
}

func formatTriageActionSummary(action SlackTriageAction) string {
	return fmt.Sprintf("%s %q", action.Tool, action.Brief)
}

func triageActionChannel(action SlackTriageAction) string {
	if strings.TrimSpace(action.Channel) == "" {
		return "unknown"
	}
	return strings.TrimSpace(action.Channel)
}

func formatTriageChannelSummary(channel string, actions []string, status string) string {
	if len(actions) == 0 {
		return fmt.Sprintf("#%s: %s", channel, triagePromptFallbackLabel(status))
	}
	return fmt.Sprintf("#%s: %s", channel, strings.Join(actions, ", "))
}

func triagePromptFallbackLabel(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ok", "success":
		return "Scanned, no action taken."
	case "timeout":
		return "TIMEOUT"
	case "failed", "error":
		return "FAILED"
	case "recorded":
		return "recorded"
	default:
		return "pending"
	}
}

func compactTriageSummary(context SlackTriageContext) string {
	if len(context.Actions) > 0 {
		summaries := make([]string, 0, len(context.Actions))
		for _, action := range context.Actions {
			summaries = append(summaries, compactTriageActionSummary(action))
		}
		return truncateSlackContextText(strings.Join(summaries, "; "), 2000)
	}
	if strings.TrimSpace(context.Summary) != "" {
		return truncateSlackContextText(strings.TrimSpace(context.Summary), 2000)
	}
	return triagePromptFallbackLabel(context.Status)
}

func compactTriageActionSummary(action SlackTriageAction) string {
	channel := triageActionChannel(action)
	brief := strings.TrimSpace(action.Brief)
	if brief == "" {
		brief = strings.TrimSpace(action.Tool)
	}
	return fmt.Sprintf("#%s %s", channel, brief)
}

func triageContextClock(value string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC().Format("15:04")
	}
	if len(value) >= 16 {
		return value[11:16]
	}
	return "00:00"
}
