package agentrunner

import (
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestBuildCodexArgsConfiguresOpenRouterResponsesProvider(t *testing.T) {
	t.Parallel()

	args := buildCodexArgs(appconfig.CodexRunnerConfig{
		Model:         "deepseek/deepseek-v4-pro",
		ModelProvider: "openrouter",
		BaseURL:       "https://openrouter.ai/api/v1/",
		EnvKey:        "OPENROUTER_API_KEY",
		WireAPI:       "responses",
	}, StartInput{AllowCodeChanges: false})
	joined := strings.Join(args, "\n")

	wantParts := []string{
		`model_provider="openrouter"`,
		`model_providers.openrouter.name="OpenRouter"`,
		`model_providers.openrouter.base_url="https://openrouter.ai/api/v1"`,
		`model_providers.openrouter.env_key="OPENROUTER_API_KEY"`,
		`model_providers.openrouter.wire_api="responses"`,
		"-m\ndeepseek/deepseek-v4-pro",
		"-s\nread-only",
	}
	for _, want := range wantParts {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q:\n%s", want, joined)
		}
	}
}

func TestBuildCodexArgsDefaultsOpenRouterProviderFromBaseURL(t *testing.T) {
	t.Parallel()

	args := buildCodexArgs(appconfig.CodexRunnerConfig{
		Model:   "deepseek/deepseek-v4-pro",
		BaseURL: "https://openrouter.ai/api/v1/",
	}, StartInput{AllowCodeChanges: true})
	joined := strings.Join(args, "\n")

	wantParts := []string{
		`model_provider="openrouter"`,
		`model_providers.openrouter.env_key="OPENROUTER_API_KEY"`,
		`model_providers.openrouter.wire_api="responses"`,
		"-s\nworkspace-write",
	}
	for _, want := range wantParts {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q:\n%s", want, joined)
		}
	}
}

func TestBuildCodexArgsHonorsInputSandboxOverrideWithoutCodeChanges(t *testing.T) {
	t.Parallel()

	args := buildCodexArgs(appconfig.CodexRunnerConfig{
		Sandbox: "read-only",
	}, StartInput{AllowCodeChanges: false, Sandbox: "danger-full-access"})
	joined := strings.Join(args, "\n")

	if !strings.Contains(joined, "-s\ndanger-full-access") {
		t.Fatalf("args = %s, want input sandbox override", joined)
	}
}

func TestBuildCodexArgsEnablesAppsForMeetingAppControl(t *testing.T) {
	t.Parallel()

	args := buildCodexArgs(appconfig.CodexRunnerConfig{
		Model:         "deepseek/deepseek-v4-pro",
		ModelProvider: "openrouter",
		BaseURL:       "https://openrouter.ai/api/v1/",
	}, WithSessionCapabilities(StartInput{Sandbox: "danger-full-access"}, SessionKindMeetingAppControl))
	joined := strings.Join(args, "\n")

	wantParts := []string{
		"--enable\napps",
		"-m\n" + defaultCodexComputerUseModel,
		"-s\ndanger-full-access",
	}
	for _, want := range wantParts {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "model_provider=\"openrouter\"") ||
		strings.Contains(joined, "model_providers.openrouter") {
		t.Fatalf("args = %s, app-control must use local Codex Computer Use provider, not OpenRouter worker config", joined)
	}
}
