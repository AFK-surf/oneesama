package agentrunner

import (
	"strconv"
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
	sandbox := strings.TrimSpace(input.Sandbox)
	if sandbox == "" {
		sandbox = strings.TrimSpace(cfg.Sandbox)
	}
	if sandbox == "" {
		if input.AllowCodeChanges {
			sandbox = "workspace-write"
		} else {
			sandbox = "read-only"
		}
	}

	args := []string{"exec"}
	args = appendCodexProviderArgs(args, cfg)
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

func appendCodexProviderArgs(args []string, cfg appconfig.CodexRunnerConfig) []string {
	provider := strings.TrimSpace(cfg.ModelProvider)
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if provider == "" && baseURL != "" {
		provider = "openrouter"
	}
	if provider == "" {
		return args
	}

	args = append(args, "-c", "model_provider="+tomlString(provider))
	if baseURL == "" {
		return args
	}

	envKey := strings.TrimSpace(cfg.EnvKey)
	if envKey == "" {
		envKey = defaultCodexProviderEnvKey(baseURL)
	}
	wireAPI := strings.TrimSpace(cfg.WireAPI)
	if wireAPI == "" {
		wireAPI = "responses"
	}
	name := provider
	if strings.EqualFold(provider, "openrouter") {
		name = "OpenRouter"
	}

	prefix := "model_providers." + provider + "."
	args = append(args,
		"-c", prefix+"name="+tomlString(name),
		"-c", prefix+"base_url="+tomlString(baseURL),
		"-c", prefix+"env_key="+tomlString(envKey),
		"-c", prefix+"wire_api="+tomlString(wireAPI),
	)
	return args
}

func defaultCodexProviderEnvKey(baseURL string) string {
	if strings.Contains(strings.ToLower(baseURL), "openrouter.ai") {
		return "OPENROUTER_API_KEY"
	}
	return "OPENAI_API_KEY"
}

func tomlString(value string) string {
	return strconv.Quote(value)
}
