//go:build cueboardparity

package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCueboardParitySlackSecretsFileLoadsWithoutOverridingEnv(t *testing.T) {
	clearCueboardSlackConfigParityEnv(t)

	dir := t.TempDir()
	secretsPath := filepath.Join(dir, "oneesama.env")
	if err := os.WriteFile(secretsPath, []byte(`
SLACK_BOT_TOKEN=xoxb-file-token
SLACK_APP_TOKEN=xapp-file-token
ONEESAMA_INTERNAL_AUTH_KEY=file-internal-key
ONEESAMA_SLACK_EVENT_MAX_BATCH=7
GH_TOKEN=ghp_demo
QUOTED_SECRET="quoted value"
`), 0o600); err != nil {
		t.Fatalf("write secrets: %v", err)
	}

	t.Setenv(oneesamaSecretsEnvOverrideKey, secretsPath)
	t.Setenv("SLACK_BOT_TOKEN", "xoxb-env-token")

	cfg := loadInTempDir(t)
	if cfg.SecretsFilePath != secretsPath {
		t.Fatalf("SecretsFilePath = %q, want %q", cfg.SecretsFilePath, secretsPath)
	}
	if cfg.Slack.BotToken != "xoxb-env-token" {
		t.Fatalf("Slack.BotToken = %q, want existing env to win over secrets file", cfg.Slack.BotToken)
	}
	if cfg.Slack.AppToken != "xapp-file-token" {
		t.Fatalf("Slack.AppToken = %q, want secrets file value", cfg.Slack.AppToken)
	}
	if cfg.Slack.InternalAuthKey != "file-internal-key" {
		t.Fatalf("Slack.InternalAuthKey = %q, want secrets file value", cfg.Slack.InternalAuthKey)
	}
	if cfg.Slack.EventBuffer.MaxBatch != 7 {
		t.Fatalf("Slack.EventBuffer.MaxBatch = %d, want secrets file env override", cfg.Slack.EventBuffer.MaxBatch)
	}
	if got := os.Getenv("GH_TOKEN"); got != "ghp_demo" {
		t.Fatalf("GH_TOKEN = %q, want passthrough secrets env", got)
	}
	if got := os.Getenv("QUOTED_SECRET"); got != "quoted value" {
		t.Fatalf("QUOTED_SECRET = %q, want quotes stripped", got)
	}
}

func TestCueboardParitySlackLegacyConfigPathLoadsCurrentJSONConfig(t *testing.T) {
	clearCueboardSlackConfigParityEnv(t)

	dir := t.TempDir()
	configPath := filepath.Join(dir, "slack-agentd.json")
	if err := os.WriteFile(configPath, []byte(`{
  "slack": {
    "workspace_dir": "./workspace-from-file",
    "event_buffer": {"enabled": true, "triage": true, "max_batch": 3, "debounce": "4s"},
    "memory": {"enabled": true, "dir": "./memory-from-file"}
  },
  "meetd": {"watch_interval": "2m"}
}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	t.Setenv("SLACK_AGENT_CONFIG_FILE", configPath)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ConfigFilePath != configPath {
		t.Fatalf("ConfigFilePath = %q, want legacy path", cfg.ConfigFilePath)
	}
	if cfg.Slack.WorkspaceDir != "./workspace-from-file" {
		t.Fatalf("Slack.WorkspaceDir = %q, want file value", cfg.Slack.WorkspaceDir)
	}
	if !cfg.Slack.EventBuffer.Enabled || !cfg.Slack.EventBuffer.Triage {
		t.Fatalf("Slack.EventBuffer = %#v, want enabled triage from file", cfg.Slack.EventBuffer)
	}
	if cfg.Slack.EventBuffer.MaxBatch != 3 || cfg.Slack.EventBuffer.Debounce != 4*time.Second {
		t.Fatalf("Slack.EventBuffer = %#v, want file max_batch/debounce", cfg.Slack.EventBuffer)
	}
	if !cfg.Slack.Memory.Enabled || cfg.Slack.Memory.Dir != "./memory-from-file" {
		t.Fatalf("Slack.Memory = %#v, want file memory config", cfg.Slack.Memory)
	}
	if cfg.Meetd.WatchInterval != 2*time.Minute {
		t.Fatalf("Meetd.WatchInterval = %v, want 2m", cfg.Meetd.WatchInterval)
	}
}

func TestCueboardParitySlackScannerEnvAliases(t *testing.T) {
	clearCueboardSlackConfigParityEnv(t)
	t.Setenv("SCAN_MAX_BATCH", "50")
	t.Setenv("SCAN_DEBOUNCE", "1m")

	cfg := loadInTempDir(t)
	if cfg.Slack.EventBuffer.MaxBatch != 50 {
		t.Fatalf("Slack.EventBuffer.MaxBatch = %d, want SCAN_MAX_BATCH alias", cfg.Slack.EventBuffer.MaxBatch)
	}
	if cfg.Slack.EventBuffer.Debounce != time.Minute {
		t.Fatalf("Slack.EventBuffer.Debounce = %v, want SCAN_DEBOUNCE alias", cfg.Slack.EventBuffer.Debounce)
	}
}

func TestCueboardParitySlackRunModeMapsToAgentRunnerConfig(t *testing.T) {
	clearCueboardSlackConfigParityEnv(t)
	t.Setenv("ONEESAMA_AGENT_RUNNER", "claude-code")
	t.Setenv("ONEESAMA_DRY_RUN_AGENT", "true")

	cfg := loadInTempDir(t)
	if cfg.AgentRunner.Provider != "claude-code" || !cfg.AgentRunner.DryRun {
		t.Fatalf("AgentRunner = %#v, want claude-code dry-run", cfg.AgentRunner)
	}
}

func TestCueboardParitySlackInvalidRunModeFailsClosed(t *testing.T) {
	clearCueboardSlackConfigParityEnv(t)
	t.Setenv("ONEESAMA_AGENT_RUNNER", "banana")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want unsupported agent runner failure")
	}
}

func clearCueboardSlackConfigParityEnv(t *testing.T) {
	t.Helper()
	clearAmbientEnvOverrides(t)
	for _, key := range []string{
		oneesamaConfigEnvOverrideKey,
		oneesamaSecretsEnvOverrideKey,
		"SLACK_AGENT_CONFIG_FILE",
		"SLACK_AGENT_SECRETS_FILE",
		"SLACK_BOT_TOKEN",
		"SLACK_APP_TOKEN",
		"ONEESAMA_SLACK_BOT_TOKEN",
		"ONEESAMA_SLACK_APP_TOKEN",
		"ONEESAMA_INTERNAL_AUTH_KEY",
		"ONEESAMA_SLACK_EVENT_MAX_BATCH",
		"ONEESAMA_SLACK_EVENT_DEBOUNCE",
		"SCAN_MAX_BATCH",
		"SCAN_DEBOUNCE",
		"ONEESAMA_AGENT_RUNNER",
		"ONEESAMA_DRY_RUN_AGENT",
		"GH_TOKEN",
		"QUOTED_SECRET",
	} {
		t.Setenv(key, "")
	}
}
