package slackagent

import (
	"fmt"
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

func slackTriageSharedLinkSynthesisAction(channelID string, threadTS string, messages []SlackInboundMessage, contexts []SlackExternalLinkContext) (SlackTriageDecisionAction, bool) {
	if len(contexts) == 0 || !slackMessagesHaveFetchableExternalLinks(messages) {
		return SlackTriageDecisionAction{}, false
	}
	messageText := joinSlackMessageTexts(messages)
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
	return SlackTriageDecisionAction{
		Type:                 "post_thread_reply",
		Title:                "补充链接初步看法",
		Message:              message,
		ChannelID:            channelID,
		ThreadTS:             thread,
		Confidence:           0.66,
		Reason:               "A substantive shared article/PDF link is a weak invitation; a lightweight synthesis prevents the link from going cold.",
		RequiresConfirmation: false,
	}, true
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
		if excerpt != "" {
			return fmt.Sprintf("我粗读了一下%s。核心信息是：%s\n\n我的初步判断：这类内容适合作为讨论引子；如果继续聊，最好把它和当前产品/技术判断具体连起来。", subject, excerpt)
		}
		return fmt.Sprintf("我粗读了一下%s。我的初步判断：它像是一篇值得展开讨论的材料，可以先从它对当前产品/技术判断的影响聊起。", subject)
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
	if excerpt != "" {
		return fmt.Sprintf("I skimmed %s. Core signal: %s\n\nMy initial take: this is worth using as a discussion prompt; the useful next step is connecting it back to the current product or technical decision.", subject, excerpt)
	}
	return fmt.Sprintf("I skimmed %s. My initial take: it looks worth discussing, especially if we connect it back to the current product or technical decision.", subject)
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
