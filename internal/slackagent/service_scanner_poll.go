package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const (
	slackHistoryScannerMinInterval       = 10 * time.Second
	slackHistoryScannerBootstrapLookback = 10 * time.Minute
	slackScannerContextMessageCount      = 3
)

var slackScannerAPIBaseURL = defaultSlackAPIBaseURL

type slackConversationsListResponse struct {
	OK               bool                         `json:"ok"`
	Error            string                       `json:"error,omitempty"`
	Channels         []slackScannerConversation   `json:"channels,omitempty"`
	ResponseMetadata slackScannerResponseMetadata `json:"response_metadata,omitempty"`
}

type slackScannerConversation struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	IsMember   bool   `json:"is_member,omitempty"`
	IsChannel  bool   `json:"is_channel,omitempty"`
	IsGroup    bool   `json:"is_group,omitempty"`
	IsPrivate  bool   `json:"is_private,omitempty"`
	IsArchived bool   `json:"is_archived,omitempty"`
}

type slackScannerResponseMetadata struct {
	NextCursor string `json:"next_cursor,omitempty"`
}

type slackConversationsHistoryResponse struct {
	OK       bool           `json:"ok"`
	Error    string         `json:"error,omitempty"`
	Messages []SlackMessage `json:"messages,omitempty"`
}

func (s *Service) startSlackHistoryScanner() {
	if s == nil || !s.slackHistoryScannerEnabled() {
		return
	}
	s.scannerMu.Lock()
	defer s.scannerMu.Unlock()
	if s.scannerCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.scannerCancel = cancel
	interval := s.slackHistoryScannerInterval()
	go s.runSlackHistoryScanner(ctx, interval)
}

func (s *Service) stopSlackHistoryScanner() {
	if s == nil {
		return
	}
	s.scannerMu.Lock()
	cancel := s.scannerCancel
	s.scannerCancel = nil
	s.scannerMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) slackHistoryScannerEnabled() bool {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return false
	}
	return s.InboundStatus().EventBuffer.Enabled
}

func (s *Service) slackHistoryScannerInterval() time.Duration {
	interval := slackInboundDefaultDebounce
	if s != nil && s.inbound != nil {
		snapshot := s.inbound.Snapshot()
		if snapshot.EventBuffer.Enabled {
			// Reuse the existing event debounce as the scanner cadence so live
			// tuning stays under the same env knob as the Cueboard scanner aliases.
			interval = s.inbound.debounce
		}
	}
	if interval < slackHistoryScannerMinInterval {
		return slackHistoryScannerMinInterval
	}
	return interval
}

func (s *Service) runSlackHistoryScanner(ctx context.Context, interval time.Duration) {
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if result, err := s.scanSlackHistoryOnce(ctx, slackHistoryScannerBootstrapLookback); err != nil {
				s.logger.Warn("slack history scanner sweep failed", "error", err)
			} else if result.OK {
				s.logger.Info("slack history scanner sweep complete", "channels", len(result.Sweeps))
			}
			timer.Reset(interval)
		}
	}
}

func (s *Service) scanSlackHistoryOnce(ctx context.Context, bootstrapLookback time.Duration) (SlackScannerSweepResult, error) {
	channels, err := s.listSlackScannerChannels(ctx)
	if err != nil {
		return SlackScannerSweepResult{OK: false, Error: err.Error(), Inbound: s.InboundStatus()}, err
	}
	result := SlackScannerSweepResult{OK: true, WorkspaceID: "workspace", Inbound: s.InboundStatus()}
	for _, channel := range channels {
		channelResult, err := s.scanSlackHistoryChannel(ctx, channel, bootstrapLookback)
		if err != nil {
			result.OK = false
			result.Sweeps = append(result.Sweeps, SlackScannerChannelResult{
				ChannelID: channel.ID,
				OK:        false,
				Source:    "slack_web_api",
				Error:     err.Error(),
			})
			continue
		}
		if channelResult != nil {
			result.Sweeps = append(result.Sweeps, *channelResult)
		}
	}
	result.Inbound = s.InboundStatus()
	return result, nil
}

