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

func (s *Service) buildSlackAppMentionContext(ctx context.Context, workspaceID string, event SlackEventPayload) *SlackAppMentionContext {
	messages, source, ok, fetchErr := s.fetchSlackMentionThreadMessages(ctx, event)
	enriched := event
	if len(messages) > 0 {
		enriched.Replies = messages
	}
	richContext := buildSlackAppMentionContext(enriched)
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
	}
	return richContext
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
