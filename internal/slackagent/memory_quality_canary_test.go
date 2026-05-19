package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// memoryQualityFixture is the JSON-loadable shape for
// testdata/memory_quality_fixtures/*.json. Schema is documented in
// testdata/memory_quality_fixtures/README.md.
type memoryQualityFixture struct {
	CaseID                      string                       `json:"case_id"`
	Source                      memoryQualityFixtureSource   `json:"source"`
	Scenario                    memoryQualityFixtureScenario `json:"scenario"`
	ExpectedProviderEvents      memoryQualityExpectedEvents  `json:"expected_provider_events"`
	ExpectedSearchResultAnchors []string                     `json:"expected_search_result_anchors"`
	MustNotContain              []string                     `json:"must_not_contain"`
}

type memoryQualityFixtureSource struct {
	OccurredAt string `json:"occurred_at"`
	Notes      string `json:"notes"`
}

type memoryQualityFixtureScenario struct {
	Type                string                           `json:"type"`
	Pending             bool                             `json:"pending"`
	PendingReason       string                           `json:"pending_reason"`
	MemoryWrite         *memoryQualityFixtureMemoryWrite `json:"memory_write,omitempty"`
	TurnInput           *memoryQualityFixtureTurnInput   `json:"turn_input,omitempty"`
	Search              *memoryQualityFixtureSearch      `json:"search,omitempty"`
	AppMention          *memoryQualityFixtureAppMention  `json:"app_mention,omitempty"`
	ProviderSeedRecords []memoryQualityFixtureSeedRecord `json:"provider_seed_records,omitempty"`
}

type memoryQualityFixtureMemoryWrite struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Mode      string `json:"mode"`
	SessionID string `json:"session_id"`
}

type memoryQualityFixtureTurnInput struct {
	UserContent      string `json:"user_content"`
	AssistantContent string `json:"assistant_content"`
	SessionID        string `json:"session_id"`
}

type memoryQualityFixtureSearch struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

type memoryQualityFixtureAppMention struct {
	ChannelID      string            `json:"channel_id"`
	ThreadTS       string            `json:"thread_ts"`
	UserID         string            `json:"user_id"`
	UserName       string            `json:"user_name"`
	MentionText    string            `json:"mention_text"`
	RawMentionText string            `json:"raw_mention_text"`
	Prompt         string            `json:"prompt"`
	Files          []SlackThreadFile `json:"files"`
}

type memoryQualityFixtureSeedRecord struct {
	Path    string  `json:"path"`
	Content string  `json:"content"`
	Kind    string  `json:"kind"`
	Score   float64 `json:"score"`
}

type memoryQualityExpectedEvents struct {
	OnMemoryWriteCount           int    `json:"on_memory_write_count"`
	OnMemoryWriteTargetContains  string `json:"on_memory_write_target_contains"`
	OnMemoryWriteContentContains string `json:"on_memory_write_content_contains"`
	SearchQueryContains          string `json:"search_query_contains"`
	SearchRecordsReturnedMin     int    `json:"search_records_returned_min"`
	SyncTurnCountMin             int    `json:"sync_turn_count_min"`
}

// TestMemoryQualityCanaries replays Memory-provider lifecycle events
// through real service code paths and asserts the recording provider
// observed the contracted hook activity. New fixtures land under
// testdata/memory_quality_fixtures/ per the schema in that README.
//
// The provider double is simpleRecordingMemoryProvider from
// memory_provider_test.go (Search + OnMemoryWrite + SyncTurn +
// Initialize). Hooks driver has not yet routed through
// slackMemoryProviderManager (OnPreCompress / OnDelegation) are not
// asserted by these fixtures; they will be added when the manager
// routes them.
func TestMemoryQualityCanaries(t *testing.T) {
	fixtureDir := filepath.Join("testdata", "memory_quality_fixtures")
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}

	var paths []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "case_") || !strings.HasSuffix(name, ".json") {
			continue
		}
		paths = append(paths, filepath.Join(fixtureDir, name))
	}
	if len(paths) == 0 {
		t.Fatalf("no memory quality fixtures found in %s", fixtureDir)
	}

	for _, path := range paths {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var fixture memoryQualityFixture
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatalf("parse fixture: %v", err)
			}
			runMemoryQualityFixture(t, fixture)
		})
	}
}

