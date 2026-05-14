package config

import (
	"strings"
	"time"
)

func buildAgentRunnerConfig(raw rawAgentRunner) AgentRunnerConfig {
	return AgentRunnerConfig{
		Provider:   stringOrDefault(raw.Provider, defaultAgentRunner),
		DryRun:     raw.DryRun,
		JobTimeout: durationOrDefault(raw.JobTimeout, defaultAgentJobTimeout),
		Codex: CodexRunnerConfig{
			Bin:           stringOrDefault(raw.Codex.Bin, defaultCodexBin),
			Model:         stringOrDefault(raw.Codex.Model, defaultCodexModel),
			Sandbox:       strings.TrimSpace(raw.Codex.Sandbox),
			ModelProvider: strings.TrimSpace(raw.Codex.ModelProvider),
			BaseURL:       trimURL(raw.Codex.BaseURL),
			EnvKey:        strings.TrimSpace(raw.Codex.EnvKey),
			WireAPI:       strings.TrimSpace(raw.Codex.WireAPI),
		},
		Claude: ClaudeRunnerConfig{
			Bin:                 stringOrDefault(raw.Claude.Bin, defaultClaudeBin),
			Model:               stringOrDefault(raw.Claude.Model, defaultClaudeModel),
			ReadPermissionMode:  stringOrDefault(raw.Claude.ReadPermissionMode, defaultClaudeReadMode),
			WritePermissionMode: stringOrDefault(raw.Claude.WritePermissionMode, defaultClaudeWriteMode),
			MaxBudgetUSD:        strings.TrimSpace(raw.Claude.MaxBudgetUSD),
		},
		Ollama: OllamaRunnerConfig{
			BaseURL: stringOrDefault(strings.TrimRight(strings.TrimSpace(raw.Ollama.BaseURL), "/"), defaultOllamaBaseURL),
			Model:   stringOrDefault(raw.Ollama.Model, defaultOllamaModel),
		},
	}
}

func applyAgentRunnerEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_AGENT_RUNNER", "MAB_AGENT_RUNNER")); value != "" {
		cfg.AgentRunner.Provider = value
	}
	if value, ok := getenvBool("ONEESAMA_DRY_RUN_AGENT", "MAB_DRY_RUN_AGENT"); ok {
		cfg.AgentRunner.DryRun = value
	}
	if value, ok := getenvDuration("ONEESAMA_AGENT_RUNNER_JOB_TIMEOUT", "MAB_AGENT_RUNNER_JOB_TIMEOUT"); ok {
		cfg.AgentRunner.JobTimeout = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_BIN", "MAB_CODEX_BIN")); value != "" {
		cfg.AgentRunner.Codex.Bin = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_MODEL", "MAB_CODEX_MODEL")); value != "" {
		cfg.AgentRunner.Codex.Model = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_SANDBOX", "MAB_CODEX_SANDBOX")); value != "" {
		cfg.AgentRunner.Codex.Sandbox = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_MODEL_PROVIDER", "MAB_CODEX_MODEL_PROVIDER")); value != "" {
		cfg.AgentRunner.Codex.ModelProvider = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_BASE_URL", "MAB_CODEX_BASE_URL")); value != "" {
		cfg.AgentRunner.Codex.BaseURL = trimURL(value)
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_ENV_KEY", "MAB_CODEX_ENV_KEY")); value != "" {
		cfg.AgentRunner.Codex.EnvKey = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CODEX_WIRE_API", "MAB_CODEX_WIRE_API")); value != "" {
		cfg.AgentRunner.Codex.WireAPI = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CLAUDE_BIN", "MAB_CLAUDE_BIN")); value != "" {
		cfg.AgentRunner.Claude.Bin = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CLAUDE_MODEL", "MAB_CLAUDE_MODEL")); value != "" {
		cfg.AgentRunner.Claude.Model = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CLAUDE_READ_PERMISSION_MODE", "MAB_CLAUDE_READ_PERMISSION_MODE")); value != "" {
		cfg.AgentRunner.Claude.ReadPermissionMode = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CLAUDE_WRITE_PERMISSION_MODE", "MAB_CLAUDE_WRITE_PERMISSION_MODE")); value != "" {
		cfg.AgentRunner.Claude.WritePermissionMode = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CLAUDE_MAX_BUDGET_USD", "MAB_CLAUDE_MAX_BUDGET_USD")); value != "" {
		cfg.AgentRunner.Claude.MaxBudgetUSD = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OLLAMA_BASE_URL", "MAB_OLLAMA_BASE_URL")); value != "" {
		cfg.AgentRunner.Ollama.BaseURL = strings.TrimRight(value, "/")
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OLLAMA_MODEL", "MAB_OLLAMA_MODEL")); value != "" {
		cfg.AgentRunner.Ollama.Model = value
	}
	if value, ok := getenvBool("MAB_DRY_RUN_CODEX"); ok && normalizeAgentRunnerProvider(cfg.AgentRunner.Provider) == "codex" {
		cfg.AgentRunner.DryRun = value
	}
}

func normalizeAgentRunnerProvider(value string) string {
	return strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func durationOrDefault(raw string, fallback time.Duration) time.Duration {
	if parsed, err := time.ParseDuration(strings.TrimSpace(raw)); err == nil && parsed > 0 {
		return parsed
	}
	return fallback
}

func trimURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}
