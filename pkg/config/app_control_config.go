package config

import (
	"strings"
	"time"
)

func buildAppControlConfig(raw rawAppControl) AppControlConfig {
	return AppControlConfig{
		Provider:      stringOrDefault(raw.Provider, defaultAppControlProvider),
		Timeout:       durationOrDefault(raw.Timeout, defaultAppControlTimeout),
		CodexFallback: boolPtrOrDefault(raw.CodexFallback, defaultAppControlCodexFallback),
		KWWK: KWWKAppControlConfig{
			Command: strings.TrimSpace(raw.KWWK.Command),
			Dir:     strings.TrimSpace(raw.KWWK.Dir),
		},
	}
}

func applyAppControlEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_APP_CONTROL_PROVIDER", "MAB_APP_CONTROL_PROVIDER")); value != "" {
		cfg.AppControl.Provider = value
	}
	if value, ok := getenvDuration("ONEESAMA_APP_CONTROL_TIMEOUT", "MAB_APP_CONTROL_TIMEOUT"); ok {
		cfg.AppControl.Timeout = value
	}
	if value, ok := getenvBool("ONEESAMA_APP_CONTROL_CODEX_FALLBACK", "MAB_APP_CONTROL_CODEX_FALLBACK"); ok {
		cfg.AppControl.CodexFallback = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_KWWK_APP_CONTROL_COMMAND", "MAB_KWWK_APP_CONTROL_COMMAND")); value != "" {
		cfg.AppControl.KWWK.Command = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_KWWK_APP_CONTROL_DIR", "MAB_KWWK_APP_CONTROL_DIR")); value != "" {
		cfg.AppControl.KWWK.Dir = value
	}
}

func NormalizeAppControlProvider(value string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
	switch normalized {
	case "kwwk-computer-use", "kwwk-cu", "computer-use":
		return "kwwk"
	case "agent-runner", "worker":
		return "codex"
	case "":
		return defaultAppControlProvider
	default:
		return normalized
	}
}

func defaultedAppControlTimeout(value time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return defaultAppControlTimeout
}