func (s *Service) scanSlackHistoryChannel(ctx context.Context, channel slackScannerConversation, bootstrapLookback time.Duration) (*SlackScannerChannelResult, error) {
	channelID := strings.TrimSpace(channel.ID)
	if channelID == "" || channel.IsArchived {
		return nil, nil
	}
	previousCursor := s.inbound.Cursor(channelID)
	oldest := previousCursor
	if oldest == "" && bootstrapLookback > 0 {
		oldest = formatSlackTimestamp(time.Now().Add(-bootstrapLookback))
	}
	var contextMessages []SlackMessage
	if previousCursor != "" {
		contextMessages = s.fetchSlackHistoryContext(ctx, channelID, previousCursor)
	}
	messages, latestTS, err := s.fetchSlackHistory(ctx, channelID, oldest)
	if err != nil {
		return nil, err
	}
	if previousCursor == "" {
		cursor := firstNonEmpty(latestTS, formatSlackTimestamp(time.Now()))
		s.inbound.SetCursor(channelID, cursor)
		return &SlackScannerChannelResult{
			ChannelID:      channelID,
			OK:             true,
			Source:         "slack_web_api",
			PreviousCursor: previousCursor,
			NextCursor:     cursor,
			Scanned:        len(messages),
			Buffered:       0,
		}, nil
	}
	if latestTS != "" {
		defer s.inbound.SetCursor(channelID, latestTS)
	}
	if len(messages) == 0 {
		return &SlackScannerChannelResult{
			ChannelID:      channelID,
			OK:             true,
			Source:         "slack_web_api",
			PreviousCursor: previousCursor,
			NextCursor:     firstNonEmpty(latestTS, previousCursor),
		}, nil
	}
	sort.Slice(messages, func(i, j int) bool {
		return slackTSLess(firstNonEmpty(messages[i].TS, messages[i].EventTS), firstNonEmpty(messages[j].TS, messages[j].EventTS))
	})
	sweep := s.SweepSlackScanner(ctx, SlackScannerSweepRequest{
		WorkspaceID: "workspace",
		Flush:       boolPtr(true),
		Channels: []SlackScannerChannel{{
			ID:              channelID,
			Name:            channel.Name,
			Type:            slackScannerChannelType(channel),
			Messages:        slackScannerInboundMessages(channel, messages),
			ContextMessages: slackScannerInboundMessages(channel, contextMessages),
		}},
	})
	if len(sweep.Sweeps) == 0 {
		return nil, nil
	}
	channelResult := sweep.Sweeps[0]
	channelResult.Source = "slack_web_api"
	channelResult.PreviousCursor = previousCursor
	if latestTS != "" {
		channelResult.NextCursor = latestTS
	}
	return &channelResult, nil
}

func (s *Service) listSlackScannerChannels(ctx context.Context) ([]slackScannerConversation, error) {
	var channels []slackScannerConversation
	cursor := ""
	for {
		var response slackConversationsListResponse
		if err := s.callSlackScannerAPI(ctx, "conversations.list", map[string]string{
			"types":            "public_channel,private_channel",
			"exclude_archived": "true",
			"limit":            "1000",
			"cursor":           cursor,
		}, &response); err != nil {
			return nil, err
		}
		if !response.OK {
			return nil, fmt.Errorf("conversations.list: %s", firstNonEmpty(response.Error, "slack_api_error"))
		}
		for _, channel := range response.Channels {
			if channel.IsMember && !channel.IsArchived {
				channels = append(channels, channel)
			}
		}
		cursor = strings.TrimSpace(response.ResponseMetadata.NextCursor)
		if cursor == "" {
			break
		}
	}
	return channels, nil
}

