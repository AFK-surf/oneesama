package slackagent

import (
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestServiceStatusExposesPersonaRuntime(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{MaxBatch: 1, Debounce: time.Second},
			Triage:      appconfig.SlackTriageConfig{PostActions: true, HeuristicFallback: true},
		},
		AgentRunner:    appconfig.AgentRunnerConfig{Provider: "dry-run", JobTimeout: time.Minute},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{Provider: "fake", Mode: "shadow", Timeout: time.Second, ShadowOnly: true},
	})

	status := service.Status().Persona
	if status.Provider != "fake" || status.Mode != "shadow" || !status.Ready || !status.Healthy || !status.ShadowOnly {
		t.Fatalf("Persona status = %#v, want ready fake shadow runtime", status)
	}
}

func TestServiceStatusReportsPersonaRuntimeInitError(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{MaxBatch: 1, Debounce: time.Second},
			Triage:      appconfig.SlackTriageConfig{PostActions: true, HeuristicFallback: true},
		},
		AgentRunner:    appconfig.AgentRunnerConfig{Provider: "dry-run", JobTimeout: time.Minute},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{Provider: "pi", Mode: "shadow", Timeout: time.Second, ShadowOnly: true},
	})

	status := service.Status().Persona
	if status.Ready || status.Healthy || status.Error == "" {
		t.Fatalf("Persona status = %#v, want init error", status)
	}
}
