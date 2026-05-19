package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type slackRepliesResponse struct {
	OK       bool           `json:"ok"`
	Error    string         `json:"error,omitempty"`
	Messages []SlackMessage `json:"messages,omitempty"`
}

var slackThreadFetchAPIBaseURL = defaultSlackAPIBaseURL

const maxLinkedSlackThreadContexts = 2

type slackLinkedThreadRef struct {
	URL       string
	ChannelID string
	ThreadTS  string
}

func (s *Service) buildSlackAppMentionContext(ctx context.Context, workspaceID string, event SlackEventPayload) *SlackAppMentionContext {
	messages, source, ok, fetchErr := s.fetchSlackMentionThreadMessages(ctx, event)
	enriched := event
	if len(messages) > 0 {
		enriched.Replies = messages
	}
	contextMessages := threadMessagesFromEvent(enriched)
	richContext := buildSlackAppMentionContext(enriched)
	richContext.ExternalLinks = fetchSlackExternalLinkContexts(ctx, slackInboundMessagesFromThreadMessages(richContext.ChannelID, contextMessages))
	richContext.LinkedSlackThreads = s.fetchLinkedSlackThreadContexts(ctx, richContext.ChannelID, richContext.ThreadTS, contextMessages, richContext.BotUserID)
	richContext.CanvasFiles = mergeSlackThreadFiles(richContext.CanvasFiles, linkedSlackThreadCanvasFiles(richContext.LinkedSlackThreads))
	if len(richContext.ExternalLinks) > 0 || len(richContext.LinkedSlackThreads) > 0 {
		richContext.Prompt = buildSlackAssistantThreadMessage(richContext)
		richContext.Prompt = appendSlackLinkedThreadPromptContext(richContext.Prompt, richContext.LinkedSlackThreads)
	}
	richContext.Source = source
	richContext.FetchOK = ok
	richContext.FetchError = fetchErr
	if s.cognition != nil {
		ledger, _ := s.cognition.GetThreadLedger(ctx, firstNonEmpty(workspaceID, "workspace"), richContext.ChannelID, richContext.ThreadTS)
		brain, _ := s.cognition.GetChannelBrain(ctx, firstNonEmpty(workspaceID, "workspace"), richContext.ChannelID)
		richContext.Prompt = buildSlackAssistantMessage(
			richContext.ChannelID,
			richContext.ThreadTS,
			richContext.ThreadPermalink,
			richContext.UserID,
			richContext.MentionText,
			nil,
			richContext.Transcript,
			richContext.MeetingContext,
			richContext.BotUserID,
			richContext.ParentInfo,
			ledger,
			brain,
			nil,
		)
		richContext.Prompt = appendSlackExternalLinkPromptContext(richContext.Prompt, richContext.ExternalLinks)
		richContext.Prompt = appendSlackLinkedThreadPromptContext(richContext.Prompt, richContext.LinkedSlackThreads)
	}
	return richContext
}

func slackInboundMessagesFromThreadMessages(channelID string, messages []SlackMessage) []SlackInboundMessage {
	out := make([]SlackInboundMessage, 0, len(messages))
	for _, message := range messages {
		out = append(out, SlackInboundMessage{
			ChannelID: firstNonEmpty(message.Channel, channelID),
			UserID:    firstNonEmpty(message.UserID, message.UserIDCamel, message.User),
			User:      message.User,
			BotID:     message.BotID,
			Subtype:   message.Subtype,
			Text:      message.Text,
			TS:        firstNonEmpty(message.TS, message.Timestamp, message.EventTS),
			EventTS:   message.EventTS,
			ThreadTS:  message.ThreadTS,
			Files:     message.Files,
		})
	}
	return normalizeSlackInboundMessages(out)
}

func appendSlackExternalLinkPromptContext(prompt string, contexts []SlackExternalLinkContext) string {
	if len(contexts) == 0 {
		return prompt
	}
	section := strings.TrimSpace(formatSlackExternalLinkContexts(contexts))
	if section == "" {
		return prompt
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "Fetched external link context:\n" + section
	}
	return prompt + "\n\n---\nFetched external link context:\n" + section
}

