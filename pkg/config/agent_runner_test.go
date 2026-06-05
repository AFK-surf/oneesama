package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadParsesAgentRunnerConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "runner.json")
	payload := `{
  "agent_runner": {
    "provider": "claude",
    "dry_run": true,
    "job_timeout": "3m",
    "codex": {
      "bin": "codex-dev",
      "model": "deepseek/deepseek-v4-pro",
      "sandbox": "workspace-write",
      "model_provider": "openrouter",
      "base_url": "https://openrouter.ai/api/v1/",
      "env_key": "OPENROUTER_API_KEY",
      "wire_api": "responses"
    },
    "claude": {"bin": "claude-dev", "model": "opus", "read_permission_mode": "read-only", "write_permission_mode": "acceptEdits", "max_budget_usd": "0.80"},
    "ollama": {"base_url": "http://127.0.0.1:11435", "model": "qwen3"}
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
	if cfg.AgentRunner.Provider != "claude" {
		t.Fatalf("AgentRunner.Provider = %q, want claude", cfg.AgentRunner.Provider)
	}
	if !cfg.AgentRunner.DryRun {
		t.Fatalf("AgentRunner.DryRun = false, want true")
	}
	if cfg.AgentRunner.JobTimeout != 3*time.Minute {
		t.Fatalf("AgentRunner.JobTimeout = %s, want 3m", cfg.AgentRunner.JobTimeout)
	}
	if cfg.AgentRunner.Codex.Bin != "codex-dev" ||
		cfg.AgentRunner.Codex.Model != "deepseek/deepseek-v4-pro" ||
		cfg.AgentRunner.Codex.ModelProvider != "openrouter" ||
		cfg.AgentRunner.Codex.BaseURL != "https://openrouter.ai/api/v1" ||
		cfg.AgentRunner.Codex.EnvKey != "OPENROUTER_API_KEY" ||
		cfg.AgentRunner.Codex.WireAPI != "responses" {
		t.Fatalf("Codex config = %#v, want file values", cfg.AgentRunner.Codex)
	}
	if cfg.AgentRunner.Claude.Bin != "claude-dev" || cfg.AgentRunner.Claude.MaxBudgetUSD != "0.80" {
		t.Fatalf("Claude config = %#v, want file values", cfg.AgentRunner.Claude)
	}
	if cfg.AgentRunner.Ollama.BaseURL != "http://127.0.0.1:11435" || cfg.AgentRunner.Ollama.Model != "qwen3" {
		t.Fatalf("Ollama config = %#v, want file values", cfg.AgentRunner.Ollama)
	}
}

func TestLoadHonorsAgentRunnerEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_AGENT_RUNNER", "ollama")
	t.Setenv("ONEESAMA_DRY_RUN_AGENT", "true")
	t.Setenv("ONEESAMA_AGENT_RUNNER_JOB_TIMEOUT", "45s")
	t.Setenv("ONEESAMA_CODEX_BIN", "codex-ci")
	t.Setenv("ONEESAMA_CODEX_MODEL", "deepseek/deepseek-v4-pro")
	t.Setenv("ONEESAMA_CODEX_SANDBOX", "workspace-write")
	t.Setenv("ONEESAMA_CODEX_MODEL_PROVIDER", "openrouter")
	t.Setenv("ONEESAMA_CODEX_BASE_URL", "https://openrouter.ai/api/v1/")
	t.Setenv("ONEESAMA_CODEX_ENV_KEY", "OPENROUTER_API_KEY")
	t.Setenv("ONEESAMA_CODEX_WIRE_API", "responses")
	t.Setenv("ONEESAMA_CLAUDE_BIN", "claude-ci")
	t.Setenv("ONEESAMA_CLAUDE_MODEL", "sonnet-4")
	t.Setenv("ONEESAMA_CLAUDE_READ_PERMISSION_MODE", "read-only")
	t.Setenv("ONEESAMA_CLAUDE_WRITE_PERMISSION_MODE", "acceptEdits")
	t.Setenv("ONEESAMA_CLAUDE_MAX_BUDGET_USD", "0.20")
	t.Setenv("ONEESAMA_OLLAMA_BASE_URL", "http://127.0.0.1:11436/")
	t.Setenv("ONEESAMA_OLLAMA_MODEL", "llama3.3")

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
	if cfg.AgentRunner.Provider != "ollama" || !cfg.AgentRunner.DryRun {
		t.Fatalf("AgentRunner = %#v, want ollama dry-run", cfg.AgentRunner)
	}
	if cfg.AgentRunner.JobTimeout != 45*time.Second {
		t.Fatalf("AgentRunner.JobTimeout = %s, want 45s", cfg.AgentRunner.JobTimeout)
	}
	if cfg.AgentRunner.Codex.Bin != "codex-ci" ||
		cfg.AgentRunner.Codex.Model != "deepseek/deepseek-v4-pro" ||
		cfg.AgentRunner.Codex.Sandbox != "workspace-write" ||
		cfg.AgentRunner.Codex.ModelProvider != "openrouter" ||
		cfg.AgentRunner.Codex.BaseURL != "https://openrouter.ai/api/v1" ||
		cfg.AgentRunner.Codex.EnvKey != "OPENROUTER_API_KEY" ||
		cfg.AgentRunner.Codex.WireAPI != "responses" {
		t.Fatalf("Codex env override = %#v, want env values", cfg.AgentRunner.Codex)
	}
	if cfg.AgentRunner.Claude.Bin != "claude-ci" || cfg.AgentRunner.Claude.MaxBudgetUSD != "0.20" {
		t.Fatalf("Claude env override = %#v, want env values", cfg.AgentRunner.Claude)
	}
	if cfg.AgentRunner.Ollama.BaseURL != "http://127.0.0.1:11436" || cfg.AgentRunner.Ollama.Model != "llama3.3" {
		t.Fatalf("Ollama env override = %#v, want trimmed env values", cfg.AgentRunner.Ollama)
	}
}

func TestLoadParsesAppControlConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "app-control.json")
	payload := `{
  "app_control": {
    "provider": "kwwk",
    "timeout": "1500ms",
    "codex_fallback": false,
    "kwwk": {"command": "/usr/local/bin/oneesama-kwwk-helper --stdio", "dir": "/tmp/kwwk", "ensure_command": "node --import tsx packages/core/src/meeting/app-control-helper.ts --ensure-binary-json"}
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
	if cfg.AppControl.Provider != "kwwk" || cfg.AppControl.Timeout != 1500*time.Millisecond || cfg.AppControl.CodexFallback {
		t.Fatalf("AppControl = %#v, want file values", cfg.AppControl)
	}
	if cfg.AppControl.KWWK.Command != "/usr/local/bin/oneesama-kwwk-helper --stdio" ||
		cfg.AppControl.KWWK.Dir != "/tmp/kwwk" ||
		cfg.AppControl.KWWK.EnsureCommand != "node --import tsx packages/core/src/meeting/app-control-helper.ts --ensure-binary-json" {
		t.Fatalf("KWWK app control = %#v, want file values", cfg.AppControl.KWWK)
	}
}

func TestLoadHonorsAppControlEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_APP_CONTROL_PROVIDER", "codex")
	t.Setenv("ONEESAMA_APP_CONTROL_TIMEOUT", "1200ms")
	t.Setenv("ONEESAMA_APP_CONTROL_CODEX_FALLBACK", "false")
	t.Setenv("ONEESAMA_KWWK_APP_CONTROL_COMMAND", "kwwk-helper --stdio")
	t.Setenv("ONEESAMA_KWWK_APP_CONTROL_DIR", "/tmp/kwwk-env")
	t.Setenv("ONEESAMA_KWWK_APP_CONTROL_ENSURE_COMMAND", "kwwk-helper --ensure-binary-json")

	cfg := loadInTempDir(t)
	if cfg.AppControl.Provider != "codex" || cfg.AppControl.Timeout != 1200*time.Millisecond || cfg.AppControl.CodexFallback {
		t.Fatalf("AppControl env = %#v, want env values", cfg.AppControl)
	}
	if cfg.AppControl.KWWK.Command != "kwwk-helper --stdio" ||
		cfg.AppControl.KWWK.Dir != "/tmp/kwwk-env" ||
		cfg.AppControl.KWWK.EnsureCommand != "kwwk-helper --ensure-binary-json" {
		t.Fatalf("KWWK app control env = %#v, want env values", cfg.AppControl.KWWK)
	}
}
