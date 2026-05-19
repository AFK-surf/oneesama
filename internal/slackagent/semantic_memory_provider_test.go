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

func TestSemanticMemoryProviderAddsHybridRelatedMemory(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	indexPath := filepath.Join(workspaceDir, "semantic-memory.json")
	index := semanticMemoryIndexFile{
		Schema:    "oneesama.semantic-memory.v1",
		Dimension: 64,
		Documents: []semanticMemoryDocument{
			{
				ID:      "case-study-videos",
				Kind:    "semantic_memory",
				Source:  "semantic://case-study-videos",
				Title:   "Case study videos",
				Content: "Jc recorded case study videos for the launch review and expects Bridge to recall that recording evidence.",
			},
			{
				ID:      "unrelated",
				Kind:    "semantic_memory",
				Source:  "semantic://unrelated",
				Content: "Lunch menu planning and office snacks.",
			},
		},
	}
	raw, err := json.Marshal(index)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(indexPath, raw, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	service := NewService(Config{Slack: appconfig.SlackConfig{
		WorkspaceDir: workspaceDir,
		Memory: appconfig.SlackMemoryConfig{
			SemanticEnabled:   true,
			SemanticIndexPath: indexPath,
		},
	}})

	result := service.SearchRelatedMemory("did jc record case study video evidence?", SlackRelatedMemorySearchOptions{Limit: 3})
	if len(result.Results) == 0 {
		t.Fatalf("SearchRelatedMemory = %#v, want semantic result", result)
	}
	got := result.Results[0]
	if got.Source != "semantic://case-study-videos" || !stringSliceContains(got.Reasons, "semantic_vector_match") || !stringSliceContains(got.Reasons, "memory_provider:local_semantic") {
		t.Fatalf("top result = %#v, want semantic case-study provider result", got)
	}
}

func TestSemanticMemoryProviderMirrorsMemoryWriteIntoSearch(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Slack: appconfig.SlackConfig{
		WorkspaceDir: t.TempDir(),
		Memory: appconfig.SlackMemoryConfig{
			SemanticEnabled: true,
		},
	}})
	write := service.executeMemoryWriteTool(context.Background(), map[string]any{
		"path":    "memory/team/cumora.md",
		"content": "Cumora relates to yetone and Isoform follow-up context.",
	})
	if !write.OK {
		t.Fatalf("memory_write = %#v, want ok", write)
	}

	result := service.SearchRelatedMemory("what is the yetone isoform cumora context?", SlackRelatedMemorySearchOptions{Limit: 3})
	var found bool
	for _, record := range result.Results {
		if record.Source == "memory/team/cumora.md" && strings.Contains(record.Content, "Cumora relates") && stringSliceContains(record.Reasons, "memory_provider:local_semantic") {
			found = true
		}
	}
	if !found {
		t.Fatalf("SearchRelatedMemory = %#v, want mirrored semantic memory_write record", result.Results)
	}
}