func appendSlackLinkedThreadPromptContext(prompt string, contexts []SlackLinkedThreadContext) string {
	section := formatSlackLinkedThreadContexts(contexts)
	if strings.TrimSpace(section) == "" {
		return prompt
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "Linked Slack thread context:\n" + section
	}
	return prompt + "\n\n---\nLinked Slack thread context:\n" + section
}

func formatSlackLinkedThreadContexts(contexts []SlackLinkedThreadContext) string {
	var lines []string
	for index, context := range contexts {
		if strings.TrimSpace(context.URL) == "" && strings.TrimSpace(context.ThreadTS) == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("%d. %s", index+1, firstNonEmpty(context.URL, context.ChannelID+":"+context.ThreadTS)))
		if context.ChannelID != "" || context.ThreadTS != "" {
			lines = append(lines, fmt.Sprintf("   channel: %s thread_ts: %s", context.ChannelID, context.ThreadTS))
		}
		if context.FetchError != "" {
			lines = append(lines, "   fetch_error: "+context.FetchError)
			continue
		}
		for _, file := range context.CanvasFiles {
			lines = append(lines, "   "+formatSlackFileLine(file))
		}
		if context.Transcript != "" {
			lines = append(lines, "   transcript:")
			for _, line := range strings.Split(context.Transcript, "\n") {
				if strings.TrimSpace(line) != "" {
					lines = append(lines, "     "+line)
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (s *Service) fetchSlackMentionThreadMessages(ctx context.Context, event SlackEventPayload) ([]SlackMessage, string, bool, string) {
	if hasThreadFixture(event) {
		return threadMessagesFromEvent(event), "fixture", true, ""
	}

	channel := strings.TrimSpace(firstNonEmpty(event.Channel, nestedSlackMessageChannel(event)))
	threadTS := slackThreadLookupTS(event)
	if channel == "" || threadTS == "" {
		return threadMessagesFromEvent(event), "event_only", true, ""
	}
	if strings.TrimSpace(s.botToken) == "" {
		return threadMessagesFromEvent(event), "event_only", true, ""
	}

	response, err := s.callSlackConversationsReplies(ctx, channel, threadTS)
	if err != nil {
		return threadMessagesFromEvent(event), "slack_web_api", false, err.Error()
	}
	if !response.OK {
		return threadMessagesFromEvent(event), "slack_web_api", false, firstNonEmpty(response.Error, "slack_api_error")
	}
	if len(response.Messages) == 0 {
		return threadMessagesFromEvent(event), "slack_web_api", true, ""
	}
	if len(response.Messages) > maxAppMentionThreadMessages {
		response.Messages = response.Messages[:maxAppMentionThreadMessages]
	}
	return response.Messages, "slack_web_api", true, ""
}

func (s *Service) fetchLinkedSlackThreadContexts(ctx context.Context, currentChannelID string, currentThreadTS string, messages []SlackMessage, botUserID string) []SlackLinkedThreadContext {
	refs := extractLinkedSlackThreadRefs(messages, currentChannelID, currentThreadTS)
	if len(refs) == 0 || strings.TrimSpace(s.botToken) == "" {
		return nil
	}
	out := make([]SlackLinkedThreadContext, 0, len(refs))
	for _, ref := range refs {
		response, err := s.callSlackConversationsReplies(ctx, ref.ChannelID, ref.ThreadTS)
		context := SlackLinkedThreadContext{
			URL:       ref.URL,
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			FetchOK:   err == nil,
		}
		if err != nil {
			context.FetchError = err.Error()
			out = append(out, context)
			continue
		}
		if !response.OK {
			context.FetchOK = false
			context.FetchError = firstNonEmpty(response.Error, "slack_api_error")
			out = append(out, context)
			continue
		}
		threadMessages := limitSlackMessages(response.Messages)
		media := extractSlackThreadMedia(threadMessages)
		context.MessageCount = len(threadMessages)
		context.Transcript = formatSlackThreadTranscriptForBot(threadMessages, botUserID)
		context.CanvasFiles = media.CanvasFiles
		out = append(out, context)
	}
	return out
}

func extractLinkedSlackThreadRefs(messages []SlackMessage, currentChannelID string, currentThreadTS string) []slackLinkedThreadRef {
	seen := make(map[string]struct{})
	refs := make([]slackLinkedThreadRef, 0, maxLinkedSlackThreadContexts)
	addURL := func(rawURL string) {
		if len(refs) >= maxLinkedSlackThreadContexts {
			return
		}
		ref, ok := parseSlackArchivePermalink(rawURL)
		if !ok {
			return
		}
		if ref.ChannelID == currentChannelID && ref.ThreadTS == currentThreadTS {
			return
		}
		key := ref.ChannelID + "\x00" + ref.ThreadTS
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		refs = append(refs, ref)
	}
	for _, message := range messages {
		for _, rawURL := range slackTriageURLPattern.FindAllString(message.Text, -1) {
			addURL(rawURL)
		}
		for _, attachment := range message.Attachments {
			addURL(attachment.TitleLink)
			for _, rawURL := range slackTriageURLPattern.FindAllString(attachment.Text, -1) {
				addURL(rawURL)
			}
		}
	}
	return refs
}

func parseSlackArchivePermalink(rawURL string) (slackLinkedThreadRef, bool) {
	normalized := normalizeSlackExternalLinkURL(rawURL)
	if before, _, ok := strings.Cut(normalized, "|"); ok {
		normalized = before
	}
	parsed, err := url.Parse(normalized)
	if err != nil || !strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".slack.com") {
		return slackLinkedThreadRef{}, false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "archives" {
		return slackLinkedThreadRef{}, false
	}
	channelID := strings.TrimSpace(parts[1])
	pathTS := strings.TrimPrefix(strings.TrimSpace(parts[2]), "p")
	threadTS := firstNonEmpty(strings.TrimSpace(parsed.Query().Get("thread_ts")), slackPermalinkPathTS(pathTS))
	if channelID == "" || threadTS == "" {
		return slackLinkedThreadRef{}, false
	}
	return slackLinkedThreadRef{URL: normalized, ChannelID: channelID, ThreadTS: threadTS}, true
}

func slackPermalinkPathTS(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.Contains(value, ".") {
		return value
	}
	if len(value) <= 6 {
		return value
	}
	return value[:len(value)-6] + "." + value[len(value)-6:]
}

func linkedSlackThreadCanvasFiles(contexts []SlackLinkedThreadContext) []SlackThreadFile {
	var files []SlackThreadFile
	for _, context := range contexts {
		files = append(files, context.CanvasFiles...)
	}
	return files
}

func mergeSlackThreadFiles(existing []SlackThreadFile, extra []SlackThreadFile) []SlackThreadFile {
	if len(extra) == 0 {
		return existing
	}
	out := append([]SlackThreadFile(nil), existing...)
	seen := make(map[string]struct{}, len(out))
	for _, file := range out {
		key := firstNonEmpty(file.ID, file.Permalink, file.Title, file.Name)
		if key != "" {
			seen[key] = struct{}{}
		}
	}
	for _, file := range extra {
		key := firstNonEmpty(file.ID, file.Permalink, file.Title, file.Name)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, file)
	}
	return out
}

func hasThreadFixture(event SlackEventPayload) bool {
	return len(event.ThreadMessages) > 0 || len(event.ThreadMessagesCamel) > 0 || len(event.Replies) > 0
}

func (s *Service) callSlackConversationsReplies(ctx context.Context, channel string, threadTS string) (slackRepliesResponse, error) {
	values := url.Values{
		"channel": {strings.TrimSpace(channel)},
		"ts":      {strings.TrimSpace(threadTS)},
		"limit":   {strconv.Itoa(maxAppMentionThreadMessages)},
	}
	baseURL := strings.TrimRight(strings.TrimSpace(slackThreadFetchAPIBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/conversations.replies?"+values.Encode(), nil)
	if err != nil {
		return slackRepliesResponse{}, fmt.Errorf("build conversations.replies request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(s.botToken))

	httpResponse, err := httputil.NewHTTPClient(10 * time.Second).Do(request)
	if err != nil {
		return slackRepliesResponse{}, fmt.Errorf("call conversations.replies: %w", err)
	}
	defer httpResponse.Body.Close()

	var response slackRepliesResponse
	if err := json.NewDecoder(httpResponse.Body).Decode(&response); err != nil {
		return slackRepliesResponse{}, fmt.Errorf("decode conversations.replies response: %w", err)
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return response, fmt.Errorf("conversations.replies returned %d", httpResponse.StatusCode)
	}
	return response, nil
}
