package slackagent

import (
	"context"
	"strings"
	"testing"
)

func TestScheduleMetadataMatchesSlackThread(t *testing.T) {
	definition := ScheduleDefinition{
		"metadata": map[string]any{
			SlackScheduleMetadataChannelID: "C123",
			SlackScheduleMetadataThreadTS:  "123.456",
		},
	}

	if !ScheduleMetadataMatchesSlackThread(definition, "C123", "123.456") {
		t.Fatalf("ScheduleMetadataMatchesSlackThread() = false, want true")
	}
}

func TestScheduleBelongsToSlackThreadViaLegacyPrompt(t *testing.T) {
	definition := ScheduleDefinition{
		"prompt": legacySlackThreadContextLine("C123", "123.456") + "\nhello",
	}

	if !ScheduleBelongsToSlackThread(definition, "C123", "123.456") {
		t.Fatalf("ScheduleBelongsToSlackThread() = false, want true")
	}
}

func TestFilterSchedulesForCurrentSlackThread(t *testing.T) {
	definitions := []ScheduleDefinition{
		{
			"id": "sched_1",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C123",
				SlackScheduleMetadataThreadTS:  "123.456",
			},
		},
		{
			"id": "sched_2",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C999",
				SlackScheduleMetadataThreadTS:  "999.000",
			},
		},
	}

	filtered := FilterSchedulesForCurrentSlackThread(definitions, ScheduleContext{
		ChannelID: "C123",
		ThreadTS:  "123.456",
	})
	if len(filtered) != 1 || pickString(filtered[0], "id") != "sched_1" {
		t.Fatalf("FilterSchedulesForCurrentSlackThread() = %#v", filtered)
	}
}

func TestExecuteAssistantScheduleToolBlocksMutations(t *testing.T) {
	result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{
		Action: "create",
	}, ExecuteAssistantScheduleToolOptions{})

	if result.OK || result.Error != "assistant_mutation_blocked" {
		t.Fatalf("ExecuteAssistantScheduleTool() = %#v", result)
	}
}

func TestExecuteAssistantScheduleToolRequiresThreadContext(t *testing.T) {
	result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{
		Action: "list",
	}, ExecuteAssistantScheduleToolOptions{
		ScheduleManager: NewInMemoryScheduleManager(nil),
	})

	if result.OK || result.Error != "slack_thread_context_required" {
		t.Fatalf("ExecuteAssistantScheduleTool() = %#v", result)
	}
}

func TestExecuteAssistantScheduleToolListsThreadSchedules(t *testing.T) {
	manager := NewInMemoryScheduleManager([]ScheduleDefinition{
		{
			"id": "sched_1",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C123",
				SlackScheduleMetadataThreadTS:  "123.456",
			},
		},
		{
			"id": "sched_2",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C999",
				SlackScheduleMetadataThreadTS:  "999.000",
			},
		},
	})

	result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{
		Action:    "list",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	}, ExecuteAssistantScheduleToolOptions{
		ScheduleManager: manager,
	})

	if !result.OK || len(result.Schedules) != 1 {
		t.Fatalf("ExecuteAssistantScheduleTool() = %#v", result)
	}
	if !strings.Contains(result.Text, "sched_1") {
		t.Fatalf("Text = %q, want sched_1", result.Text)
	}
}
