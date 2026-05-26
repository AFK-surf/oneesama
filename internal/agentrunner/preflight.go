package agentrunner

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

var preflightHTTPClient = &http.Client{Timeout: 5 * time.Second}

func Preflight(ctx context.Context, cfg appconfig.AgentRunnerConfig) error {
	provider := normalizeProvider(cfg.Provider)
	if cfg.DryRun || provider == "" || provider == "dry-run" {
		return nil
	}

	switch provider {
	case "codex":
		if err := validateRunnerBinary("codex", cfg.Codex.Bin); err != nil {
			return err
		}
		return validateCodexProviderEnv(cfg.Codex)
	case "claude", "claude-code":
		return validateRunnerBinary("claude", cfg.Claude.Bin)
	case "ollama", "ollama-http", "local-ollama":
		return validateOllama(ctx, cfg.Ollama)
	default:
		return fmt.Errorf("unsupported agent runner provider %q", cfg.Provider)
	}
}

func validateRunnerBinary(provider string, bin string) error {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return fmt.Errorf("%s binary is not configured", provider)
	}
	if _, err := exec.LookPath(bin); err != nil {
		return fmt.Errorf("%s binary %q is not available: %w", provider, bin, err)
	}
	return nil
}

func validateCodexProviderEnv(cfg appconfig.CodexRunnerConfig) error {
	envKey := RequiredCodexProviderEnvKey(cfg)
	if envKey == "" {
		return nil
	}
	if value := strings.TrimSpace(os.Getenv(envKey)); value == "" {
		return fmt.Errorf("codex provider env %s is required but not exported", envKey)
	}
	return nil
}

func RequiredCodexProviderEnvKey(cfg appconfig.CodexRunnerConfig) string {
	provider := strings.TrimSpace(cfg.ModelProvider)
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if provider == "" && baseURL != "" {
		provider = "openrouter"
	}
	if provider == "" || baseURL == "" {
		return ""
	}
	envKey := strings.TrimSpace(cfg.EnvKey)
	if envKey == "" {
		envKey = defaultCodexProviderEnvKey(baseURL)
	}
	return envKey
}

func validateOllama(ctx context.Context, cfg appconfig.OllamaRunnerConfig) error {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		return fmt.Errorf("ollama base URL is not configured")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return fmt.Errorf("ollama model is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/tags", nil)
	if err != nil {
		return fmt.Errorf("build ollama preflight request: %w", err)
	}
	response, err := preflightHTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("ollama preflight request failed: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	bodyText := strings.TrimSpace(string(body))
	if bodyText == "" {
		bodyText = http.StatusText(response.StatusCode)
	}
	return fmt.Errorf("ollama preflight failed with status %d: %s", response.StatusCode, bodyText)
}
