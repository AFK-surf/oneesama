package slackagent

import (
	"context"
	"errors"
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
	searchErrs []error
	searchErr  error
	writes     []SlackMemoryProviderWriteEvent
	writeErr   error
	turns      []SlackMemoryProviderTurn
	turnErr    error
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

func (p *simpleRecordingMemoryProvider) Search(ctx context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	p.searches = append(p.searches, request)
	p.searchErrs = append(p.searchErrs, ctx.Err())
	if p.searchErr != nil {
		return SlackMemoryProviderSearchResult{}, p.searchErr
	}
	return SlackMemoryProviderSearchResult{Provider: p.name, Status: "ok", Records: p.searchHits}, nil
}

func (p *simpleRecordingMemoryProvider) OnMemoryWrite(_ context.Context, event SlackMemoryProviderWriteEvent) error {
	p.writes = append(p.writes, event)
	return p.writeErr
}

func (p *simpleRecordingMemoryProvider) SyncTurn(_ context.Context, turn SlackMemoryProviderTurn) error {
	p.turns = append(p.turns, turn)
	return p.turnErr
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

func TestSearchRelatedMemoryContextPassesCallerContextToProviders(t *testing.T) {
	t.Parallel()

	provider := &simpleRecordingMemoryProvider{
		name:      "semantic_fake",
		available: true,
		searchHits: []SlackRelatedMemoryRecord{{
			Kind:    "semantic_memory",
			Source:  "semantic://ctx",
			Content: "Context propagation canary memory.",
			Score:   0.99,
		}},
	}
	service := NewService(Config{
		Slack:           appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		MemoryProviders: []SlackMemoryProvider{provider},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_ = service.SearchRelatedMemoryContext(ctx, "context propagation canary", SlackRelatedMemorySearchOptions{Limit: 3})

	if len(provider.searchErrs) != 1 {
		t.Fatalf("provider search contexts = %#v, want one", provider.searchErrs)
	}
	if provider.searchErrs[0] != context.Canceled {
		t.Fatalf("provider ctx err = %v, want context.Canceled", provider.searchErrs[0])
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

func TestMemoryProviderManagerSearchIsolatesProviderErrorAndContinues(t *testing.T) {
	t.Parallel()

	failingErr := errors.New("semantic backend down")
	failing := &simpleRecordingMemoryProvider{name: "semantic_failing", available: true, searchErr: failingErr}
	healthy := &simpleRecordingMemoryProvider{
		name:      "semantic_healthy",
		available: true,
		searchHits: []SlackRelatedMemoryRecord{{
			Kind:    "semantic_memory",
			Source:  "semantic://healthy",
			Content: "Healthy provider result should still be available.",
			Score:   0.9,
		}},
	}
	manager := newSlackMemoryProviderManager(nil, SlackMemoryProviderInit{}, failing, healthy)

	records := manager.Search(context.Background(), SlackMemoryProviderSearchRequest{Query: "healthy", Tokens: []string{"healthy"}, Limit: 5})

	if len(records) != 1 || records[0].Source != "semantic://healthy" {
		t.Fatalf("records = %#v, want healthy provider result", records)
	}
	if len(failing.searches) != 1 || len(healthy.searches) != 1 {
		t.Fatalf("search calls failing=%d healthy=%d, want both called", len(failing.searches), len(healthy.searches))
	}
	if got := memoryProviderStatusLastError(manager.Status(), "semantic_failing"); got != failingErr.Error() {
		t.Fatalf("failing provider last error = %q, want %q", got, failingErr.Error())
	}
}

func TestMemoryProviderManagerWriteIsolatesProviderErrorAndContinues(t *testing.T) {
	t.Parallel()

	failingErr := errors.New("write mirror failed")
	failing := &simpleRecordingMemoryProvider{name: "mirror_failing", available: true, writeErr: failingErr}
	healthy := &simpleRecordingMemoryProvider{name: "mirror_healthy", available: true}
	manager := newSlackMemoryProviderManager(nil, SlackMemoryProviderInit{}, failing, healthy)
	event := SlackMemoryProviderWriteEvent{Action: "write", Target: "workspace", Path: "memory/notes.md", Content: "hello"}

	manager.OnMemoryWrite(context.Background(), event)

	if len(failing.writes) != 1 || len(healthy.writes) != 1 {
		t.Fatalf("write calls failing=%d healthy=%d, want both called", len(failing.writes), len(healthy.writes))
	}
	if got := memoryProviderStatusLastError(manager.Status(), "mirror_failing"); got != failingErr.Error() {
		t.Fatalf("failing provider last error = %q, want %q", got, failingErr.Error())
	}
}

func TestMemoryProviderManagerSyncTurnIsolatesProviderErrorAndContinues(t *testing.T) {
	t.Parallel()

	failingErr := errors.New("sync failed")
	failing := &simpleRecordingMemoryProvider{name: "turn_failing", available: true, turnErr: failingErr}
	healthy := &simpleRecordingMemoryProvider{name: "turn_healthy", available: true}
	manager := newSlackMemoryProviderManager(nil, SlackMemoryProviderInit{}, failing, healthy)
	turn := SlackMemoryProviderTurn{SessionID: "session_sync", UserContent: "user", AssistantContent: "assistant"}

	manager.SyncTurn(context.Background(), turn)

	if len(failing.turns) != 1 || len(healthy.turns) != 1 {
		t.Fatalf("turn calls failing=%d healthy=%d, want both called", len(failing.turns), len(healthy.turns))
	}
	if got := memoryProviderStatusLastError(manager.Status(), "turn_failing"); got != failingErr.Error() {
		t.Fatalf("failing provider last error = %q, want %q", got, failingErr.Error())
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

func memoryProviderStatusLastError(items []SlackMemoryProviderStatus, name string) string {
	for _, item := range items {
		if item.Name == name {
			return item.LastError
		}
	}
	return ""
}
