package agentrunner

import (
	"context"
	"fmt"
	"strings"
)

type dryRunProvider struct{}

func (p dryRunProvider) Provider() string {
	return "dry-run"
}

func (p dryRunProvider) DryRun() bool {
	return true
}

func (p dryRunProvider) Run(_ context.Context, _ StartInput) (RunResult, error) {
	return RunResult{
		Status: StatusCompleted,
		Result: dryRunResult("dry-run"),
	}, nil
}

func dryRunResult(provider string) string {
	name := providerDisplayName(provider)
	if name == "" {
		name = "agent runner"
	}
	return fmt.Sprintf("Dry-run %s accepted the task.", name)
}

func providerDisplayName(provider string) string {
	switch strings.TrimSpace(provider) {
	case "codex":
		return "Codex runner"
	case "claude":
		return "Claude Code runner"
	case "ollama":
		return "Ollama runner"
	case "dry-run":
		return "agent runner"
	default:
		return strings.TrimSpace(provider)
	}
}