func runMemoryQualityFixture(t *testing.T, fixture memoryQualityFixture) {
	t.Helper()
	if fixture.CaseID == "" {
		t.Fatalf("fixture missing case_id")
	}
	if fixture.Scenario.Pending {
		t.Logf("[%s] scenario marked pending (%s); skipping assertions", fixture.CaseID, fixture.Scenario.PendingReason)
		return
	}

	seedHits := make([]SlackRelatedMemoryRecord, 0, len(fixture.Scenario.ProviderSeedRecords))
	for _, seed := range fixture.Scenario.ProviderSeedRecords {
		seedHits = append(seedHits, SlackRelatedMemoryRecord{
			Source:     seed.Path,
			SourcePath: seed.Path,
			Content:    seed.Content,
			Kind:       seed.Kind,
			Score:      seed.Score,
		})
	}
	provider := &simpleRecordingMemoryProvider{
		name:       "canary_provider_" + fixture.CaseID,
		available:  true,
		searchHits: seedHits,
	}

	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack:           appconfig.SlackConfig{WorkspaceDir: workspaceDir},
		MemoryProviders: []SlackMemoryProvider{provider},
	})

	switch fixture.Scenario.Type {
	case "durable_write_replay":
		runMemoryDurableWriteReplay(t, fixture, service, provider)
	case "provider_search_merge":
		runMemoryProviderSearchMerge(t, fixture, service, provider)
	case "semantic_recall":
		runMemorySemanticRecall(t, fixture)
	case "sync_turn_extraction":
		runMemorySyncTurnExtraction(t, fixture, service, provider)
	case "entity_graph_resolution":
		runMemoryEntityGraphResolution(t, fixture)
	case "multimodal_ingestion":
		runMemoryMultimodalIngestion(t, fixture)
	default:
		t.Fatalf("[%s] unknown scenario.type %q", fixture.CaseID, fixture.Scenario.Type)
	}

	for _, banned := range fixture.MustNotContain {
		if banned == "" {
			continue
		}
		lower := strings.ToLower(banned)
		for _, event := range provider.writes {
			if strings.Contains(strings.ToLower(event.Content), lower) {
				t.Fatalf("[%s] provider write event content leaks banned token %q: %q", fixture.CaseID, banned, event.Content)
			}
		}
	}
}

func runMemoryEntityGraphResolution(t *testing.T, fixture memoryQualityFixture) {
	t.Helper()
	search := fixture.Scenario.Search
	if search == nil {
		t.Fatalf("[%s] entity_graph_resolution scenario missing search", fixture.CaseID)
	}
	workspaceDir := t.TempDir()
	for _, seed := range fixture.Scenario.ProviderSeedRecords {
		writeRelatedMemoryFile(t, workspaceDir, seed.Path, seed.Content)
	}
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})
	limit := search.Limit
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	result := service.SearchRelatedMemory(search.Query, SlackRelatedMemorySearchOptions{Limit: limit})
	expected := fixture.ExpectedProviderEvents
	if expected.SearchRecordsReturnedMin > 0 && len(result.Results) < expected.SearchRecordsReturnedMin {
		t.Fatalf("[%s] entity graph SearchRelatedMemory returned %d records, want >= %d; result: %#v", fixture.CaseID, len(result.Results), expected.SearchRecordsReturnedMin, result)
	}
	blobs := searchResultAnchorBlobs(result)
	joined := strings.Join(blobs, "\n---\n")
	for _, anchor := range fixture.ExpectedSearchResultAnchors {
		if !strings.Contains(joined, anchor) {
			t.Fatalf("[%s] entity graph result missing anchor %q; full blob: %q", fixture.CaseID, anchor, joined)
		}
	}
}

func runMemoryMultimodalIngestion(t *testing.T, fixture memoryQualityFixture) {
	t.Helper()
	if fixture.Scenario.AppMention == nil {
		t.Fatalf("[%s] multimodal_ingestion scenario missing app_mention", fixture.CaseID)
	}
	if fixture.Scenario.Search == nil {
		t.Fatalf("[%s] multimodal_ingestion scenario missing search", fixture.CaseID)
	}
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})
	input := fixture.Scenario.AppMention
	rich := &SlackAppMentionContext{
		ChannelID:      input.ChannelID,
		ThreadTS:       input.ThreadTS,
		UserID:         input.UserID,
		MentionText:    input.MentionText,
		RawMentionText: input.RawMentionText,
		Prompt:         input.Prompt,
		Files:          append([]SlackThreadFile(nil), input.Files...),
	}
	_ = service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelID:         input.ChannelID,
		ThreadTS:          input.ThreadTS,
		UserID:            input.UserID,
		UserName:          input.UserName,
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	limit := fixture.Scenario.Search.Limit
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	result := service.SearchRelatedMemory(fixture.Scenario.Search.Query, SlackRelatedMemorySearchOptions{Limit: limit})
	expected := fixture.ExpectedProviderEvents
	if expected.SearchRecordsReturnedMin > 0 && len(result.Results) < expected.SearchRecordsReturnedMin {
		t.Fatalf("[%s] multimodal SearchRelatedMemory returned %d records, want >= %d; result: %#v", fixture.CaseID, len(result.Results), expected.SearchRecordsReturnedMin, result)
	}
	joined := strings.Join(searchResultAnchorBlobs(result), "\n---\n")
	for _, anchor := range fixture.ExpectedSearchResultAnchors {
		if !strings.Contains(joined, anchor) {
			t.Fatalf("[%s] multimodal result missing anchor %q; full blob: %q", fixture.CaseID, anchor, joined)
		}
	}
}

