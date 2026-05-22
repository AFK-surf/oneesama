package slackagent

import (
	"net/url"
	"strings"
	"unicode"
)

const (
	slackSharedLinkSynthesisExcerptMin = 220
	slackSharedLinkSynthesisSnippetMax = 360
)

func slackExternalLinksFromContext(value any) []SlackExternalLinkContext {
	switch typed := value.(type) {
	case []SlackExternalLinkContext:
		return typed
	case []any:
		out := make([]SlackExternalLinkContext, 0, len(typed))
		for _, item := range typed {
			if mapped, ok := mapFromAny(item); ok {
				out = append(out, SlackExternalLinkContext{
					URL:     stringFromAny(mapped["url"]),
					Title:   stringFromAny(mapped["title"]),
					Excerpt: stringFromAny(mapped["excerpt"]),
					Source:  stringFromAny(mapped["source"]),
					Error:   stringFromAny(mapped["error"]),
				})
			}
		}
		return out
	default:
		return nil
	}
}

func enrichSlackTriageActionsWithContextEvidence(actions []SlackTriageDecisionAction, channelID string, threadTS string, messages []SlackInboundMessage, contexts []SlackExternalLinkContext) []SlackTriageDecisionAction {
	if len(actions) == 0 {
		return actions
	}
	context, hasLink := firstSlackVisibleFetchedLinkEvidenceContext(contexts)
	out := make([]SlackTriageDecisionAction, 0, len(actions))
	for _, action := range actions {
		if strings.TrimSpace(action.Type) != slackActionTypeThreadReply {
			out = append(out, action)
			continue
		}
		action.ChannelID = firstNonEmpty(action.ChannelID, channelID)
		action.ThreadTS = firstNonEmpty(action.ThreadTS, firstNonEmpty(lastMessageThreadTS(messages), threadTS))
		anchors := normalizeSlackVisibleEvidenceAnchors(action.EvidenceAnchors)
		if len(anchors) == 0 {
			anchors = slackVisibleThreadEvidenceAnchors(action.ChannelID, action.ThreadTS, joinSlackMessageTexts(messages))
		}
		if hasLink && !slackVisibleReplyHasAllowListEvidenceAnchor(anchors, action.Message) {
			anchors = normalizeSlackVisibleEvidenceAnchors(append(anchors, slackVisibleFetchedLinkEvidenceAnchor(context)...))
		}
		action.EvidenceAnchors = anchors
		out = append(out, action)
	}
	return out
}

func firstSlackVisibleFetchedLinkEvidenceContext(contexts []SlackExternalLinkContext) (SlackExternalLinkContext, bool) {
	for _, context := range contexts {
		if strings.TrimSpace(context.URL) == "" || strings.TrimSpace(context.Error) != "" {
			continue
		}
		if slackExternalLinkContextLooksBoilerplate(context) {
			continue
		}
		if strings.TrimSpace(context.Title) == "" && strings.TrimSpace(context.Excerpt) == "" {
			continue
		}
		return context, true
	}
	return SlackExternalLinkContext{}, false
}

func slackTriageSharedLinkSynthesisAction(channelID string, threadTS string, messages []SlackInboundMessage, contexts []SlackExternalLinkContext, workspacePolicy string) (SlackTriageDecisionAction, bool) {
	if len(contexts) == 0 || !slackMessagesHaveFetchableExternalLinks(messages) {
		return SlackTriageDecisionAction{}, false
	}
	messageText := joinSlackMessageTexts(messages)
	if !workspacePolicyEnablesSharedLinkSynthesis(workspacePolicy) && !slackMessageExplicitlyRequestsLinkSynthesis(messageText) {
		return SlackTriageDecisionAction{}, false
	}
	context, ok := firstSynthesisEligibleExternalLink(contexts)
	if !ok {
		return SlackTriageDecisionAction{}, false
	}
	thread := firstNonEmpty(lastMessageThreadTS(messages), threadTS)
	if thread == "" {
		thread = firstNonEmpty(contextThreadTS(messages), "channel-root")
	}
	message := buildSharedLinkSynthesisReply(context, messageText)
	if strings.TrimSpace(message) == "" {
		return SlackTriageDecisionAction{}, false
	}
	anchors := append(
		slackVisibleThreadEvidenceAnchors(channelID, thread, messageText),
		slackVisibleFetchedLinkEvidenceAnchor(context)...,
	)
	return SlackTriageDecisionAction{
		Type:                 "post_thread_reply",
		Title:                "补充链接初步看法",
		Message:              message,
		ChannelID:            channelID,
		ThreadTS:             thread,
		Confidence:           0.66,
		Reason:               "A substantive shared link is synthesis-eligible under the workspace policy or explicit thread request.",
		EvidenceAnchors:      normalizeSlackVisibleEvidenceAnchors(anchors),
		RequiresConfirmation: false,
	}, true
}

