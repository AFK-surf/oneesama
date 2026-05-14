package agentrunner

import (
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newClaudeProvider(cfg appconfig.AgentRunnerConfig) runnerProvider {
	return commandProvider{
		provider:      "claude",
		bin:           cfg.Claude.Bin,
		dryRun:        cfg.DryRun,
		argsBuilder:   func(input StartInput) []string { return buildClaudeArgs(cfg.Claude, input) },
		promptBuilder: buildPrompt,
	}
}

func buildClaudeArgs(cfg appconfig.ClaudeRunnerConfig, input StartInput) []string {
	permissionMode := strings.TrimSpace(cfg.ReadPermissionMode)
	if input.AllowCodeChanges {
		permissionMode = strings.TrimSpace(cfg.WritePermissionMode)
	}

	args := []string{
		"-p",
		"--output-format", "text",
		"--permission-mode", permissionMode,
		"--no-session-persistence",
	}
	if model := strings.TrimSpace(cfg.Model); model != "" {
		args = append(args, "--model", model)
	}
	if budget := strings.TrimSpace(cfg.MaxBudgetUSD); budget != "" {
		args = append(args, "--max-budget-usd", budget)
	}
	args = append(args, buildPrompt(input))
	return args
}
