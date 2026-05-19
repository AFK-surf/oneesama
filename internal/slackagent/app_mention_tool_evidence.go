package slackagent

import (
	"context"
	"strings"
	"unicode"
)

const appMentionFreshSearchSummaryLimit = 1800

func (s *Service) collectAppMentionToolEvidence(ctx context.Context, mention *SlackAppMentionContext, related SlackRelatedMemorySearchResult) []SlackAppMentionToolEvidence {
	if s == nil || mention == nil {
		return nil
	}
	var out []SlackAppMentionToolEvidence
	if evidence, ok := s.collectAppMentionMemoryWriteEvidence(ctx, mention); ok {
		out = append(out, evidence)
	}
	if evidence, ok := collectAppMentionMediaEvidence(mention); ok {
		out = append(out, evidence)
	}
	query := appMentionFreshSearchQuery(mention)
	if !shouldSearchFreshAppMentionEvidence(mention, related, query) {
		return out
	}
	args := map[string]any{"query": query}
	response, err := s.ExecuteSlackTool(ctx, SlackToolCallRequest{
		Tool: "exa_search",
		Role: slackAPIRoleAssistant,
		Args: args,
	})
	evidence := SlackAppMentionToolEvidence{
		Tool: "exa_search",
		Args: args,
		OK:   response.OK && err == nil,
	}
	if err != nil {
		evidence.Error = err.Error()
		return append(out, evidence)
	}
	if !response.OK {
		evidence.Error = firstNonEmpty(response.Error, response.Text, "tool_failed")
		evidence.Summary = slackToolEvidenceSummary(response)
		return append(out, evidence)
	}
	evidence.Summary = slackToolEvidenceSummary(response)
	evidence.Text = response.Text
	return append(out, evidence)
}

func shouldSearchFreshAppMentionEvidence(mention *SlackAppMentionContext, related SlackRelatedMemorySearchResult, query string) bool {
	if mention == nil || strings.TrimSpace(query) == "" {
		return false
	}
	if mention.ContainsMeetURL || len(mention.ExternalLinks) > 0 || len(mention.LinkedSlackThreads) > 0 {
		return false
	}
	if len(related.Results) > 0 && !related.NoRelevantMemory {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(mention.MentionText))
	if text == "" {
		text = strings.ToLower(strings.TrimSpace(mention.Transcript))
	}
	for _, marker := range []string{
		"是什么", "是谁", "什么是", "查一下", "搜一下", "搜索", "了解一下", "怎么看",
		"what is", "who is", "search", "look up", "tell me about",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	if strings.ContainsAny(text, "?？") && containsFreshEntityToken(query) {
		return true
	}
	return false
}

func appMentionFreshSearchQuery(mention *SlackAppMentionContext) string {
	if mention == nil {
		return ""
	}
	query := strings.TrimSpace(stripSlackBotMentions(mention.MentionText))
	if query == "" {
		query = strings.TrimSpace(stripSlackBotMentions(mention.RawMentionText))
	}
	if query == "" {
		query = strings.TrimSpace(mention.Transcript)
	}
	query = strings.Join(strings.Fields(query), " ")
	return truncateSlackContextText(query, 220)
}

func containsFreshEntityToken(query string) bool {
	for _, field := range strings.Fields(query) {
		token := strings.Trim(field, " \t\r\n.,;:!?？!()[]{}<>\"'`“”‘’")
		if len([]rune(token)) < 3 {
			continue
		}
		hasLetter := false
		hasUpper := false
		for _, r := range token {
			if unicode.IsLetter(r) {
				hasLetter = true
			}
			if unicode.IsUpper(r) {
				hasUpper = true
			}
		}
		if hasLetter && (hasUpper || strings.ContainsAny(token, "-_/")) {
			return true
		}
	}
	return false
}

func slackToolEvidenceSummary(response SlackToolCallResponse) string {
	if response.Text != "" {
		return truncateSlackContextText(response.Text, appMentionFreshSearchSummaryLimit)
	}
	if resultMap, ok := mapFromAny(response.Result); ok {
		for _, key := range []string{"excerpt", "content", "text", "summary"} {
			if value := stringFromAny(resultMap[key]); value != "" {
				return truncateSlackContextText(value, appMentionFreshSearchSummaryLimit)
			}
		}
	}
	if response.Error != "" {
		return truncateSlackContextText(response.Error, 500)
	}
	return ""
}
