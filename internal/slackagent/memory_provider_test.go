package slackagent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type simpleRecordingMemoryProvider struct {
	SlackMemoryNoopProvider
	name       string
	available  bool
	init       SlackMemoryProviderInit
	searches   []SlackMemoryProviderSearchRequest
	writes     []SlackMemoryProviderWriteEvent
	turns      []SlackMemoryProviderTurn
	searchHits []SlackRelatedMemoryRecord
}

func (p *simpleRecordingMemoryProvider) Name() string { return p.name }

func (p *simpleRecordingMemoryProvider) Available() bool {
	if !p.available {
		return false
	}
	return true
}

func (p *simpleRecordingMemoryProvider) Initialize(_ context.Context, init SlackMemoryProviderInit) error {
	p.init = init
	return nil
}

func (p *simpleRecordingMemoryProvider) Search(_ context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	p.searches = append(p.searches, request)
	return SlackMemoryProviderSearchResult{Provider: p.name, Status: "ok", Records: p.searchHits}, nil
}

func (p *simpleRecordingMemoryProvider) OnMemoryWrite(_ context.Context, event SlackMemoryProviderWriteEvent) error {
	p.writes = append(p.writes, event)
	return nil
}

func (p *simpleRecordingMemoryProvider) SyncTurn(_ context.Context, turn SlackMemoryProviderTurn) error {
	p.turns = append(p.turns, turn)
	return nil
}

func TestSearchRelatedMemoryMergesExternalProviderRecords(t *testing.T) {
	t.Parallel()

	provider := &simpleRecordingMemoryProvider{
		name:      "semantic_fake",
		available: true,
		searchHits: []SlackRelatedMemoryRecord{{
			Kind:    "semantic_memory",
			Source:  "semantic://jc-case-study",
			Title:   "Jc case study",
			Content: "Jc case study recording preference from semantic Memory.",
			Score:   0.99,
		}},
	}
	service := NewService(Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		MemoryProviders: []SlackMemoryProvider{
			provider,
		},
	})

	result := service.SearchRelatedMemory("did Jc record the case study videos?", SlackRelatedMemorySearchOptions{Limit: 3})
	if len(provider.searches) != 1 {
		t.Fatalf("provider searches = %#v, want one search", provider.searches)
	}
	if provider.searches[0].Query == "" || len(provider.searches[0].Tokens) == 0 {
		t.Fatalf("provider search = %#v, want query and tokens", provider.searches[0])
	}
	if len(result.Results) != 1 {
		t.Fatalf("results = %#v, want provider result", result.Results)
	}
	got := result.Results[0]
	if got.Source != "semantic://jc-case-study" || !stringSliceContains(got.Reasons, "memory_provider:semantic_fake") {
		t.Fatalf("provider result = %#v, want normalized provider provenance", got)
	}
	if !memoryProviderStatusIncludes(service.MemorySummary().Providers, "semantic_fake", true) {
		t.Fatalf("memory summary providers = %#v, want semantic_fake", service.MemorySummary().Providers)
	}
}

func TestMemoryWriteMirrorsToProvider(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	provider := &simpleRecordingMemoryProvider{name: "mirror_fake", available: true}
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			Memory: appconfig.SlackMemoryConfig{Enabled: true, Dir: filepath.Join(root, "memory")},
		},
		MemoryProviders: []SlackMemoryProvider{provider},
	})

	response := service.executeMemoryWriteTool(context.Background(), map[string]any{
		"path":    "memory/notes/provider-mirror.md",
		"content": "Provider mirror note.",
	})
	if !response.OK {
		t.Fatalf("memory_write = %#v, want ok", response)
	}
	if len(provider.writes) != 1 {
		t.Fatalf("provider writes = %#v, want one mirrored write", provider.writes)
	}
	got := provider.writes[0]
	if got.Action != "write" || got.Target != "workspace" || got.Path != "memory/notes/provider-mirror.md" || !strings.Contains(got.Content, "Provider mirror note") {
		t.Fatalf("mirrored write = %#v, want workspace write event", got)
	}
}

func TestMemoryProviderManagerSyncTurn(t *testing.T) {
	t.Parallel()

	provider := &simpleRecordingMemoryProvider{name: "turn_fake", available: true}
	service := NewService(Config{
		Slack:           appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		MemoryProviders: []SlackMemoryProvider{provider},
	})

	service.syncMemoryProvidersTurn(context.Background(), SlackMemoryProviderTurn{
		SessionID:        "session_turn",
		UserContent:      "What should Bridge remember about Cumora?",
		AssistantContent: "Cumora relates to yetone and Isoform follow-up context.",
		Metadata: map[string]any{
			"source": "unit_test",
		},
	})

	if len(provider.turns) != 1 {
		t.Fatalf("provider turns = %#v, want one SyncTurn", provider.turns)
	}
	got := provider.turns[0]
	if got.SessionID != "session_turn" || !strings.Contains(got.UserContent, "Cumora") || !strings.Contains(got.AssistantContent, "Isoform") || got.Metadata["source"] != "unit_test" {
		t.Fatalf("turn = %#v, want mirrored turn content and metadata", got)
	}
}

func memoryProviderStatusIncludes(items []SlackMemoryProviderStatus, name string, initialized bool) bool {
	for _, item := range items {
		if item.Name == name && item.Initialized == initialized {
			return true
		}
	}
	return false
}
