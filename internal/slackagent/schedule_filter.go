package slackagent

import (
	"fmt"
	"strings"
)

const (
	SlackScheduleMetadataChannelID = "slack_channel_id"
	SlackScheduleMetadataThreadTS  = "slack_thread_ts"
	AssistantScheduleToolName      = "manage_schedule"
)

var assistantScheduleActions = []string{"list"}

type ScheduleDefinition map[string]any

type ScheduleContext struct {
	ChannelID string
	ThreadTS  string
}

func AssistantScheduleToolDescription() string {
	return `Inspect durable scheduled tasks created from the current Slack thread. Assistant sessions only support action="list". Creating or changing schedules is not available here.`
}

func AssistantScheduleToolParameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type":        "string",
				"enum":        assistantScheduleActions,
				"description": `The action to perform. Assistant sessions only support "list" for schedules created from the current Slack thread.`,
			},
		},
		"required":             []string{"action"},
		"additionalProperties": false,
	}
}

func ScheduleMetadataMatchesSlackThread(definition ScheduleDefinition, channelID string, threadTS string) bool {
	channel := strings.TrimSpace(channelID)
	thread := strings.TrimSpace(threadTS)
	if channel == "" || thread == "" {
		return false
	}
	metadata := definitionMetadata(definition)
	return pickString(metadata, SlackScheduleMetadataChannelID) == channel &&
		pickString(metadata, SlackScheduleMetadataThreadTS) == thread
}

func ScheduleBelongsToSlackThread(definition ScheduleDefinition, channelID string, threadTS string) bool {
	channel := strings.TrimSpace(channelID)
	thread := strings.TrimSpace(threadTS)
	if channel == "" || thread == "" {
		return false
	}
	if ScheduleMetadataMatchesSlackThread(definition, channel, thread) {
		return true
	}
	return strings.Contains(pickString(definition, "prompt", "Prompt"), legacySlackThreadContextLine(channel, thread))
}

func FilterSchedulesForCurrentSlackThread(definitions []ScheduleDefinition, context ScheduleContext) []ScheduleDefinition {
	channelID := strings.TrimSpace(context.ChannelID)
	threadTS := strings.TrimSpace(context.ThreadTS)
	if channelID == "" || threadTS == "" || len(definitions) == 0 {
		return nil
	}

	filtered := make([]ScheduleDefinition, 0, len(definitions))
	for _, definition := range definitions {
		if ScheduleBelongsToSlackThread(definition, channelID, threadTS) {
			filtered = append(filtered, NormalizeScheduleDefinition(definition))
		}
	}
	return filtered
}

func NormalizeScheduleDefinition(definition ScheduleDefinition) ScheduleDefinition {
	normalized := make(ScheduleDefinition)
	setIfPresent(normalized, "id", pickString(definition, "id", "ID"))
	setIfPresent(normalized, "name", pickString(definition, "name", "Name"))
	setIfPresent(normalized, "description", pickString(definition, "description", "Description"))
	setIfPresent(normalized, "prompt", pickString(definition, "prompt", "Prompt"))
	if metadata := definitionMetadata(definition); len(metadata) > 0 {
		normalized["metadata"] = metadata
	}
	setIfPresent(normalized, "cron_expr", pickString(definition, "cron_expr", "cronExpr", "CronExpr"))
	if countLimit, ok := pickInt(definition, "count_limit", "countLimit", "CountLimit"); ok {
		setIfPresent(normalized, "count_limit", countLimit)
	}
	setIfPresent(normalized, "date_time_limit", pickString(definition, "date_time_limit", "dateTimeLimit", "DateTimeLimit"))
	setIfPresent(normalized, "timezone", pickString(definition, "timezone", "Timezone"))
	if paused, ok := pickBool(definition, "is_paused", "isPaused", "IsPaused"); ok {
		normalized["is_paused"] = paused
	}
	setIfPresent(normalized, "deleted_at", pickString(definition, "deleted_at", "deletedAt", "DeletedAt"))
	if runHistory, ok := pickValue(definition, "run_history", "runHistory", "RunHistory"); ok {
		normalized["run_history"] = runHistory
	}
	setIfPresent(normalized, "created_at", pickString(definition, "created_at", "createdAt", "CreatedAt"))
	setIfPresent(normalized, "updated_at", pickString(definition, "updated_at", "updatedAt", "UpdatedAt"))
	return normalized
}

func legacySlackThreadContextLine(channelID string, threadTS string) string {
	return fmt.Sprintf("[Context] This schedule was created in channel=%s thread_ts=%s.", channelID, threadTS)
}

func definitionMetadata(definition ScheduleDefinition) map[string]any {
	if metadata, ok := definition["metadata"].(map[string]any); ok {
		return metadata
	}
	if metadata, ok := definition["Metadata"].(map[string]any); ok {
		return metadata
	}
	return map[string]any{}
}

func pickString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			if trimmed := strings.TrimSpace(fmt.Sprintf("%v", value)); trimmed != "" && trimmed != "<nil>" {
				return trimmed
			}
		}
	}
	return ""
}

func pickInt(values map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		value, ok := values[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case int:
			return typed, true
		case int32:
			return int(typed), true
		case int64:
			return int(typed), true
		case float64:
			return int(typed), true
		}
	}
	return 0, false
}

func pickBool(values map[string]any, keys ...string) (bool, bool) {
	for _, key := range keys {
		value, ok := values[key]
		if !ok || value == nil {
			continue
		}
		if typed, ok := value.(bool); ok {
			return typed, true
		}
	}
	return false, false
}

func pickValue(values map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		value, ok := values[key]
		if ok && value != nil {
			return value, true
		}
	}
	return nil, false
}

func setIfPresent(target ScheduleDefinition, key string, value any, ok ...bool) {
	if len(ok) > 0 && !ok[0] {
		return
	}
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return
		}
	case nil:
		return
	}
	target[key] = value
}