func runMemoryDurableWriteReplay(t *testing.T, fixture memoryQualityFixture, service *Service, provider *simpleRecordingMemoryProvider) {
	t.Helper()
	write := fixture.Scenario.MemoryWrite
	if write == nil {
		t.Fatalf("[%s] durable_write_replay scenario missing memory_write", fixture.CaseID)
	}
	args := map[string]any{
		"path":    write.Path,
		"content": write.Content,
	}
	if write.Mode != "" {
		args["mode"] = write.Mode
	}
	if write.SessionID != "" {
		args["session_id"] = write.SessionID
	}
	response := service.executeMemoryWriteTool(context.Background(), args)
	if !response.OK {
		t.Fatalf("[%s] executeMemoryWriteTool failed: %#v", fixture.CaseID, response)
	}

	expected := fixture.ExpectedProviderEvents
	if expected.OnMemoryWriteCount > 0 && len(provider.writes) < expected.OnMemoryWriteCount {
		t.Fatalf("[%s] provider OnMemoryWrite count = %d, want >= %d", fixture.CaseID, len(provider.writes), expected.OnMemoryWriteCount)
	}
	if len(provider.writes) == 0 {
		t.Fatalf("[%s] provider did not receive any OnMemoryWrite events", fixture.CaseID)
	}
	last := provider.writes[len(provider.writes)-1]
	if expected.OnMemoryWriteTargetContains != "" {
		anchor := strings.TrimSpace(expected.OnMemoryWriteTargetContains)
		if !strings.Contains(last.Path, anchor) && !strings.Contains(last.Target, anchor) {
			t.Fatalf("[%s] provider write event target = path:%q target:%q, want substring %q", fixture.CaseID, last.Path, last.Target, anchor)
		}
	}
	if expected.OnMemoryWriteContentContains != "" {
		anchor := strings.TrimSpace(expected.OnMemoryWriteContentContains)
		if !strings.Contains(last.Content, anchor) {
			t.Fatalf("[%s] provider write event content = %q, want substring %q", fixture.CaseID, last.Content, anchor)
		}
	}
}

func runMemoryProviderSearchMerge(t *testing.T, fixture memoryQualityFixture, service *Service, provider *simpleRecordingMemoryProvider) {
	t.Helper()
	search := fixture.Scenario.Search
	if search == nil {
		t.Fatalf("[%s] provider_search_merge scenario missing search", fixture.CaseID)
	}
	limit := search.Limit
	if limit <= 0 {
		limit = 5
	}
	result := service.SearchRelatedMemory(search.Query, SlackRelatedMemorySearchOptions{Limit: limit})

	expected := fixture.ExpectedProviderEvents
	if expected.SearchQueryContains != "" {
		anchor := strings.TrimSpace(expected.SearchQueryContains)
		seen := false
		for _, req := range provider.searches {
			if strings.Contains(req.Query, anchor) {
				seen = true
				break
			}
		}
		if !seen {
			t.Fatalf("[%s] provider did not see search query containing %q; recorded: %#v", fixture.CaseID, anchor, provider.searches)
		}
	}
	if expected.SearchRecordsReturnedMin > 0 && len(result.Results) < expected.SearchRecordsReturnedMin {
		t.Fatalf("[%s] SearchRelatedMemory returned %d records, want >= %d; result: %#v", fixture.CaseID, len(result.Results), expected.SearchRecordsReturnedMin, result)
	}

	joined := strings.Join(searchResultAnchorBlobs(result), "\n")
	for _, anchor := range fixture.ExpectedSearchResultAnchors {
		if anchor == "" {
			continue
		}
		if !strings.Contains(joined, anchor) {
			t.Fatalf("[%s] SearchRelatedMemory result missing anchor %q; full blob: %q", fixture.CaseID, anchor, joined)
		}
	}
}

