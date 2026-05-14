//go:build cueboardparity

package slackagent

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/slackstartup"
)

func TestCueboardParitySlackAssistantCapabilitiesKeepFrameworkWorkspaceTools(t *testing.T) {
	t.Parallel()

	capabilities := agentrunner.CapabilitiesForSessionKind(agentrunner.SessionKindSlack)
	for _, name := range []string{"read", "write", "edit", "bash", "send_message", "manage_schedule"} {
		if !containsString(capabilities.AllowedTools, name) {
			t.Fatalf("expected Slack assistant capabilities to allow %q: %#v", name, capabilities.AllowedTools)
		}
	}
	if !containsString(capabilities.BlockedTools, "ask_question") {
		t.Fatalf("expected ask_question to be blocked: %#v", capabilities.BlockedTools)
	}
	if containsString(capabilities.BlockedTools, "send_message") {
		t.Fatalf("send_message should remain available for Slack assistant sessions: %#v", capabilities.BlockedTools)
	}
}

func TestCueboardParitySlackTriageCapabilitiesRemovePlannerMessaging(t *testing.T) {
	t.Parallel()

	capabilities := agentrunner.CapabilitiesForSessionKind(agentrunner.SessionKindTriage)
	for _, name := range []string{"read", "write", "edit", "bash", "slack_api"} {
		if !containsString(capabilities.AllowedTools, name) {
			t.Fatalf("expected triage capabilities to allow %q: %#v", name, capabilities.AllowedTools)
		}
	}
	for _, name := range []string{"send_message", "ask_question"} {
		if !containsString(capabilities.BlockedTools, name) {
			t.Fatalf("expected triage capabilities to block %q: %#v", name, capabilities.BlockedTools)
		}
	}
}

func TestCueboardParitySlackSafeBashBlocksDangerousCleanup(t *testing.T) {
	t.Parallel()

	err := validateSlackBashCommand("git reset --hard")
	if err == nil {
		t.Fatal("expected dangerous git reset to be blocked")
	}
	if !strings.Contains(err.Error(), "blocked dangerous bash command") {
		t.Fatalf("unexpected block message: %v", err)
	}
}

func TestCueboardParitySlackSafeBashAllowsWorktreeWorkflow(t *testing.T) {
	t.Parallel()

	if err := validateSlackBashCommand("git worktree add _tmp_worktrees/CUE-123 -b fix/CUE-123"); err != nil {
		t.Fatalf("safe worktree command should pass: %v", err)
	}
}

func TestCueboardParityAssistantScheduleToolIsRegisteredButMutationsAreBlocked(t *testing.T) {
	t.Parallel()

	capabilities := agentrunner.CapabilitiesForSessionKind(agentrunner.SessionKindSlack)
	if !containsString(capabilities.AllowedTools, AssistantScheduleToolName) {
		t.Fatalf("expected %s to be exposed to Slack assistant sessions", AssistantScheduleToolName)
	}
	result := ExecuteAssistantScheduleTool(context.Background(), ExecuteAssistantScheduleToolArgs{Action: "create"}, ExecuteAssistantScheduleToolOptions{})
	if result.OK || result.Error != "assistant_mutation_blocked" {
		t.Fatalf("current Onee Sama schedule tool should block assistant mutations, got %#v", result)
	}
}

func TestCueboardParityScrubSlackAgentProcessSecrets(t *testing.T) {
	t.Setenv("SLACK_BOT_TOKEN", "xoxb-secret")
	t.Setenv("SLACK_APP_TOKEN", "xapp-secret")
	t.Setenv("API_KEY", "backend-secret")
	t.Setenv("BACKEND_URL", "http://localhost:8080")

	slackstartup.ScrubProcessSecrets()

	for _, name := range []string{"SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "API_KEY"} {
		if got := os.Getenv(name); got != "" {
			t.Fatalf("%s should be scrubbed, got %q", name, got)
		}
	}
	if got := os.Getenv("BACKEND_URL"); got != "http://localhost:8080" {
		t.Fatalf("BACKEND_URL should be preserved, got %q", got)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
