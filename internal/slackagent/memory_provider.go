package slackagent

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"
)

type SlackMemoryProviderInit struct {
	WorkspaceDir string
	MemoryDir    string
}

type SlackMemoryProviderSearchRequest struct {
	Query     string
	Tokens    []string
	Limit     int
	Now       time.Time
	SessionID string
	Metadata  map[string]any
}

type SlackMemoryProviderSearchResult struct {
	Provider string
	Status   string
	Records  []SlackRelatedMemoryRecord
}

type SlackMemoryProviderTurn struct {
	SessionID        string
	UserContent      string
	AssistantContent string
	Metadata         map[string]any
}

type SlackMemoryProviderWriteEvent struct {
	Action   string
	Target   string
	Path     string
	Content  string
	Source   string
	Metadata map[string]any
}

type SlackMemoryProviderCompressionEvent struct {
	SessionID string
	Messages  []map[string]any
	Metadata  map[string]any
}

type SlackMemoryProviderDelegationEvent struct {
	SessionID      string
	ChildSessionID string
	Task           string
	Result         string
	Metadata       map[string]any
}

type SlackMemoryProvider interface {
	Name() string
	Available() bool
	Initialize(ctx context.Context, init SlackMemoryProviderInit) error
	Search(ctx context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error)
	SyncTurn(ctx context.Context, turn SlackMemoryProviderTurn) error
	OnMemoryWrite(ctx context.Context, event SlackMemoryProviderWriteEvent) error
	OnPreCompress(ctx context.Context, event SlackMemoryProviderCompressionEvent) (string, error)
	OnDelegation(ctx context.Context, event SlackMemoryProviderDelegationEvent) error
	Shutdown(ctx context.Context) error
}

type SlackMemoryNoopProvider struct{}

func (SlackMemoryNoopProvider) Available() bool { return true }

func (SlackMemoryNoopProvider) Initialize(context.Context, SlackMemoryProviderInit) error { return nil }

func (SlackMemoryNoopProvider) Search(context.Context, SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	return SlackMemoryProviderSearchResult{}, nil
}

func (SlackMemoryNoopProvider) SyncTurn(context.Context, SlackMemoryProviderTurn) error { return nil }

func (SlackMemoryNoopProvider) OnMemoryWrite(context.Context, SlackMemoryProviderWriteEvent) error {
	return nil
}

func (SlackMemoryNoopProvider) OnPreCompress(context.Context, SlackMemoryProviderCompressionEvent) (string, error) {
	return "", nil
}

func (SlackMemoryNoopProvider) OnDelegation(context.Context, SlackMemoryProviderDelegationEvent) error {
	return nil
}

func (SlackMemoryNoopProvider) Shutdown(context.Context) error { return nil }

type SlackMemoryProviderStatus struct {
	Name        string `json:"name"`
	Available   bool   `json:"available"`
	Initialized bool   `json:"initialized"`
	LastError   string `json:"lastError,omitempty"`
}

type slackMemoryProviderState struct {
	provider    SlackMemoryProvider
	name        string
	available   bool
	initialized bool
	lastError   string
}

type slackMemoryProviderManager struct {
	mu       sync.Mutex
	logger   *slog.Logger
	init     SlackMemoryProviderInit
	provider []slackMemoryProviderState
}

func newSlackMemoryProviderManager(logger *slog.Logger, init SlackMemoryProviderInit, providers ...SlackMemoryProvider) *slackMemoryProviderManager {
	manager := &slackMemoryProviderManager{logger: logger, init: init}
	for _, provider := range providers {
		manager.Register(context.Background(), provider)
	}
	return manager
}

func (m *slackMemoryProviderManager) Register(ctx context.Context, provider SlackMemoryProvider) {
	if m == nil || provider == nil {
		return
	}
	name := strings.TrimSpace(provider.Name())
	if name == "" {
		name = "unnamed"
	}
	state := slackMemoryProviderState{provider: provider, name: name, available: provider.Available()}
	if !state.available {
		state.lastError = "provider_unavailable"
		m.appendState(state)
		return
	}
	if err := provider.Initialize(ctx, m.init); err != nil {
		state.available = false
		state.lastError = err.Error()
		m.logWarn("memory provider initialize failed", "provider", name, "error", err)
		m.appendState(state)
		return
	}
	state.initialized = true
	m.appendState(state)
}