func workspacePolicyEnablesSharedLinkSynthesis(policy string) bool {
	normalized := strings.ToLower(strings.TrimSpace(policy))
	if normalized == "" {
		return false
	}
	for _, marker := range []string{
		"source-backed",
		"link",
		"article",
		"pdf",
		"synthesis",
		"product-adjacent",
		"链接",
		"文章",
		"评价",
		"点评",
		"读后感",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func slackMessageExplicitlyRequestsLinkSynthesis(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	if !strings.Contains(normalized, "http://") && !strings.Contains(normalized, "https://") {
		return false
	}
	for _, marker := range []string{
		"what do you think",
		"thoughts",
		"summarize",
		"summary",
		"review",
		"看",
		"看看",
		"评价",
		"点评",
		"总结",
		"读一下",
		"怎么看",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func firstSynthesisEligibleExternalLink(contexts []SlackExternalLinkContext) (SlackExternalLinkContext, bool) {
	for _, context := range contexts {
		title := strings.TrimSpace(context.Title)
		excerpt := strings.TrimSpace(context.Excerpt)
		if strings.TrimSpace(context.Error) != "" || strings.TrimSpace(context.URL) == "" {
			continue
		}
		if looksLikeLowSignalSocialStatusURL(context.URL) {
			continue
		}
		if slackExternalLinkContextLooksBoilerplate(context) {
			continue
		}
		if title == "" && len([]rune(excerpt)) < slackSharedLinkSynthesisExcerptMin {
			continue
		}
		if len([]rune(excerpt)) < slackSharedLinkSynthesisExcerptMin && !looksLikeArticleOrDocumentURL(context.URL) {
			continue
		}
		return context, true
	}
	return SlackExternalLinkContext{}, false
}

func slackExternalLinkContextLooksBoilerplate(context SlackExternalLinkContext) bool {
	excerpt := strings.ToLower(strings.Join(strings.Fields(context.Excerpt), " "))
	if excerpt == "" {
		return false
	}
	for _, marker := range []string{
		"github copilot write better code with ai",
		"github spark build and deploy intelligent apps",
		"github models manage and compare prompts",
		"mcp registry new integrate external tools",
		"automate any workflow packages host and manage packages",
		"sign in to github",
	} {
		if strings.Contains(excerpt, marker) {
			return true
		}
	}
	return false
}

func looksLikeLowSignalSocialStatusURL(rawURL string) bool {
	parsed, err := url.Parse(strings.Trim(rawURL, "<>|.,，。)）]】"))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "x.com" || strings.HasSuffix(host, ".x.com") || host == "twitter.com" || strings.HasSuffix(host, ".twitter.com")
}

func looksLikeArticleOrDocumentURL(rawURL string) bool {
	parsed, err := url.Parse(strings.Trim(rawURL, "<>|.,，。)）]】"))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	path := strings.ToLower(parsed.Path)
	if strings.HasSuffix(path, ".pdf") || strings.Contains(path, "/blob/") || strings.Contains(path, "/articles/") || strings.Contains(path, "/blog/") {
		return true
	}
	for _, marker := range []string{"github.com", "arxiv.org", "medium.com", "substack.com", "docs.", "blog."} {
		if strings.Contains(host, marker) {
			return true
		}
	}
	return false
}

func buildSharedLinkSynthesisReply(context SlackExternalLinkContext, messageText string) string {
	title := strings.TrimSpace(context.Title)
	excerpt := trimSharedLinkSnippet(context.Excerpt)
	zh := containsCJK(messageText) || containsCJK(title) || containsCJK(excerpt)
	if zh {
		subject := "这个链接"
		if title != "" {
			subject = "《" + title + "》"
		}
		if rendered, err := renderTriageReplyTemplate("link_synthesis", "zh", triageReplyTemplateData{
			Title:       title,
			Subject:     subject,
			Excerpt:     excerpt,
			URL:         strings.TrimSpace(context.URL),
			MessageText: messageText,
			Language:    "zh",
		}); err == nil && strings.TrimSpace(rendered) != "" {
			return rendered
		}
		return ""
	}
	subject := "this link"
	if title != "" {
		subject = "\"" + title + "\""
	}
	if rendered, err := renderTriageReplyTemplate("link_synthesis", "en", triageReplyTemplateData{
		Title:       title,
		Subject:     subject,
		Excerpt:     excerpt,
		URL:         strings.TrimSpace(context.URL),
		MessageText: messageText,
		Language:    "en",
	}); err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return ""
}

func trimSharedLinkSnippet(value string) string {
	text := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if text == "" {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= slackSharedLinkSynthesisSnippetMax {
		return text
	}
	return string(runes[:slackSharedLinkSynthesisSnippetMax]) + "..."
}

func containsCJK(value string) bool {
	for _, r := range value {
		if unicode.Is(unicode.Han, r) || unicode.In(r, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
			return true
		}
	}
	return false
}

func contextThreadTS(messages []SlackInboundMessage) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].TS != "" {
			return messages[index].TS
		}
	}
	return ""
}
