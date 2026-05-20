package slackagent

import (
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// Pins the Memory provider ownership and ranking matrix documented in
// notes/code-polish/memory-provider-ownership-matrix-2026-05-21.md. If this
// test fails, update both the doc and the test together.

func TestMemoryProviderNamesAndAvailability(t *testing.T) {
	cfg := appconfig.SlackMemoryConfig{Enabled: true, SemanticEnabled: true}
	cases := []struct {
		name      string
		provider  SlackMemoryProvider
		wantName  string
		available bool
	}{
		{"turn_extractor", newTurnExtractionMemoryProvider(cfg), "turn_extractor", true},
		{"entity_graph", newEntityGraphMemoryProvider(cfg), "entity_graph", true},
		{"multimodal", newMultimodalMemoryProvider(cfg), "multimodal_memory", true},
		{"semantic", newSemanticMemoryProvider(cfg), "local_semantic", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.provider.Name(); got != tc.wantName {
				t.Fatalf("Name() = %q, want %q", got, tc.wantName)
			}
			if got := tc.provider.Available(); got != tc.available {
				t.Fatalf("Available() = %v, want %v", got, tc.available)
			}
		})
	}
}

func TestMemoryProviderDisabledByFlag(t *testing.T) {
	disabled := appconfig.SlackMemoryConfig{Enabled: false, SemanticEnabled: false}
	if newTurnExtractionMemoryProvider(disabled).Available() {
		t.Fatal("turn_extractor must be unavailable when Memory.Enabled is false")
	}
	if newEntityGraphMemoryProvider(disabled).Available() {
		t.Fatal("entity_graph must be unavailable when Memory.Enabled is false")
	}
	if newMultimodalMemoryProvider(disabled).Available() {
		t.Fatal("multimodal must be unavailable when Memory.Enabled is false")
	}
	if newSemanticMemoryProvider(disabled).Available() {
		t.Fatal("semantic must be unavailable when Memory.SemanticEnabled is false")
	}
}

func TestRelatedMemoryFamilyBoostMatrix(t *testing.T) {
	cases := []struct {
		name   string
		kind   string
		tokens []string
		want   float64
	}{
		{"legacy_triage_archive_unconditional", "legacy_triage_archive", nil, 0.14},
		{"persona_memory_write_unconditional", "persona_memory_write", nil, 0.20},
		{"person_profile_owner_token", "person_profile", []string{"owner"}, 0.25},
		{"person_profile_no_token", "person_profile", []string{"unrelated"}, 0},
		{"team_action_owner_token", "team_action", []string{"owner"}, 0.18},
		{"team_decision_decide_token", "team_decision", []string{"decide"}, 0.18},
		{"team_question_question_token", "team_question", []string{"question"}, 0.16},
		{"team_fact_quota_token", "team_fact", []string{"quota"}, 0.22},
		{"team_meeting_meeting_token", "team_meeting", []string{"meeting"}, 0.22},
		{"lesson_candidate_regression_token", "lesson_candidate", []string{"regression"}, 0.16},
		{"lesson_candidate_no_token", "lesson_candidate", []string{"unrelated"}, 0},
		{"multimodal_memory_no_family_boost", "multimodal_memory", []string{"image"}, 0},
		{"semantic_memory_no_family_boost", "semantic_memory", []string{"any"}, 0},
		{"entity_graph_no_family_boost", "entity_graph", []string{"any"}, 0},
		{"memory_write_no_family_boost", "memory_write", []string{"any"}, 0},
		{"memory_file_no_family_boost", "memory_file", []string{"any"}, 0},
		{"daily_note_no_family_boost", "daily_note", []string{"any"}, 0},
		{"feedback_no_family_boost", "feedback", []string{"any"}, 0},
		{"legacy_memory_file_no_family_boost", "legacy_memory_file", []string{"any"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := relatedMemoryFamilyBoost(tc.kind, tc.tokens)
			if got != tc.want {
				t.Fatalf("relatedMemoryFamilyBoost(%q, %v) = %v, want %v", tc.kind, tc.tokens, got, tc.want)
			}
		})
	}
}

