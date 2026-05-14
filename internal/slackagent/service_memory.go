package slackagent

import "strings"

func (s *Service) MemorySummary() SlackMemorySummary {
	if s == nil || s.localMemory == nil {
		return SlackMemorySummary{}
	}
	return s.localMemory.Summary()
}

func (s *Service) SearchLocalMemory(query string, limit int) []SlackMemoryResult {
	if s == nil || s.localMemory == nil {
		return nil
	}
	return s.localMemory.Search(query, limit)
}

func (s *Service) buildLocalSlackMemoryContext(query string, limit int) SlackMemoryAgentContext {
	if s == nil || s.localMemory == nil {
		return SlackMemoryAgentContext{Enabled: false}
	}
	return s.localMemory.BuildAgentContext(query, limit)
}

func slackTriageMemoryFromLocal(results []SlackMemoryResult, fallbackDigest string) []SlackTriageMemoryEntry {
	if len(results) == 0 {
		return []SlackTriageMemoryEntry{{Source: "slack-activity", Content: strings.TrimSpace(fallbackDigest)}}
	}
	entries := make([]SlackTriageMemoryEntry, 0, len(results))
	for _, result := range results {
		entries = append(entries, SlackTriageMemoryEntry{
			Kind:    result.Kind,
			Source:  result.Source,
			Content: result.Content,
		})
	}
	return entries
}