func runMemorySemanticRecall(t *testing.T, fixture memoryQualityFixture) {
	t.Helper()
	search := fixture.Scenario.Search
	if search == nil {
		t.Fatalf("[%s] semantic_recall scenario missing search", fixture.CaseID)
	}
	if len(fixture.Scenario.ProviderSeedRecords) == 0 {
		t.Fatalf("[%s] semantic_recall scenario missing provider_seed_records", fixture.CaseID)
	}
	workspaceDir := t.TempDir()
	indexPath := filepath.Join(workspaceDir, "semantic-memory.json")
	index := semanticMemoryIndexFile{
		Schema:    "oneesama.semantic-memory.v1",
		Dimension: 64,
	}
	for _, seed := range fixture.Scenario.ProviderSeedRecords {
		index.Documents = append(index.Documents, semanticMemoryDocument{
			ID:         seed.Path,
			Kind:       firstNonEmpty(seed.Kind, "semantic_memory"),
			Source:     seed.Path,
			SourcePath: seed.Path,
			Content:    seed.Content,
		})
	}
	raw, err := json.Marshal(index)
	if err != nil {
		t.Fatalf("[%s] marshal semantic index: %v", fixture.CaseID, err)
	}
	if err := os.WriteFile(indexPath, raw, 0o644); err != nil {
		t.Fatalf("[%s] write semantic index: %v", fixture.CaseID, err)
	}
	service := NewService(Config{Slack: appconfig.SlackConfig{
		WorkspaceDir: workspaceDir,
		Memory: appconfig.SlackMemoryConfig{
			SemanticEnabled:   true,
			SemanticIndexPath: indexPath,
		},
	}})
	limit := search.Limit
	if limit <= 0 {
		limit = 5
	}
	result := service.SearchRelatedMemory(search.Query, SlackRelatedMemorySearchOptions{Limit: limit})
	expected := fixture.ExpectedProviderEvents
	if expected.SearchRecordsReturnedMin > 0 && len(result.Results) < expected.SearchRecordsReturnedMin {
		t.Fatalf("[%s] semantic SearchRelatedMemory returned %d records, want >= %d; result: %#v", fixture.CaseID, len(result.Results), expected.SearchRecordsReturnedMin, result)
	}
	joined := strings.Join(searchResultAnchorBlobs(result), "\n")
	for _, anchor := range fixture.ExpectedSearchResultAnchors {
		if anchor == "" {
			continue
		}
		if !strings.Contains(joined, anchor) {
			t.Fatalf("[%s] semantic SearchRelatedMemory result missing anchor %q; full blob: %q", fixture.CaseID, anchor, joined)
		}
	}
}

func runMemorySyncTurnExtraction(t *testing.T, fixture memoryQualityFixture, service *Service, provider *simpleRecordingMemoryProvider) {
	t.Helper()
	turnInput := fixture.Scenario.TurnInput
	if turnInput == nil {
		t.Fatalf("[%s] sync_turn_extraction scenario missing turn_input", fixture.CaseID)
	}
	service.syncMemoryProvidersTurn(context.Background(), SlackMemoryProviderTurn{
		SessionID:        turnInput.SessionID,
		UserContent:      turnInput.UserContent,
		AssistantContent: turnInput.AssistantContent,
		Metadata: map[string]any{
			"fixture_case": fixture.CaseID,
		},
	})
	expected := fixture.ExpectedProviderEvents
	if expected.SyncTurnCountMin > 0 && len(provider.turns) < expected.SyncTurnCountMin {
		t.Fatalf("[%s] provider SyncTurn count = %d, want >= %d", fixture.CaseID, len(provider.turns), expected.SyncTurnCountMin)
	}
	if len(provider.turns) == 0 {
		t.Fatalf("[%s] provider did not receive SyncTurn", fixture.CaseID)
	}
	last := provider.turns[len(provider.turns)-1]
	if last.SessionID != turnInput.SessionID || last.UserContent != turnInput.UserContent || last.AssistantContent != turnInput.AssistantContent {
		t.Fatalf("[%s] provider turn = %#v, want fixture turn input", fixture.CaseID, last)
	}
}

func searchResultAnchorBlobs(result SlackRelatedMemorySearchResult) []string {
	out := make([]string, 0, len(result.Results))
	for _, record := range result.Results {
		out = append(out, record.Source)
		out = append(out, record.SourcePath)
		out = append(out, strings.Join(record.Reasons, " "))
		out = append(out, record.Content)
	}
	return out
}
