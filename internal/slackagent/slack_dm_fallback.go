package slackagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// Slack DM / debug-channel fallback. Mirrors Cueboard's `openDM` + `postDM`
// + `postDebugChannel` plumbing so a public-channel post failure can still
// reach the operator via pilot DM, and operator-only diagnostic notes can
// be posted to a configured debug channel. Both surfaces dedupe recent
// duplicate text in-memory so a single retry storm or repeated webhook fire
// does not spam the operator inbox.

const (
	slackDMDedupBudget = 32
	slackDMDedupHashes = 64
)

type slackDMPoster struct {
	mu         sync.Mutex
	dmChannels map[string]string // user_id -> dm channel_id cache
	dedupe     map[string]struct{}
	dedupeKeys []string
}

func newSlackDMPoster() *slackDMPoster {
	return &slackDMPoster{
		dmChannels: make(map[string]string, 8),
		dedupe:     make(map[string]struct{}, slackDMDedupHashes),
	}
}

func (p *slackDMPoster) openDM(ctx context.Context, client *http.Client, botToken, apiBaseURL, userID string) (string, error) {
	p.mu.Lock()
	if cached, ok := p.dmChannels[userID]; ok {
		p.mu.Unlock()
		return cached, nil
	}
	p.mu.Unlock()

	baseURL := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}
	form := url.Values{}
	form.Set("users", userID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/conversations.open", strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("build conversations.open request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if token := strings.TrimSpace(botToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("conversations.open: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error,omitempty"`
		Channel struct {
			ID string `json:"id"`
		} `json:"channel"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("decode conversations.open: %w", err)
	}
	if !body.OK {
		return "", fmt.Errorf("conversations.open returned %s", firstNonEmpty(body.Error, "slack_api_error"))
	}
	if strings.TrimSpace(body.Channel.ID) == "" {
		return "", fmt.Errorf("conversations.open returned no channel id")
	}
	p.mu.Lock()
	p.dmChannels[userID] = body.Channel.ID
	p.mu.Unlock()
	return body.Channel.ID, nil
}

// shouldSendOnce reports whether the (channel, text) tuple has been posted
// recently. It also records the hash for future dedupe checks. The cache is
// bounded so memory does not grow unbounded across long-running processes.
func (p *slackDMPoster) shouldSendOnce(channelID, text string) bool {
	key := slackDMDedupKey(channelID, text)
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, seen := p.dedupe[key]; seen {
		return false
	}
	p.dedupe[key] = struct{}{}
	p.dedupeKeys = append(p.dedupeKeys, key)
	if len(p.dedupeKeys) > slackDMDedupHashes {
		evict := p.dedupeKeys[:len(p.dedupeKeys)-slackDMDedupHashes]
		for _, evicted := range evict {
			delete(p.dedupe, evicted)
		}
		p.dedupeKeys = p.dedupeKeys[len(p.dedupeKeys)-slackDMDedupHashes:]
	}
	return true
}

// CacheDM is exported for tests to seed the channel cache.
func (p *slackDMPoster) CacheDM(userID, channelID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dmChannels[userID] = channelID
}

// HasDedupeHash returns whether shouldSendOnce has already recorded the
// (channel, text) tuple. Used by tests to assert dedupe state without
// re-triggering the eviction policy.
func (p *slackDMPoster) HasDedupeHash(channelID, text string) bool {
	key := slackDMDedupKey(channelID, text)
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.dedupe[key]
	return ok
}

func slackDMDedupKey(channelID, text string) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(channelID) + "\x00" + strings.TrimSpace(text)))
	return hex.EncodeToString(hash[:slackDMDedupBudget/2])
}

// SlackOperatorFallback packages the operator-routing settings + the in-
// memory DM/debug poster. The result returned from each Post* method
// follows the existing PostMessageResult convention so callers can pipe it
// into the same observability path.
type SlackOperatorFallback struct {
	BotToken       string
	APIBaseURL     string
	Client         *http.Client
	PilotUserID    string
	DebugChannelID string
	Poster         PosterService
	PublicNotice   func(context.Context, slackPublicNotificationDelivery) slackPublicNotificationDeliveryResult
	DM             *slackDMPoster
}

// PostPilotDM resolves the configured pilot user, opens (or reuses) a DM
// channel, and posts the supplied text. Duplicate text within the dedupe
// budget is silently dropped. If no pilot is configured the call is a no-op
// returning ok=false / skipped=true.
type SlackOperatorPostResult struct {
	OK       bool   `json:"ok"`
	Skipped  bool   `json:"skipped,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Channel  string `json:"channel,omitempty"`
	Surface  string `json:"surface"`
	Original PostMessageResult
}

func (f *SlackOperatorFallback) PostPilotDM(ctx context.Context, text string) SlackOperatorPostResult {
	result := SlackOperatorPostResult{Surface: "pilot_dm"}
	pilotUserID := strings.TrimSpace(f.PilotUserID)
	if pilotUserID == "" {
		result.Skipped = true
		result.Reason = "pilot_user_id_not_configured"
		return result
	}
	text = strings.TrimSpace(text)
	if text == "" {
		result.Skipped = true
		result.Reason = "empty_text"
		return result
	}
	channelID, err := f.DM.openDM(ctx, f.Client, f.BotToken, f.APIBaseURL, pilotUserID)
	if err != nil {
		result.Reason = "open_dm_failed:" + err.Error()
		return result
	}
	result.Channel = channelID
	if !f.DM.shouldSendOnce(channelID, text) {
		result.Skipped = true
		result.Reason = "duplicate_within_dedupe_window"
		result.OK = true
		return result
	}
	post := f.Poster.PostMessage(ctx, PostMessageInput{
		Channel:  channelID,
		Text:     text,
		DedupKey: "pilot_dm:" + channelID + ":" + slackDMDedupKey(channelID, text),
	})
	result.Original = post
	result.OK = post.OK
	return result
}

// PostDebugChannel posts a diagnostic message to the configured debug
// channel. Idempotent within the dedupe window and a no-op when no debug
// channel is configured.
func (f *SlackOperatorFallback) PostDebugChannel(ctx context.Context, text string) SlackOperatorPostResult {
	result := SlackOperatorPostResult{Surface: "debug_channel"}
	channelID := strings.TrimSpace(f.DebugChannelID)
	if channelID == "" {
		result.Skipped = true
		result.Reason = "debug_channel_id_not_configured"
		return result
	}
	text = strings.TrimSpace(text)
	if text == "" {
		result.Skipped = true
		result.Reason = "empty_text"
		return result
	}
	result.Channel = channelID
	if !f.DM.shouldSendOnce(channelID, text) {
		result.Skipped = true
		result.Reason = "duplicate_within_dedupe_window"
		result.OK = true
		return result
	}
	dedupKey := "debug_channel:" + channelID + ":" + slackDMDedupKey(channelID, text)
	if f.PublicNotice == nil {
		result.Skipped = true
		result.Reason = "public_notification_not_configured"
		return result
	}
	delivery := f.PublicNotice(ctx, slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceOperatorDebug,
		Surface:   slackPublicNotificationSurfaceOperatorNotice,
		ChannelID: channelID,
		Text:      text,
		DedupKey:  dedupKey,
	})
	post := delivery.Post
	if delivery.Blocked && post.Error == "" {
		post = PostMessageResult{OK: false, Error: delivery.BlockReason}
	}
	result.Original = post
	result.OK = post.OK
	return result
}
