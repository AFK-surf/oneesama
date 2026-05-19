package slackagent

import (
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestEntityGraphMemoryProviderResolvesRelationshipChain(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/cumora-entity-graph.md", strings.Join([]string{
		"Cumora contact is yetone.",
		"yetone aliases: 大yetone, @yetone.",
		"yetone organization is Isoform.",
		"Cumora is not related to Alma product line.",
	}, "\n"))
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})

	result := service.SearchRelatedMemory("Cumora 的 contact 是谁，跟 Alma 有没有关系？", SlackRelatedMemorySearchOptions{Limit: 5})

	graph := firstRelatedMemoryKind(result.Results, "entity_graph")
	if graph == nil {
		t.Fatalf("SearchRelatedMemory = %#v, want entity_graph evidence", result.Results)
	}
	for _, want := range []string{
		"Cumora contact is yetone",
		"yetone organization is Isoform",
		"Cumora is not related to Alma",
		"memory_provider:entity_graph",
	} {
		blob := graph.Content + "\n" + strings.Join(graph.Reasons, "\n")
		if !strings.Contains(blob, want) {
			t.Fatalf("entity graph evidence missing %q:\n%#v", want, graph)
		}
	}
}

func TestEntityGraphMemoryProviderResolvesAliases(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/cumora-entity-graph.md", strings.Join([]string{
		"Cumora contact is yetone.",
		"yetone aliases: 大yetone, @yetone.",
		"yetone organization is Isoform.",
	}, "\n"))
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})

	result := service.SearchRelatedMemory("@yetone 跟 Cumora 是什么关系？", SlackRelatedMemorySearchOptions{Limit: 5})

	graph := firstRelatedMemoryKind(result.Results, "entity_graph")
	if graph == nil {
		t.Fatalf("SearchRelatedMemory = %#v, want entity_graph evidence for alias query", result.Results)
	}
	if !strings.Contains(graph.Content, "Cumora contact is yetone") || !strings.Contains(graph.Content, "yetone organization is Isoform") {
		t.Fatalf("alias graph evidence = %#v, want contact and organization chain", graph)
	}
}