func (m *slackMemoryProviderManager) appendState(state slackMemoryProviderState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.provider {
		if existing.name == state.name {
			state.lastError = firstNonEmpty(state.lastError, "duplicate_provider_name")
			state.available = false
			state.initialized = false
			break
		}
	}
	m.provider = append(m.provider, state)
}

func (m *slackMemoryProviderManager) Search(ctx context.Context, request SlackMemoryProviderSearchRequest) []SlackRelatedMemoryRecord {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	providers := append([]slackMemoryProviderState(nil), m.provider...)
	m.mu.Unlock()

	var records []SlackRelatedMemoryRecord
	for _, state := range providers {
		if !state.available || !state.initialized || state.provider == nil {
			continue
		}
		result, err := state.provider.Search(ctx, request)
		if err != nil {
			m.recordError(state.name, err)
			continue
		}
		providerName := firstNonEmpty(strings.TrimSpace(result.Provider), state.name)
		for _, record := range result.Records {
			record = normalizeMemoryProviderRecord(providerName, record)
			if strings.TrimSpace(record.Content) == "" {
				continue
			}
			records = append(records, record)
		}
	}
	return records
}

func (m *slackMemoryProviderManager) OnMemoryWrite(ctx context.Context, event SlackMemoryProviderWriteEvent) {
	if m == nil {
		return
	}
	m.mu.Lock()
	providers := append([]slackMemoryProviderState(nil), m.provider...)
	m.mu.Unlock()
	for _, state := range providers {
		if !state.available || !state.initialized || state.provider == nil {
			continue
		}
		if err := state.provider.OnMemoryWrite(ctx, event); err != nil {
			m.recordError(state.name, err)
		}
	}
}

func (m *slackMemoryProviderManager) SyncTurn(ctx context.Context, turn SlackMemoryProviderTurn) {
	if m == nil {
		return
	}
	if strings.TrimSpace(turn.UserContent) == "" && strings.TrimSpace(turn.AssistantContent) == "" {
		return
	}
	m.mu.Lock()
	providers := append([]slackMemoryProviderState(nil), m.provider...)
	m.mu.Unlock()
	for _, state := range providers {
		if !state.available || !state.initialized || state.provider == nil {
			continue
		}
		if err := state.provider.SyncTurn(ctx, turn); err != nil {
			m.recordError(state.name, err)
		}
	}
}

func (m *slackMemoryProviderManager) Status() []SlackMemoryProviderStatus {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SlackMemoryProviderStatus, 0, len(m.provider))
	for _, state := range m.provider {
		out = append(out, SlackMemoryProviderStatus{
			Name:        state.name,
			Available:   state.available,
			Initialized: state.initialized,
			LastError:   state.lastError,
		})
	}
	return out
}

func (m *slackMemoryProviderManager) recordError(name string, err error) {
	if err == nil {
		return
	}
	m.mu.Lock()
	for i := range m.provider {
		if m.provider[i].name == name {
			m.provider[i].lastError = err.Error()
			break
		}
	}
	m.mu.Unlock()
	m.logWarn("memory provider hook failed", "provider", name, "error", err)
}

func (m *slackMemoryProviderManager) logWarn(msg string, args ...any) {
	if m != nil && m.logger != nil {
		m.logger.Warn(msg, args...)
	}
}

func normalizeMemoryProviderRecord(provider string, record SlackRelatedMemoryRecord) SlackRelatedMemoryRecord {
	provider = strings.TrimSpace(provider)
	record.Kind = firstNonEmpty(strings.TrimSpace(record.Kind), "external_memory")
	if strings.TrimSpace(record.Source) == "" {
		record.Source = provider
	}
	if provider != "" {
		record.Reasons = compactUniqueStrings(append(record.Reasons, "memory_provider:"+provider))
	}
	return record
}
