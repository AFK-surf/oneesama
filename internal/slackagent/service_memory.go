package slackagent

import (
	"context"
	"strings"
)

func (s *Service) MemorySummary() SlackMemorySummary {
	if s == nil {
		return SlackMemorySummary{}
	}
	summary := SlackMemorySummary{}
	if s.localMemory != nil {
		summary = s.localMemory.Summary()
	}
	if strings.TrimSpace(s.workspaceDir) != "" {
		summary.WorkspaceRootDir = s.workspaceDir
		summary.WorkspaceFileCount = len(listDirectWorkspaceMemoryFiles(s.workspaceDir))
		summary.WorkspaceTriageContexts = len(workspaceTriageContextsForMemory(s.workspaceDir))
	}
	if s.feedback != nil {
		count, err := s.feedback.CountEntries(context.Background())
		if err == nil {
			summary.FeedbackEntries = count
		}
	}
	if s.memoryProviders != nil {
		summary.Providers = s.memoryProviders.Status()
	}
	summary.Enabled = summary.Enabled || summary.WorkspaceFileCount > 0 || summary.WorkspaceTriageContexts > 0 || summary.FeedbackEntries > 0 || memorySummaryHasAvailableProvider(summary.Providers)
	return summary
}

func memorySummaryHasAvailableProvider(providers []SlackMemoryProviderStatus) bool {
	for _, provider := range providers {
		if provider.Available && provider.Initialized {
			return true
		}
	}
	return false
}

func (s *Service) syncMemoryProvidersTurn(ctx context.Context, turn SlackMemoryProviderTurn) {
	if s == nil || s.memoryProviders == nil {
		return
	}
	turn.UserContent = truncateSlackContextText(strings.TrimSpace(turn.UserContent), slackMemoryProviderTurnBudgetChars)
	turn.AssistantContent = truncateSlackContextText(strings.TrimSpace(turn.AssistantContent), slackMemoryProviderTurnBudgetChars)
	if turn.UserContent == "" && turn.AssistantContent == "" {
		return
	}
	if turn.Metadata == nil {
		turn.Metadata = map[string]any{}
	}
	s.memoryProviders.SyncTurn(ctx, turn)
}

func (s *Service) SearchLocalMemory(query string, limit int) []SlackMemoryResult {
	if s == nil {
		return nil
	}
	keywords := memoryKeywords(query)
	if len(keywords) == 0 {
		return nil
	}
	if limit <= 0 {
		limit = 8
	}
	var results []SlackMemoryResult
	if s.localMemory != nil {
		results = append(results, s.localMemory.Search(query, limit)...)
	}
	if s.feedback != nil {
		results = append(results, s.feedback.SearchResults(context.Background(), keywords, limit)...)
	}
	results = append(results, workspaceMemoryFileSearchResults(s.workspaceDir, keywords, limit)...)
	results = append(results, workspaceTriageMemoryResults(s.workspaceDir, keywords, limit)...)
	results = dedupeMemoryResults(results)
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func (s *Service) buildLocalSlackMemoryContext(query string, limit int) SlackMemoryAgentContext {
	if s == nil {
		return SlackMemoryAgentContext{Enabled: false}
	}
	results := s.SearchLocalMemory(query, limit)
	summary := s.MemorySummary()
	enabled := (s.localMemory != nil && s.localMemory.enabled) || summary.WorkspaceFileCount > 0 || summary.WorkspaceTriageContexts > 0 || summary.FeedbackEntries > 0
	recentFeedback := ""
	if s.feedback != nil {
		recentFeedback = s.feedback.RecentMarkdown(context.Background(), 20)
	}
	return SlackMemoryAgentContext{
		Enabled:        enabled,
		Provenance:     "Local private Slack Agent D memory seed plus live workspace memory projections. Content stays on this machine and is not committed.",
		Query:          strings.TrimSpace(query),
		ResultCount:    len(results),
		Results:        results,
		RecentFeedback: recentFeedback,
	}
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
