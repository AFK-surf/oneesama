package persona

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestFakeRuntimeConsumesPersonaRequest(t *testing.T) {
	runtime := NewFakeRuntime(LocalConfig{Mode: ModeShadow, ShadowOnly: true})
	resp, err := runtime.Decide(context.Background(), Request{
		ID:    "req-1",
		Mode:  ModeShadow,
		Event: Event{Kind: "slack_thread", Text: "没人回这个问题"},
		Evidence: EvidenceBundle{Citations: []Citation{{
			Kind:      "memory",
			Source:    "team_decision",
			SourceRef: "notes/team.md:12",
			Snippet:   "之前讨论过这个方向。",
		}}},
		Safety: SafetyConstraints{AllowVisibleReply: true, MaxVisibleChars: 120},
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if resp.Decision != DecisionReply {
		t.Fatalf("Decision = %q, want reply", resp.Decision)
	}
	if resp.VisibleText == "" {
		t.Fatalf("VisibleText is empty")
	}
	if !resp.ShadowOnly {
		t.Fatalf("ShadowOnly = false, want true")
	}
	if len(resp.Citations) != 1 || resp.Citations[0].SourceRef != "notes/team.md:12" {
		t.Fatalf("Citations = %#v, want source ref", resp.Citations)
	}
	status := runtime.Status(context.Background())
	if status.Provider != ProviderFake || !status.Ready || !status.Healthy {
		t.Fatalf("Status = %#v, want ready fake runtime", status)
	}
	if status.StateSummary["requests"] != 1 {
		t.Fatalf("StateSummary requests = %#v, want 1", status.StateSummary["requests"])
	}
}

func TestLegacyRuntimeStaysSilent(t *testing.T) {
	runtime := NewLegacyRuntime(LocalConfig{})
	resp, err := runtime.Decide(context.Background(), Request{
		ID:     "req-legacy",
		Event:  Event{Kind: "slack_thread", Text: "hello"},
		Safety: SafetyConstraints{AllowVisibleReply: true},
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if resp.Decision != DecisionStaySilent {
		t.Fatalf("Decision = %q, want stay_silent", resp.Decision)
	}
	if !resp.ShadowOnly {
		t.Fatalf("ShadowOnly = false, want true")
	}
}

func TestNewRuntimeRejectsUnknownProvider(t *testing.T) {
	_, err := NewRuntime(Config{Provider: "lobster-in-go"})
	if err == nil {
		t.Fatal("NewRuntime() error = nil, want unsupported provider")
	}
}

func TestRegisterRuntimeFactoryAllowsExternalPersonaAdapters(t *testing.T) {
	provider := fmt.Sprintf("test-runtime-adapter-%d", time.Now().UnixNano())
	err := RegisterRuntimeFactory(provider, func(cfg Config) (Runtime, error) {
		if cfg.Provider != provider || cfg.Mode != ModeShadow || !cfg.ShadowOnly {
			t.Fatalf("factory cfg = %#v, want normalized shadow config", cfg)
		}
		return NewFakeRuntime(LocalConfig{Provider: cfg.Provider, Mode: cfg.Mode, ShadowOnly: cfg.ShadowOnly}), nil
	})
	if err != nil {
		t.Fatalf("RegisterRuntimeFactory: %v", err)
	}
	runtime, err := NewRuntime(Config{Provider: provider, Mode: ModeShadow, ShadowOnly: true})
	if err != nil {
		t.Fatalf("NewRuntime custom provider: %v", err)
	}
	status := runtime.Status(context.Background())
	if status.Provider != provider {
		t.Fatalf("Status.Provider = %q, want custom provider", status.Provider)
	}
}
