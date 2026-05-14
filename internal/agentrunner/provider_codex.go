package agentrunner

import (
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newCodexProvider(cfg appconfig.AgentRunnerConfig) runnerProvider {
	return commandProvider{
		provider:      "codex",
		bin:           cfg.Codex.Bin,
		dryRun:        cfg.DryRun,
		argsBuilder:   func(input StartInput) []string { return buildCodexArgs(cfg.Codex, input) },
		promptBuilder: buildPrompt,
		stdinPrompt:   true,
	}
}

func buildCodexArgs(cfg appconfig.CodexRunnerConfig, input StartInput) []string {
	sandbox := strings.TrimSpace(cfg.Sandbox)
	if sandbox == "" {
		if input.AllowCodeChanges {
			sandbox = "workspace-write"
		} else {
			sandbox = "read-only"
		}
	}

	args := []string{"exec"}
	if model := strings.TrimSpace(cfg.Model); model != "" {
		args = append(args, "-m", model)
	}
	args = append(args,
		"-c", `approval_policy="never"`,
		"-s", sandbox,
		"--skip-git-repo-check",
		"--ephemeral",
		"-",
	)
	return args
}
