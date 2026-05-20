package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadParsesPersonaRuntimeConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "persona.json")
	payload := `{
  "persona_runtime": {
    "provider": "pi",
    "mode": "shadow",
    "base_url": "http://127.0.0.1:8799/",
    "timeout": "3s",
    "shadow_only": true
  }
}`
	if err := os.WriteFile(configPath, []byte(payload), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv(oneesamaConfigEnvOverrideKey, configPath)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PersonaRuntime.Provider != "pi" ||
		cfg.PersonaRuntime.Mode != "shadow" ||
		cfg.PersonaRuntime.BaseURL != "http://127.0.0.1:8799" ||
		cfg.PersonaRuntime.Timeout != 3*time.Second ||
		!cfg.PersonaRuntime.ShadowOnly {
		t.Fatalf("PersonaRuntime = %#v, want file values", cfg.PersonaRuntime)
	}
}

func TestLoadHonorsPersonaRuntimeEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_PERSONA_RUNTIME", "fake")
	t.Setenv("ONEESAMA_PERSONA_RUNTIME_MODE", "live")
	t.Setenv("ONEESAMA_PERSONA_RUNTIME_BASE_URL", "http://127.0.0.1:8800/")
	t.Setenv("ONEESAMA_PERSONA_RUNTIME_TIMEOUT", "250ms")
	t.Setenv("ONEESAMA_PERSONA_RUNTIME_SHADOW_ONLY", "false")

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	tempDir := t.TempDir()
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	defer func() {
		if err := os.Chdir(cwd); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PersonaRuntime.Provider != "fake" ||
		cfg.PersonaRuntime.Mode != "live" ||
		cfg.PersonaRuntime.BaseURL != "http://127.0.0.1:8800" ||
		cfg.PersonaRuntime.Timeout != 250*time.Millisecond ||
		cfg.PersonaRuntime.ShadowOnly {
		t.Fatalf("PersonaRuntime = %#v, want env values", cfg.PersonaRuntime)
	}
}

func TestValidatePersonaRuntimeRequiresBaseURLForPi(t *testing.T) {
	cfg := minimalValidConfigForPersonaTest()
	cfg.PersonaRuntime.Provider = "pi"
	cfg.PersonaRuntime.BaseURL = ""
	err := Validate(cfg)
	if err == nil {
		t.Fatal("Validate() error = nil, want missing persona base_url")
	}
}

func TestValidatePersonaRuntimeAllowsOneesamaPiWithoutSidecarURL(t *testing.T) {
	cfg := minimalValidConfigForPersonaTest()
	cfg.PersonaRuntime.Provider = "oneesama-pi"
	cfg.PersonaRuntime.Mode = "live"
	cfg.PersonaRuntime.BaseURL = ""
	cfg.PersonaRuntime.ShadowOnly = false
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate() error = %v, want oneesama-pi to avoid sidecar base_url requirement", err)
	}
}

func minimalValidConfigForPersonaTest() Config {
	return Config{
		SlackAgent:     ServiceConfig{Listen: ":8780"},
		MeetingAgent:   ServiceConfig{Listen: ":8781"},
		Slack:          SlackConfig{EventBuffer: SlackEventBufferConfig{MaxBatch: 1, Debounce: time.Second}},
		AgentRunner:    AgentRunnerConfig{Provider: "dry-run", JobTimeout: time.Minute},
		PersonaRuntime: PersonaRuntimeConfig{Provider: "legacy", Mode: "shadow", Timeout: time.Second, ShadowOnly: true},
		Meetd:          MeetdConfig{WatchInterval: time.Minute},
		OpenAI: OpenAIConfig{
			BaseURL:                  "https://api.openai.com/v1",
			RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
			RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
			RealtimeModel:            "gpt-realtime-2",
			BotName:                  "bot",
		},
		Dialog:      DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"},
		Logging:     LoggingConfig{Level: "info", Format: "json"},
		Paths:       PathsConfig{MeetRunnerDir: "./meet-runner"},
		Persistence: PersistenceConfig{Provider: "memory", DataDir: ".", SQLitePath: "state.sqlite3"},
	}
}
