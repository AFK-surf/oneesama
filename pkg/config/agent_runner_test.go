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
    "codex": {"bin": "codex-dev", "model": "gpt-5.6", "sandbox": "workspace-write"},
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
	if cfg.AgentRunner.Codex.Bin != "codex-dev" || cfg.AgentRunner.Codex.Model != "gpt-5.6" {
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
	t.Setenv("ONEESAMA_CODEX_MODEL", "gpt-6")
	t.Setenv("ONEESAMA_CODEX_SANDBOX", "workspace-write")
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
	if cfg.AgentRunner.Codex.Bin != "codex-ci" || cfg.AgentRunner.Codex.Sandbox != "workspace-write" {
		t.Fatalf("Codex env override = %#v, want env values", cfg.AgentRunner.Codex)
	}
	if cfg.AgentRunner.Claude.Bin != "claude-ci" || cfg.AgentRunner.Claude.MaxBudgetUSD != "0.20" {
		t.Fatalf("Claude env override = %#v, want env values", cfg.AgentRunner.Claude)
	}
	if cfg.AgentRunner.Ollama.BaseURL != "http://127.0.0.1:11436" || cfg.AgentRunner.Ollama.Model != "llama3.3" {
		t.Fatalf("Ollama env override = %#v, want trimmed env values", cfg.AgentRunner.Ollama)
	}
}
