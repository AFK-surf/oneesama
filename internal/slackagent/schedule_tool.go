package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type ScheduleManager interface {
	List(context.Context) ([]ScheduleDefinition, error)
}

type ExecuteAssistantScheduleToolArgs struct {
	Action    string
	ChannelID string
	ThreadTS  string
}

type ExecuteAssistantScheduleToolOptions struct {
	ChannelID       string
	ThreadTS        string
	ScheduleManager ScheduleManager
	SessionMetadata map[string]any
	SlackContext    map[string]any
}

type ScheduleToolResult struct {
	OK        bool                 `json:"ok"`
	Success   bool                 `json:"success"`
	Tool      string               `json:"tool"`
	Error     string               `json:"error,omitempty"`
	Text      string               `json:"text"`
	Schedules []ScheduleDefinition `json:"schedules,omitempty"`
	Metadata  map[string]any       `json:"metadata,omitempty"`
}

type InMemoryScheduleManager struct {
	definitions []ScheduleDefinition
}

func NewInMemoryScheduleManager(definitions []ScheduleDefinition) *InMemoryScheduleManager {
	cloned := make([]ScheduleDefinition, 0, len(definitions))
	for _, definition := range definitions {
		cloned = append(cloned, cloneScheduleDefinition(definition))
	}
	return &InMemoryScheduleManager{definitions: cloned}
}

func (m *InMemoryScheduleManager) List(_ context.Context) ([]ScheduleDefinition, error) {
	return append([]ScheduleDefinition(nil), m.definitions...), nil
}

func ExecuteAssistantScheduleTool(ctx context.Context, args ExecuteAssistantScheduleToolArgs, options ExecuteAssistantScheduleToolOptions) ScheduleToolResult {
	action := strings.TrimSpace(args.Action)
	if action == "" {
		action = "list"
	}
	if action != "list" {
		return ScheduleToolResult{
			OK:      false,
			Success: false,
			Tool:    AssistantScheduleToolName,
			Error:   "assistant_mutation_blocked",
			Text:    fmt.Sprintf("Action %q is not available in assistant sessions. Allowed actions: %q.", action, assistantScheduleActions[0]),
			Metadata: map[string]any{
				"allowed_actions": assistantScheduleActions,
			},
		}
	}

	channelID, threadTS := resolveScheduleThreadContext(args, options)
	if channelID == "" || threadTS == "" {
		return ScheduleToolResult{
			OK:      false,
			Success: false,
			Tool:    AssistantScheduleToolName,
			Error:   "slack_thread_context_required",
			Text:    "Slack channel_id and thread_ts are required to list assistant schedules for the current thread.",
			Metadata: map[string]any{
				"schedule_ids": []string{},
			},
		}
	}

	if options.ScheduleManager == nil {
		return ScheduleToolResult{
			OK:        true,
			Success:   true,
			Tool:      AssistantScheduleToolName,
			Text:      "[]",
			Schedules: nil,
			Metadata: map[string]any{
				"schedule_ids": []string{},
			},
		}
	}

	definitions, err := options.ScheduleManager.List(ctx)
	if err != nil {
		return ScheduleToolResult{
			OK:      false,
			Success: false,
			Tool:    AssistantScheduleToolName,
			Error:   "schedule_list_failed",
			Text:    fmt.Sprintf("Failed to list assistant schedules: %v", err),
		}
	}

	schedules := FilterSchedulesForCurrentSlackThread(definitions, ScheduleContext{
		ChannelID: channelID,
		ThreadTS:  threadTS,
	})
	scheduleIDs := make([]string, 0, len(schedules))
	for _, schedule := range schedules {
		if id := pickString(schedule, "id"); id != "" {
			scheduleIDs = append(scheduleIDs, id)
		}
	}

	textBytes, err := json.MarshalIndent(schedules, "", "  ")
	if err != nil {
		return ScheduleToolResult{
			OK:      false,
			Success: false,
			Tool:    AssistantScheduleToolName,
			Error:   "schedule_encode_failed",
			Text:    fmt.Sprintf("Failed to encode schedules: %v", err),
		}
	}

	return ScheduleToolResult{
		OK:        true,
		Success:   true,
		Tool:      AssistantScheduleToolName,
		Text:      string(textBytes),
		Schedules: schedules,
		Metadata: map[string]any{
			"schedule_ids": scheduleIDs,
		},
	}
}

func resolveScheduleThreadContext(args ExecuteAssistantScheduleToolArgs, options ExecuteAssistantScheduleToolOptions) (string, string) {
	channelID := firstNonEmpty(
		args.ChannelID,
		options.ChannelID,
		pickString(options.SessionMetadata, "channel_id", "channelId"),
		pickString(options.SlackContext, "channel_id", "channelId"),
	)
	threadTS := firstNonEmpty(
		args.ThreadTS,
		options.ThreadTS,
		pickString(options.SessionMetadata, "thread_ts", "threadTs"),
		pickString(options.SlackContext, "thread_ts", "threadTs"),
	)
	return channelID, threadTS
}

func cloneScheduleDefinition(definition ScheduleDefinition) ScheduleDefinition {
	clone := make(ScheduleDefinition, len(definition))
	for key, value := range definition {
		clone[key] = value
	}
	return clone
}
