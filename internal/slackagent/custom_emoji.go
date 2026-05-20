package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const slackCustomEmojiPromptLimit = 200

type SlackCustomEmojiStatus struct {
	Loaded        bool   `json:"loaded"`
	Count         int    `json:"count"`
	LastRefreshAt string `json:"last_refresh_at,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type slackCustomEmojiRefreshResult struct {
	Names []string
	Error string
}

func (s *Service) refreshWorkspaceCustomEmojiOnStart(ctx context.Context) {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return
	}
	refreshCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := s.RefreshWorkspaceCustomEmoji(refreshCtx)
	if result.Error != "" {
		s.logger.Warn("slack custom emoji refresh failed", "error", result.Error)
		return
	}
	s.logger.Info("slack custom emoji loaded", "count", len(result.Names))
}

func (s *Service) RefreshWorkspaceCustomEmoji(ctx context.Context) slackCustomEmojiRefreshResult {
	if s == nil {
		return slackCustomEmojiRefreshResult{Error: "service_unavailable"}
	}
	names, errText := fetchWorkspaceCustomEmoji(ctx, strings.TrimSpace(s.botToken), defaultSlackAPIBaseURL, nil)
	s.customEmojiMu.Lock()
	defer s.customEmojiMu.Unlock()
	s.customEmojiLastRefreshAt = timeNow().UTC()
	s.customEmojiLastError = errText
	if errText == "" {
		s.customEmoji = names
	}
	return slackCustomEmojiRefreshResult{Names: append([]string(nil), s.customEmoji...), Error: errText}
}

func (s *Service) workspaceCustomEmojiSnapshot() []string {
	if s == nil {
		return nil
	}
	s.customEmojiMu.Lock()
	defer s.customEmojiMu.Unlock()
	return append([]string(nil), s.customEmoji...)
}

func (s *Service) customEmojiStatus() SlackCustomEmojiStatus {
	if s == nil {
		return SlackCustomEmojiStatus{}
	}
	s.customEmojiMu.Lock()
	defer s.customEmojiMu.Unlock()
	return SlackCustomEmojiStatus{
		Loaded:        !s.customEmojiLastRefreshAt.IsZero(),
		Count:         len(s.customEmoji),
		LastRefreshAt: formatSlackCustomEmojiTime(s.customEmojiLastRefreshAt),
		LastError:     s.customEmojiLastError,
	}
}

func formatSlackCustomEmojiTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func fetchWorkspaceCustomEmoji(ctx context.Context, botToken string, apiBaseURL string, transport http.RoundTripper) ([]string, string) {
	if strings.TrimSpace(botToken) == "" {
		return nil, "missing_slack_bot_token"
	}
	client := httputil.NewHTTPClient(10 * time.Second)
	if transport != nil {
		client.Transport = transport
	}
	var body struct {
		OK    bool              `json:"ok"`
		Error string            `json:"error,omitempty"`
		Emoji map[string]string `json:"emoji,omitempty"`
	}
	result := callSlackFormAPI(ctx, client, botToken, apiBaseURL, "emoji.list", url.Values{}, &body)
	if !result.OK {
		return nil, firstNonEmpty(result.Error, result.Detail, "emoji_list_failed")
	}
	if !body.OK {
		return nil, firstNonEmpty(body.Error, "slack_api_error")
	}
	return normalizeWorkspaceCustomEmoji(body.Emoji), ""
}

func normalizeWorkspaceCustomEmoji(emoji map[string]string) []string {
	names := make([]string, 0, len(emoji))
	for name, value := range emoji {
		name = strings.Trim(strings.TrimSpace(name), ":")
		if name == "" {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(value), "alias:") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func formatWorkspaceCustomEmojiPrompt(names []string) string {
	names = normalizeWorkspaceCustomEmojiNames(names)
	if len(names) == 0 {
		return ""
	}
	if len(names) > slackCustomEmojiPromptLimit {
		names = names[:slackCustomEmojiPromptLimit]
	}
	return "## Workspace custom emoji\n" + strings.Join(names, ", ")
}

func normalizeWorkspaceCustomEmojiNames(names []string) []string {
	if len(names) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.Trim(strings.TrimSpace(name), ":")
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func workspaceCustomEmojiJSON(names []string, source string) slackAPIToolResult {
	payload, err := json.Marshal(map[string]any{
		"ok":     true,
		"source": source,
		"emoji":  normalizeWorkspaceCustomEmojiNames(names),
	})
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to encode custom emoji list: " + err.Error()}
	}
	return slackAPIToolResult{Success: true, Text: string(payload)}
}
