//go:build cueboardparity

package agentrunner

import (
	"slices"
	"testing"
)

func TestCueboardParitySlackAssistantToolSetMatchesCurrentCategories(t *testing.T) {
	t.Parallel()

	capabilities := CapabilitiesForSessionKind(SessionKindSlack)
	got := sortedToolNames(capabilities.AllowedTools)
	want := []string{
		"bash",
		"edit",
		"exa_contents",
		"exa_search",
		"followup_memory",
		"heartbeat_log",
		"manage_schedule",
		"memory_get",
		"memory_search",
		"memory_write",
		"person_memory",
		"read",
		"read_doc",
		"runtime_status",
		"send_message",
		"slack_api",
		"suggest_action",
		"usage_api",
		"write",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("assistant tool set\n got: %v\nwant: %v", got, want)
	}
	for _, excluded := range []string{"linear_api", "notion_api", "figma_api", "google_calendar_api", "image_generation", "audio_generation", "usage"} {
		if slices.Contains(got, excluded) {
			t.Fatalf("assistant tool set should not expose out-of-scope/credentialed tool %q: %v", excluded, got)
		}
	}
}

func TestCueboardParityPlannerIncludesFollowupMemoryButNotAssistantRuntimeTools(t *testing.T) {
	t.Parallel()

	capabilities := CapabilitiesForSessionKind(SessionKindTriage)
	got := sortedToolNames(capabilities.AllowedTools)
	for _, name := range []string{"slack_api", "followup_memory", "person_memory", "suggest_action", "usage_api", "memory_search", "memory_get", "exa_search", "exa_contents"} {
		if !slices.Contains(got, name) {
			t.Fatalf("planner tool set should include %q: %v", name, got)
		}
	}
	for _, name := range []string{"send_message", "manage_schedule", "runtime_status", "heartbeat_log", "image_generation", "audio_generation"} {
		if slices.Contains(got, name) {
			t.Fatalf("planner tool set should not expose %q: %v", name, got)
		}
	}
	if !slices.Contains(capabilities.BlockedTools, "send_message") {
		t.Fatalf("planner should explicitly block send_message: %v", capabilities.BlockedTools)
	}
}

func TestCueboardParityMeetingCopilotToolSetKeepsMeetingOnlySurface(t *testing.T) {
	t.Parallel()

	capabilities := CapabilitiesForSessionKind(SessionKindMeetingCopilot)
	got := sortedToolNames(capabilities.AllowedTools)
	want := []string{"notify_meeting_slack", "send_meeting_chat"}
	if !slices.Equal(got, want) {
		t.Fatalf("meeting copilot tool set\n got: %v\nwant: %v", got, want)
	}
}

func TestCueboardParitySummaryAndCalibrateExposeNoSlackMutationTools(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{SessionKindMeetingSummary, SessionKindMeetingCalib} {
		capabilities := CapabilitiesForSessionKind(kind)
		if capabilities.Role != SessionRoleCompletionOnly {
			t.Fatalf("%s role = %s, want %s", kind, capabilities.Role, SessionRoleCompletionOnly)
		}
		if len(capabilities.AllowedTools) != 0 {
			t.Fatalf("%s should expose no tools, got %v", kind, capabilities.AllowedTools)
		}
	}
}

func sortedToolNames(values []string) []string {
	out := append([]string(nil), values...)
	slices.Sort(out)
	return out
}
