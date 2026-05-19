package slackagent

import (
	"context"
	"fmt"
	"strings"
)

const appMentionMemoryWriteSummaryLimit = 1200

func (s *Service) collectAppMentionMemoryWriteEvidence(ctx context.Context, mention *SlackAppMentionContext) (SlackAppMentionToolEvidence, bool) {
	if s == nil || mention == nil || !appMentionRequestsMemoryWrite(mention) {
		return SlackAppMentionToolEvidence{}, false
	}
	path := appMentionMemoryWritePath(mention)
	content := renderAppMentionMemoryWrite(mention)
	args := map[string]any{
		"path":    path,
		"content": content,
		"mode":    "write",
	}
	response, err := s.ExecuteSlackTool(ctx, SlackToolCallRequest{
		Tool: "memory_write",
		Role: slackAPIRoleAssistant,
		Args: args,
	})
	evidence := SlackAppMentionToolEvidence{
		Tool: "memory_write",
		Args: args,
		OK:   response.OK && err == nil,
	}
	if err != nil {
		evidence.Error = err.Error()
		return evidence, true
	}
	if !response.OK {
		evidence.Error = firstNonEmpty(response.Error, response.Text, "tool_failed")
		return evidence, true
	}
	evidence.Summary = fmt.Sprintf("wrote explicit Slack memory to %s", path)
	return evidence, true
}

func appMentionRequestsMemoryWrite(mention *SlackAppMentionContext) bool {
	text := strings.ToLower(strings.TrimSpace(strings.Join([]string{
		stripSlackBotMentions(mention.MentionText),
		stripSlackBotMentions(mention.RawMentionText),
	}, " ")))
	if text == "" {
		text = strings.ToLower(strings.TrimSpace(stripSlackBotMentions(mention.Transcript)))
	}
	for _, marker := range []string{
		"记一下", "记下来", "记住", "帮我记", "帮忙记", "记录一下", "存一下", "保存一下",
		"写进 memory", "写到 memory", "写入 memory", "加入记忆", "存到记忆",
		"remember this", "remember that", "note this", "note that", "save this", "save that",
		"add to memory", "write to memory",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func appMentionMemoryWritePath(mention *SlackAppMentionContext) string {
	channel := sanitizePersonaMemoryPathComponent(firstNonEmpty(mention.ChannelID, "channel"))
	thread := sanitizePersonaMemoryPathComponent(firstNonEmpty(mention.ThreadTS, "thread"))
	if channel == "" {
		channel = "channel"
	}
	if thread == "" {
		thread = "thread"
	}
	return "memory/team/facts/slack-app-mentions/" + channel + "-" + thread + ".md"
}

func renderAppMentionMemoryWrite(mention *SlackAppMentionContext) string {
	var b strings.Builder
	b.WriteString("# Slack explicit memory\n\n")
	legacySlackWriteBullet(&b, "Captured at", nowRFC3339())
	legacySlackWriteBullet(&b, "Channel", mention.ChannelID)
	legacySlackWriteBullet(&b, "Thread", mention.ThreadTS)
	legacySlackWriteBullet(&b, "User", mention.UserID)
	legacySlackWriteBullet(&b, "Thread permalink", mention.ThreadPermalink)
	request := strings.TrimSpace(firstNonEmpty(stripSlackBotMentions(mention.MentionText), stripSlackBotMentions(mention.RawMentionText)))
	legacySlackWriteBullet(&b, "Request", request)
	b.WriteString("\n## Source Thread\n\n")
	b.WriteString(truncateSlackContextText(firstNonEmpty(mention.Transcript, request), appMentionMemoryWriteSummaryLimit))
	b.WriteString("\n")
	if len(mention.ExternalLinks) > 0 {
		b.WriteString("\n## External Links\n\n")
		b.WriteString(formatSlackExternalLinkContexts(mention.ExternalLinks))
		b.WriteString("\n")
	}
	if len(mention.LinkedSlackThreads) > 0 {
		b.WriteString("\n## Linked Slack Threads\n\n")
		b.WriteString(formatSlackLinkedThreadContexts(mention.LinkedSlackThreads))
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String()) + "\n"
}
