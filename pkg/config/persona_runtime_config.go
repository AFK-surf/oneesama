package config

import "strings"

func applyPersonaRuntimeEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_PERSONA_RUNTIME", "MAB_PERSONA_RUNTIME")); value != "" {
		cfg.PersonaRuntime.Provider = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_PERSONA_RUNTIME_MODE", "MAB_PERSONA_RUNTIME_MODE")); value != "" {
		cfg.PersonaRuntime.Mode = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_PERSONA_RUNTIME_BASE_URL", "MAB_PERSONA_RUNTIME_BASE_URL")); value != "" {
		cfg.PersonaRuntime.BaseURL = trimURL(value)
	}
	if value, ok := getenvDuration("ONEESAMA_PERSONA_RUNTIME_TIMEOUT", "MAB_PERSONA_RUNTIME_TIMEOUT"); ok {
		cfg.PersonaRuntime.Timeout = value
	}
	if value, ok := getenvBool("ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY", "MAB_PERSONA_RUNTIME_SHADOW_ONLY"); ok {
		cfg.PersonaRuntime.ShadowOnly = value
	}
}

func normalizePersonaRuntimeProvider(value string) string {
	return strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func normalizePersonaRuntimeMode(value string) string {
	return strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
}
