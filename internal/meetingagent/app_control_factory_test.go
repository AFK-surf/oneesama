package meetingagent

import (
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestConfiguredAppControlBackendZeroValueUsesKWWKWithoutCodexFallback(t *testing.T) {
	t.Parallel()

	backend := NewConfiguredAppControlBackend(appconfig.AppControlConfig{}, nil)
	if backend.Name() != "kwwk" {
		t.Fatalf("backend.Name() = %q, want zero-value config to match loaded KWWK default without Codex fallback", backend.Name())
	}
}

func TestConfiguredAppControlBackendHonorsExplicitCodexFallbackWithDefaultProvider(t *testing.T) {
	t.Parallel()

	backend := NewConfiguredAppControlBackend(appconfig.AppControlConfig{CodexFallback: true}, nil)
	if backend.Name() != "kwwk+codex" {
		t.Fatalf("backend.Name() = %q, want explicit Codex fallback with default KWWK provider", backend.Name())
	}
}
