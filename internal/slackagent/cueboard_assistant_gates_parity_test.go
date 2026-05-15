//go:build cueboardparity

package slackagent

import (
	"context"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func TestCueboardParityAssistantScheduleToolListScopesToCurrentThread(t *testing.T) {
	t.Parallel()

	manager := NewInMemoryScheduleManager([]ScheduleDefinition{
		{
			"id":   "keep-metadata",
			"name": "Current thread via metadata",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C123",
				SlackScheduleMetadataThreadTS:  "1700000000.123456",
			},
			"prompt": "Summarize the thread.",
		},
		{
			"id":     "keep-legacy",
			"name":   "Current thread via legacy prompt",
			"prompt": "Summarize the thread.\n\n" + legacySlackThreadContextLine("C123", "1700000000.123456") + " When posting results, use slack_api.",
		},
		{
			"id":   "drop-other-thread",
			"name": "Other thread",
			"metadata": map[string]any{
				SlackScheduleMetadataChannelID: "C123",
				SlackScheduleMetadataThreadTS:  "1700000001.123456",
			},
		},
		{"id": "drop-no-context", "name": "No context"},
	})

	result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{Action: "list"}, ExecuteAssistantScheduleToolOptions{
		ChannelID:       "C123",
		ThreadTS:        "1700000000.123456",
		ScheduleManager: manager,
	})
	if !result.Success {
		t.Fatalf("list should succeed, got %#v", result)
	}
	if len(result.Schedules) != 2 {
		t.Fatalf("list schedules = %#v, want two current-thread schedules", result.Schedules)
	}
	if pickString(result.Schedules[0], "id") != "keep-metadata" || pickString(result.Schedules[1], "id") != "keep-legacy" {
		t.Fatalf("list schedules = %#v, want current-thread metadata + legacy prompt schedules", result.Schedules)
	}
	ids, ok := result.Metadata["schedule_ids"].([]string)
	if !ok || len(ids) != 2 || ids[0] != "keep-metadata" || ids[1] != "keep-legacy" {
		t.Fatalf("schedule_ids metadata = %#v", result.Metadata["schedule_ids"])
	}
}

func TestCueboardParityAssistantScheduleToolBlocksMutations(t *testing.T) {
	t.Parallel()

	for _, action := range []string{"create", "get", "update", "pause", "resume", "delete"} {
		result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{
			Action:    action,
			ChannelID: "C123",
			ThreadTS:  "1700000000.123456",
		}, ExecuteAssistantScheduleToolOptions{
			ScheduleManager: NewInMemoryScheduleManager(nil),
		})
		if result.Success || result.Error != "assistant_mutation_blocked" {
			t.Fatalf("%s should be blocked by current Onee Sama assistant schedule boundary, got %#v", action, result)
		}
		if result.Text != `manage_schedule action "`+action+`" is not available in assistant sessions. Allowed actions here: "list".` {
			t.Fatalf("%s block text = %q, want allowed list hint", action, result.Text)
		}
	}
}

func TestCueboardParityAssistantMutationBlockedMessages(t *testing.T) {
	t.Parallel()

	if got := assistantMutationBlockedMessage("", ""); got != "this tool is not available in assistant sessions." {
		t.Fatalf("empty tool/action = %q", got)
	}
	if got := assistantMutationBlockedMessage("slack_api", "post_message", "post_thread_reply", "add_reaction"); got != `slack_api action "post_message" is not available in assistant sessions. Allowed actions here: "post_thread_reply" and "add_reaction".` {
		t.Fatalf("two actions = %q", got)
	}
	if got := formatAssistantAllowedActions([]string{"list", "get", "watch"}); got != `"list", "get", and "watch"` {
		t.Fatalf("formatAssistantAllowedActions = %q", got)
	}
	params := assistantActionParameters("Allowed schedule action.", []string{"list"})
	properties, _ := params["properties"].(map[string]any)
	action, _ := properties["action"].(map[string]any)
	enum, _ := action["enum"].([]string)
	if params["type"] != "object" || action["description"] != "Allowed schedule action." || len(enum) != 1 || enum[0] != "list" {
		t.Fatalf("assistantActionParameters = %#v", params)
	}
}

func TestCueboardParityAssistantScheduleToolMetadataIsReadOnly(t *testing.T) {
	t.Parallel()

	description := AssistantScheduleToolDescription()
	for _, want := range []string{"Inspect durable scheduled tasks", "current Slack thread"} {
		if !strings.Contains(description, want) {
			t.Fatalf("description missing %q: %q", want, description)
		}
	}
	if strings.Contains(description, "Create and manage") {
		t.Fatalf("description should not imply mutation support: %q", description)
	}
	properties, _ := AssistantScheduleToolParameters()["properties"].(map[string]any)
	action, _ := properties["action"].(map[string]any)
	enum, _ := action["enum"].([]string)
	if len(enum) != 1 || enum[0] != "list" {
		t.Fatalf("assistant schedule action enum = %#v, want list only", enum)
	}
}

func TestCueboardParityAssistantCapabilitiesExcludeCredentialedThirdPartyTools(t *testing.T) {
	t.Parallel()

	capabilities := agentrunner.CapabilitiesForSessionKind(agentrunner.SessionKindSlack)
	for _, name := range []string{"notion_api", "linear_api", "figma_api", "google_calendar_api"} {
		if containsString(capabilities.AllowedTools, name) {
			t.Fatalf("assistant capability should not expose credentialed third-party tool %q: %#v", name, capabilities.AllowedTools)
		}
	}
	if !containsString(capabilities.AllowedTools, AssistantScheduleToolName) {
		t.Fatalf("assistant capability should retain read-only schedule tool: %#v", capabilities.AllowedTools)
	}
	for _, name := range []string{"usage_api", "exa_search", "exa_contents", "memory_write", "memory_search", "memory_get"} {
		if !containsString(capabilities.AllowedTools, name) {
			t.Fatalf("assistant capability should expose non-credentialed cueboard tool %q: %#v", name, capabilities.AllowedTools)
		}
	}
}
