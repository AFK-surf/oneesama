package slackagent

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

const appMentionRelatedMemorySupplementLimit = 1600

func (s *Service) searchAppMentionRelatedMemoryContext(ctx context.Context, mention *SlackAppMentionContext, channelName, userName string, limit int) SlackRelatedMemorySearchResult {
	if ctx == nil {
		ctx = context.Background()
	}
	baseQuery := appMentionBaseRelatedMemoryQuery(mention, channelName, userName)
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	combined := s.SearchRelatedMemoryContext(ctx, baseQuery, SlackRelatedMemorySearchOptions{Limit: limit})
	queries := []string{baseQuery}
	for _, query := range appMentionSupplementalRelatedMemoryQueries(mention) {
		queries = append(queries, query)
		next := s.SearchRelatedMemoryContext(ctx, query, SlackRelatedMemorySearchOptions{Limit: limit})
		combined.Results = append(combined.Results, tagAppMentionSupplementalRelatedMemory(next.Results)...)
	}
	combined.Query = strings.TrimSpace(strings.Join(compactUniqueStrings(queries), "\n\n"))
	combined.Results = dedupeRelatedMemoryRecords(combined.Results)
	sort.SliceStable(combined.Results, func(i, j int) bool {
		if combined.Results[i].Score == combined.Results[j].Score {
			return combined.Results[i].Source < combined.Results[j].Source
		}
		return combined.Results[i].Score > combined.Results[j].Score
	})
	if len(combined.Results) > limit {
		combined.Results = combined.Results[:limit]
	}
	if len(combined.Results) == 0 {
		combined.Status = "no_relevant_memory"
		combined.NoRelevantMemory = true
	} else {
		combined.Status = "ok"
		combined.NoRelevantMemory = false
	}
	return combined
}

func appMentionBaseRelatedMemoryQuery(mention *SlackAppMentionContext, channelName, userName string) string {
	if mention == nil {
		return strings.TrimSpace(strings.Join([]string{channelName, userName}, " "))
	}
	return strings.TrimSpace(strings.Join([]string{
		mention.MentionText,
		mention.Transcript,
		channelName,
		userName,
	}, " "))
}

func appMentionSupplementalRelatedMemoryQueries(mention *SlackAppMentionContext) []string {
	if mention == nil {
		return nil
	}
	var queries []string
	for _, link := range mention.ExternalLinks {
		parts := []string{link.Title, link.Excerpt}
		if strings.TrimSpace(link.Error) == "" {
			parts = append(parts, link.URL)
		}
		if query := truncateSlackContextText(strings.TrimSpace(strings.Join(parts, "\n")), appMentionRelatedMemorySupplementLimit); query != "" {
			queries = append(queries, "external link context:\n"+query)
		}
	}
	for _, thread := range mention.LinkedSlackThreads {
		parts := []string{
			fmt.Sprintf("linked Slack thread %s %s", thread.ChannelID, thread.ThreadTS),
			thread.Transcript,
		}
		for _, file := range thread.CanvasFiles {
			parts = append(parts, file.Title, file.Name, file.Permalink)
		}
		if query := truncateSlackContextText(strings.TrimSpace(strings.Join(parts, "\n")), appMentionRelatedMemorySupplementLimit); query != "" {
			queries = append(queries, "linked Slack thread context:\n"+query)
		}
	}
	return compactUniqueStrings(queries)
}

func tagAppMentionSupplementalRelatedMemory(records []SlackRelatedMemoryRecord) []SlackRelatedMemoryRecord {
	out := make([]SlackRelatedMemoryRecord, 0, len(records))
	for _, record := range records {
		record.Reasons = append(record.Reasons, "app_mention_supplemental_context")
		out = append(out, record)
	}
	return out
}