func TestRelatedMemoryLegacyToolTraceBoostMatrix(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		base    float64
		content string
		want    float64
	}{
		{"only_legacy_kind", "legacy_memory_file", 0.5, "tool calls: memory_search foo", 0},
		{"base_below_threshold", "legacy_triage_archive", 0.30, "tool calls: memory_search foo", 0},
		{"missing_tool_calls_header", "legacy_triage_archive", 0.40, "memory_search foo without header", 0},
		{"missing_memory_marker", "legacy_triage_archive", 0.40, "tool calls: arbitrary_tool foo", 0},
		{"memory_search_marker", "legacy_triage_archive", 0.40, "tool calls: memory_search context", 0.22},
		{"memory_get_marker", "legacy_triage_archive", 0.40, "tool calls: memory_get profile", 0.22},
		{"person_memory_marker", "legacy_triage_archive", 0.40, "tool calls: person_memory lookup", 0.22},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := relatedMemoryLegacyToolTraceBoost(tc.base, tc.kind, tc.content)
			if got != tc.want {
				t.Fatalf("relatedMemoryLegacyToolTraceBoost(%v, %q, %q) = %v, want %v", tc.base, tc.kind, tc.content, got, tc.want)
			}
		})
	}
}

func TestRelatedMemoryKindForPathMatrix(t *testing.T) {
	cases := []struct {
		relPath string
		want    string
	}{
		{"MEMORY.md", "memory_index"},
		{"memory/2026-05-21.md", "daily_note"},
		{"memory/persona/writes/2026-05-21/episode-abc.md", "persona_memory_write"},
		{"memory/people/peng.md", "person_profile"},
		{"memory/team/decisions/d1.md", "team_decision"},
		{"memory/team/actions/a1.md", "team_action"},
		{"memory/team/questions/q1.md", "team_question"},
		{"memory/team/facts/f1.md", "team_fact"},
		{"memory/team/meetings/m1.md", "team_meeting"},
		{"memory/lessons/candidates/l1.md", "lesson_candidate"},
		{"memory/multimodal/x.md", "multimodal_memory"},
		{"memory/feedback/r1.md", "feedback"},
		{"memory/legacy/slack-agent-d/workspace/MEMORY.md", "legacy_memory_index"},
		{"memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-20.md", "legacy_triage_archive"},
		{"memory/legacy/slack-agent-d/workspace/memory/people/peng.md", "person_profile"},
		{"memory/legacy/slack-agent-d/workspace/memory/team/decisions/d.md", "team_decision"},
		{"memory/legacy/slack-agent-d/workspace/memory/lessons/candidates/l.md", "lesson_candidate"},
		{"memory/legacy/slack-agent-d/workspace/memory/feedback/r.md", "feedback"},
		{"memory/legacy/slack-agent-d/workspace/some-other.md", "legacy_memory_file"},
		{"memory/legacy/slack-agent-d/db/channel-brain.md", "legacy_slack_db"},
		{"memory/extractions/candidates/2026-05-21/turn-abc.md", "memory_file"},
		{"memory/anything-else.md", "memory_file"},
	}
	for _, tc := range cases {
		t.Run(tc.relPath, func(t *testing.T) {
			if got := relatedMemoryKindForPath(tc.relPath); got != tc.want {
				t.Fatalf("relatedMemoryKindForPath(%q) = %q, want %q", tc.relPath, got, tc.want)
			}
		})
	}
}

// Pins the known multimodal double-index overlap: the same memory/multimodal/
// file is currently produced both by the workspace scanner (via SearchRelatedMemory)
// and by the multimodal provider's Search. This test will start failing when
// either side stops producing the duplicate, at which point update the
// ownership matrix doc to reflect the resolved overlap.
func TestMultimodalMemoryDoubleIndexOverlap(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/multimodal/2026-05-21/case.md", "Customer share file reference: codex generated screenshot. action item")

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})

	result := service.SearchRelatedMemory("codex screenshot action item", SlackRelatedMemorySearchOptions{Limit: 8})

	var multimodalHits int
	var seenWorkspaceSource, seenProviderSource bool
	for _, record := range result.Results {
		if record.Kind != "multimodal_memory" {
			continue
		}
		multimodalHits++
		switch record.Source {
		case "memory/multimodal/2026-05-21/case.md":
			seenWorkspaceSource = true
		case "multimodal_memory:memory/multimodal/2026-05-21/case.md":
			seenProviderSource = true
		}
	}
	if multimodalHits < 2 {
		t.Fatalf("multimodal_memory hits = %d, want >= 2 (pins documented workspace+provider double-index overlap); results = %#v", multimodalHits, result.Results)
	}
	if !seenWorkspaceSource || !seenProviderSource {
		t.Fatalf("expected both workspace-source (%q) and provider-source (%q) records; got workspaceSeen=%v providerSeen=%v; results=%#v",
			"memory/multimodal/2026-05-21/case.md",
			"multimodal_memory:memory/multimodal/2026-05-21/case.md",
			seenWorkspaceSource, seenProviderSource, result.Results)
	}
}
