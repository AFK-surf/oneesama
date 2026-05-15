package agentrunner

import "testing"

func TestCapabilitiesForSessionKindMirrorsCueboardSlackAssistant(t *testing.T) {
	capabilities := CapabilitiesForSessionKind(SessionKindSlack)
	assertEqual(t, capabilities.Role, SessionRoleAssistant)
	assertContains(t, capabilities.AllowedTools, "manage_schedule")
	assertContains(t, capabilities.AllowedTools, "runtime_status")
	assertContains(t, capabilities.AllowedTools, "usage_api")
	assertContains(t, capabilities.AllowedTools, "memory_write")
	assertContains(t, capabilities.AllowedTools, "memory_search")
	assertContains(t, capabilities.AllowedTools, "memory_get")
	assertContains(t, capabilities.AllowedTools, "exa_search")
	assertContains(t, capabilities.AllowedTools, "exa_contents")
	assertContains(t, capabilities.BlockedTools, "ask_question")
	assertNotContains(t, capabilities.BlockedTools, "send_message")
}

func TestCapabilitiesForSessionKindMirrorsCueboardTriagePlanner(t *testing.T) {
	capabilities := CapabilitiesForSessionKind(SessionKindTriage)
	assertEqual(t, capabilities.Role, SessionRolePlanner)
	assertContains(t, capabilities.AllowedTools, "slack_api")
	assertContains(t, capabilities.AllowedTools, "usage_api")
	assertContains(t, capabilities.AllowedTools, "memory_search")
	assertContains(t, capabilities.AllowedTools, "memory_get")
	assertContains(t, capabilities.AllowedTools, "exa_search")
	assertContains(t, capabilities.AllowedTools, "exa_contents")
	assertContains(t, capabilities.BlockedTools, "send_message")
	assertNotContains(t, capabilities.AllowedTools, "manage_schedule")
}

func TestCapabilitiesForSessionKindMirrorsCueboardMeetingCopilot(t *testing.T) {
	capabilities := CapabilitiesForSessionKind(SessionKindMeetingCopilot)
	assertEqual(t, capabilities.Role, SessionRoleMeetingCopilot)
	assertContains(t, capabilities.AllowedTools, "notify_meeting_slack")
	assertContains(t, capabilities.AllowedTools, "send_meeting_chat")
}

func TestCapabilitiesForSessionKindMirrorsCueboardCompactAndCompletionOnly(t *testing.T) {
	compact := CapabilitiesForSessionKind(SessionKindCompact)
	assertEqual(t, compact.Role, SessionRoleCompact)
	assertContains(t, compact.AllowedTools, "memory_search")
	assertNotContains(t, compact.AllowedTools, "slack_api")

	summary := CapabilitiesForSessionKind(SessionKindMeetingSummary)
	assertEqual(t, summary.Role, SessionRoleCompletionOnly)
	if len(summary.AllowedTools) != 0 {
		t.Fatalf("meeting summary should expose no tools, got %#v", summary.AllowedTools)
	}
}

func TestWithSessionCapabilitiesAddsRunnerContext(t *testing.T) {
	input := WithSessionCapabilities(StartInput{Task: "demo", Context: map[string]any{"existing": true}}, "triage")
	assertEqual(t, input.Context["session_kind"], SessionKindTriage)
	assertEqual(t, input.Context["session_role"], SessionRolePlanner)
	if input.Context["existing"] != true {
		t.Fatalf("existing context was not preserved")
	}
}

func assertContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			return
		}
	}
	t.Fatalf("expected %#v to contain %q", values, want)
}

func assertNotContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			t.Fatalf("expected %#v not to contain %q", values, want)
		}
	}
}

func assertEqual[T comparable](t *testing.T, got T, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}