func (s *Service) fetchSlackHistory(ctx context.Context, channelID string, oldest string) ([]SlackMessage, string, error) {
	params := map[string]string{
		"channel":   strings.TrimSpace(channelID),
		"limit":     "100",
		"inclusive": "false",
	}
	if strings.TrimSpace(oldest) != "" {
		params["oldest"] = strings.TrimSpace(oldest)
	}
	var response slackConversationsHistoryResponse
	if err := s.callSlackScannerAPI(ctx, "conversations.history", params, &response); err != nil {
		return nil, "", err
	}
	if !response.OK {
		return nil, "", fmt.Errorf("conversations.history %s: %s", channelID, firstNonEmpty(response.Error, "slack_api_error"))
	}
	latestTS := ""
	for _, message := range response.Messages {
		if ts := firstNonEmpty(message.TS, message.EventTS); slackTSGreater(ts, latestTS) {
			latestTS = ts
		}
	}
	return response.Messages, latestTS, nil
}

func (s *Service) fetchSlackHistoryContext(ctx context.Context, channelID string, latest string) []SlackMessage {
	if strings.TrimSpace(latest) == "" {
		return nil
	}
	params := map[string]string{
		"channel":   strings.TrimSpace(channelID),
		"latest":    strings.TrimSpace(latest),
		"limit":     strconv.Itoa(slackScannerContextMessageCount),
		"inclusive": "false",
	}
	var response slackConversationsHistoryResponse
	if err := s.callSlackScannerAPI(ctx, "conversations.history", params, &response); err != nil {
		s.logger.Warn("slack history scanner context fetch failed", "channel", channelID, "error", err)
		return nil
	}
	if !response.OK {
		s.logger.Warn("slack history scanner context fetch failed", "channel", channelID, "error", firstNonEmpty(response.Error, "slack_api_error"))
		return nil
	}
	sort.Slice(response.Messages, func(i, j int) bool {
		return slackTSLess(firstNonEmpty(response.Messages[i].TS, response.Messages[i].EventTS), firstNonEmpty(response.Messages[j].TS, response.Messages[j].EventTS))
	})
	return response.Messages
}

func (s *Service) callSlackScannerAPI(ctx context.Context, method string, params map[string]string, out any) error {
	baseURL := strings.TrimRight(strings.TrimSpace(slackScannerAPIBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}
	values := url.Values{}
	for key, value := range params {
		if strings.TrimSpace(value) != "" {
			values.Set(key, value)
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/"+strings.TrimSpace(method), strings.NewReader(values.Encode()))
	if err != nil {
		return fmt.Errorf("build slack scanner request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(s.botToken))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := httputil.NewHTTPClient(15 * time.Second).Do(request)
	if err != nil {
		return fmt.Errorf("call %s: %w", method, err)
	}
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s response: %w", method, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d", method, response.StatusCode)
	}
	return nil
}

func slackScannerInboundMessages(channel slackScannerConversation, messages []SlackMessage) []SlackInboundMessage {
	out := make([]SlackInboundMessage, 0, len(messages))
	channelType := slackScannerChannelType(channel)
	for _, message := range messages {
		out = append(out, SlackInboundMessage{
			TeamID:      "workspace",
			ChannelID:   channel.ID,
			ChannelType: channelType,
			UserID:      firstNonEmpty(message.User, message.UserID, message.UserIDCamel),
			BotID:       message.BotID,
			Subtype:     message.Subtype,
			Text:        message.Text,
			TS:          firstNonEmpty(message.TS, message.EventTS, message.Timestamp),
			EventTS:     firstNonEmpty(message.EventTS, message.TS, message.Timestamp),
			ThreadTS:    message.ThreadTS,
			ReplyCount:  message.ReplyCount,
			ReplyUsers:  append([]string(nil), message.ReplyUsers...),
			Files:       append([]SlackFile(nil), message.Files...),
			Reactions:   append([]SlackReaction(nil), message.Reactions...),
		})
	}
	return out
}

func slackScannerChannelType(channel slackScannerConversation) string {
	if channel.IsPrivate || channel.IsGroup {
		return "private_channel"
	}
	return "public_channel"
}

func formatSlackTimestamp(value time.Time) string {
	return strconv.FormatFloat(float64(value.UnixNano())/float64(time.Second), 'f', 6, 64)
}

func boolPtr(value bool) *bool {
	return &value
}
