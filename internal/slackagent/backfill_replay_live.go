package slackagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

// SlackBackfillLiveBaseURL is the override hook for tests. Production
// always uses the live Slack API base; the fake-server tests in
// backfill_replay_live_test.go flip this to their httptest.Server URL.
var SlackBackfillLiveBaseURL = defaultSlackAPIBaseURL

// Slice 2 of task #185: live conversations.history → candidate scan.
//
// Guardrails (per driver audit of 97f01a7, codified here so future
// edits can't quietly drop them):
//
//  1. snake_case / camelCase mixing — handled by ClassifyBackfillMessage
//     via NormalizeSlackInboundMessage. We just pass through.
//  2. two-stage replies fetch — conversations.history first; only
//     when `reply_count > 0` do we follow up with
//     conversations.replies to detect human-vs-bot replies.
//  3. bot detection multi-source — `isAuthoredByBot` reads bot_id +
//     user id list + the wrapper here also flags `subtype=bot_message`
//     by funnelling it through the same suppression rule.
//  4. truncation reporting — per-channel stats include `Truncated` and
//     `MessagesScanned` so the Markdown report can be honest about
//     whether the 24h window was actually fully covered.
//  5. 429 retry hard cap — we honour Retry-After up to maxRetries
//     attempts per call, then surface the failure as a Warnings entry
//     for that channel (the rest of the backfill keeps going).
//  6. no-post — this file does not post. It only reads + classifies.
//     `--post` is intentionally absent from the CLI for slice 2.

const (
	backfillLiveHistoryLimit       = 200
	backfillLiveDefaultMaxPerChan  = 200
	backfillLiveRetryCap           = 3
	backfillLiveRetryDefault       = 2 * time.Second
	backfillLiveRetryMax           = 30 * time.Second
	backfillLiveRepliesLimit       = 100
	backfillLiveRequestTimeoutSecs = 15
)

// SlackBackfillReplayLiveOptions configures one channel's backfill
// scan. The CLI builds one of these per --channel value.
type SlackBackfillReplayLiveOptions struct {
	BotToken              string
	BotUserIDs            []string
	ChannelID             string
	Since                 time.Duration
	MaxMessagesPerChannel int
	Now                   time.Time // optional; defaults to time.Now() if zero
}

// SlackBackfillReplayLiveStats reports what a single channel scan
// actually did so the Markdown report can be honest about coverage.
type SlackBackfillReplayLiveStats struct {
	ChannelID       string
	MessagesScanned int
	RepliesFetched  int
	CandidatesFound int
	Truncated       bool
	OldestScannedTS string
	NewestScannedTS string
	Warnings        []string
	APIRetriesTotal int
	APIRetries429   int
}

// BackfillReplayLive scans a single Slack channel for the past
// `opts.Since` window and returns oneesama-eligible follow-up
// candidates. It is intentionally per-channel; the CLI iterates a
// channel list and merges results.
//
// Error handling: a fatal upstream failure (bad token, channel
// inaccessible) is returned via err. Recoverable per-request errors
// (429 budget exhausted, replies fetch failed) are logged into
// stats.Warnings so the partial result is still useful.
func BackfillReplayLive(ctx context.Context, opts SlackBackfillReplayLiveOptions) ([]SlackBackfillCandidate, SlackBackfillReplayLiveStats, error) {
	stats := SlackBackfillReplayLiveStats{ChannelID: strings.TrimSpace(opts.ChannelID)}
	if strings.TrimSpace(opts.BotToken) == "" {
		return nil, stats, fmt.Errorf("BackfillReplayLive: BotToken is required")
	}
	if stats.ChannelID == "" {
		return nil, stats, fmt.Errorf("BackfillReplayLive: ChannelID is required")
	}
	since := opts.Since
	if since <= 0 {
		since = 24 * time.Hour
	}
	maxPerChan := opts.MaxMessagesPerChannel
	if maxPerChan <= 0 {
		maxPerChan = backfillLiveDefaultMaxPerChan
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	oldest := now.Add(-since).Unix()

	messages, truncated, scanStats, err := fetchHistoryWindow(ctx, opts.BotToken, stats.ChannelID, oldest, maxPerChan, &stats)
	stats.MessagesScanned = scanStats.scanned
	stats.OldestScannedTS = scanStats.oldestTS
	stats.NewestScannedTS = scanStats.newestTS
	stats.Truncated = truncated
	if err != nil {
		return nil, stats, err
	}

	candidates := make([]SlackBackfillCandidate, 0, len(messages))
	for _, root := range messages {
		// Two-stage: only ask Slack for replies when reply_count > 0.
		// Saves a chunk of conversations.replies traffic on quiet
		// channels.
		var replies []SlackInboundMessage
		if root.ReplyCount > 0 {
			fetched, fetchErr := fetchRepliesFor(ctx, opts.BotToken, root.ChannelID, firstNonEmpty(root.ThreadTS, root.TS), &stats)
			if fetchErr != nil {
				stats.Warnings = append(stats.Warnings, fmt.Sprintf("replies fetch failed for ts=%s: %v", root.TS, fetchErr))
			} else {
				stats.RepliesFetched++
				replies = fetched
			}
		}
		candidate, ok := ClassifyBackfillMessage(root, replies, opts.BotUserIDs)
		if !ok {
			continue
		}
		candidate = markBackfillLinkCandidateForAgentRead(candidate)
		candidates = append(candidates, candidate)
	}
	stats.CandidatesFound = len(candidates)
	return candidates, stats, nil
}

func markBackfillLinkCandidateForAgentRead(candidate SlackBackfillCandidate) SlackBackfillCandidate {
	if !strings.EqualFold(strings.TrimSpace(candidate.Classification), "link_followup_candidate") {
		return candidate
	}
	// Backfill must not grow ad-hoc document readers (PDF parsers,
	// HTML scrapers, etc.) in Go. Its job is to find the lead and
	// produce a structured request for the connected agent/runner to
	// read the material with source evidence. The live triage path may
	// still use its own external-link context, but replay reports stay
	// conservative until an agent read result exists.
	candidate.ReviewStatus = ""
	candidate.ReviewReason = ""
	return markBackfillCandidateQuality(candidate)
}

type historyScanStats struct {
	scanned  int
	oldestTS string
	newestTS string
}

func fetchHistoryWindow(ctx context.Context, token string, channelID string, oldest int64, maxPerChannel int, stats *SlackBackfillReplayLiveStats) ([]SlackInboundMessage, bool, historyScanStats, error) {
	collected := make([]SlackInboundMessage, 0, maxPerChannel)
	cursor := ""
	scan := historyScanStats{}
	truncated := false
	for {
		page, nextCursor, err := callConversationsHistory(ctx, token, channelID, oldest, cursor, stats)
		if err != nil {
			return nil, false, scan, err
		}
		for _, raw := range page {
			ib := normalizeSlackInboundMessage(slackInboundMessageFromSlackMessage(raw, channelID))
			if scan.oldestTS == "" || ib.TS < scan.oldestTS {
				scan.oldestTS = ib.TS
			}
			if scan.newestTS == "" || ib.TS > scan.newestTS {
				scan.newestTS = ib.TS
			}
			collected = append(collected, ib)
			scan.scanned++
			if len(collected) >= maxPerChannel {
				truncated = true
				break
			}
		}
		if truncated || nextCursor == "" {
			break
		}
		cursor = nextCursor
	}
	return collected, truncated, scan, nil
}

// slackInboundMessageFromSlackMessage maps a conversations.history /
// .replies record into the canonical SlackInboundMessage shape that
// the classifier expects. We copy reply_count + thread_ts because the
// two-stage fetch decision in BackfillReplayLive depends on them.
func slackInboundMessageFromSlackMessage(m SlackMessage, channelID string) SlackInboundMessage {
	return SlackInboundMessage{
		ChannelID:  firstNonEmpty(m.Channel, channelID),
		UserID:     firstNonEmpty(m.UserID, m.UserIDCamel, m.User),
		User:       m.User,
		BotID:      m.BotID,
		Subtype:    m.Subtype,
		Text:       m.Text,
		TS:         firstNonEmpty(m.TS, m.Timestamp, m.EventTS),
		EventTS:    m.EventTS,
		ThreadTS:   m.ThreadTS,
		ReplyCount: m.ReplyCount,
		ReplyUsers: m.ReplyUsers,
		Files:      m.Files,
	}
}

func fetchRepliesFor(ctx context.Context, token string, channelID string, threadTS string, stats *SlackBackfillReplayLiveStats) ([]SlackInboundMessage, error) {
	values := url.Values{
		"channel": {channelID},
		"ts":      {threadTS},
		"limit":   {strconv.Itoa(backfillLiveRepliesLimit)},
	}
	var resp slackRepliesResponse
	if err := doSlackGetWithRetry(ctx, token, "conversations.replies", values, &resp, stats); err != nil {
		return nil, err
	}
	if !resp.OK {
		return nil, fmt.Errorf("conversations.replies returned ok=false (%s)", resp.Error)
	}
	out := make([]SlackInboundMessage, 0, len(resp.Messages))
	// First message in conversations.replies is the root itself; the
	// classifier already has it. Skip the root, only return human/bot
	// replies after it.
	for index, raw := range resp.Messages {
		if index == 0 {
			continue
		}
		out = append(out, normalizeSlackInboundMessage(slackInboundMessageFromSlackMessage(raw, channelID)))
	}
	return out, nil
}

// backfillLiveHistoryResponse extends the existing
// `slackConversationsHistoryResponse` (defined in service_scanner_poll.go)
// with the `response_metadata.next_cursor` pagination field. The scanner's
// shape doesn't need pagination so it was omitted there; this scan does.
type backfillLiveHistoryResponse struct {
	OK               bool                              `json:"ok"`
	Error            string                            `json:"error,omitempty"`
	Messages         []SlackMessage                    `json:"messages,omitempty"`
	ResponseMetadata backfillLiveHistoryResponseCursor `json:"response_metadata,omitempty"`
}

type backfillLiveHistoryResponseCursor struct {
	NextCursor string `json:"next_cursor,omitempty"`
}

func callConversationsHistory(ctx context.Context, token string, channelID string, oldest int64, cursor string, stats *SlackBackfillReplayLiveStats) ([]SlackMessage, string, error) {
	values := url.Values{
		"channel": {channelID},
		"limit":   {strconv.Itoa(backfillLiveHistoryLimit)},
		"oldest":  {strconv.FormatInt(oldest, 10)},
	}
	if strings.TrimSpace(cursor) != "" {
		values.Set("cursor", cursor)
	}
	var resp backfillLiveHistoryResponse
	if err := doSlackGetWithRetry(ctx, token, "conversations.history", values, &resp, stats); err != nil {
		return nil, "", err
	}
	if !resp.OK {
		return nil, "", fmt.Errorf("conversations.history returned ok=false (%s)", resp.Error)
	}
	return resp.Messages, strings.TrimSpace(resp.ResponseMetadata.NextCursor), nil
}

// doSlackGetWithRetry issues a GET to {SlackBackfillLiveBaseURL}/{method}
// with Bearer-token auth, honouring Slack's `Retry-After` header on
// 429 up to `backfillLiveRetryCap` total attempts.
func doSlackGetWithRetry(ctx context.Context, token string, method string, values url.Values, out any, stats *SlackBackfillReplayLiveStats) error {
	base := strings.TrimRight(strings.TrimSpace(SlackBackfillLiveBaseURL), "/")
	if base == "" {
		base = defaultSlackAPIBaseURL
	}
	endpoint := base + "/" + method + "?" + values.Encode()
	var lastErr error
	for attempt := 0; attempt < backfillLiveRetryCap; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return fmt.Errorf("build %s request: %w", method, err)
		}
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))

		client := httputil.NewHTTPClient(time.Duration(backfillLiveRequestTimeoutSecs) * time.Second)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("attempt %d %s: %w", attempt+1, method, err)
			if stats != nil {
				stats.APIRetriesTotal++
			}
			if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			return lastErr
		}
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			retryAfter := parseRetryAfterSeconds(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			if stats != nil {
				stats.APIRetries429++
				stats.APIRetriesTotal++
			}
			lastErr = fmt.Errorf("attempt %d %s: 429 (retry-after=%s)", attempt+1, method, retryAfter)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryAfter):
			}
			continue
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			defer resp.Body.Close()
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				return fmt.Errorf("decode %s response: %w", method, err)
			}
			return nil
		default:
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return fmt.Errorf("%s returned HTTP %d: %s", method, resp.StatusCode, strings.TrimSpace(string(body)))
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("%s exhausted %d retries", method, backfillLiveRetryCap)
	}
	return lastErr
}

// SlackBackfillJoinedChannel is the minimal channel shape the CLI
// auto-discovery path returns. Production callers may pass these
// directly back into BackfillReplayLive(opts.ChannelID = c.ID).
type SlackBackfillJoinedChannel struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	IsArchived bool   `json:"is_archived,omitempty"`
	IsMember   bool   `json:"is_member,omitempty"`
	IsPrivate  bool   `json:"is_private,omitempty"`
}

type slackUsersConversationsResponse struct {
	OK               bool                              `json:"ok"`
	Error            string                            `json:"error,omitempty"`
	Channels         []SlackBackfillJoinedChannel      `json:"channels,omitempty"`
	ResponseMetadata backfillLiveHistoryResponseCursor `json:"response_metadata,omitempty"`
}

type slackBackfillConversationsListResponse struct {
	OK               bool                              `json:"ok"`
	Error            string                            `json:"error,omitempty"`
	Channels         []SlackBackfillJoinedChannel      `json:"channels,omitempty"`
	ResponseMetadata backfillLiveHistoryResponseCursor `json:"response_metadata,omitempty"`
}

// ListBackfillJoinedChannels asks Slack for the channels the bot user
// currently belongs to, paginating through `users.conversations`
// until exhausted. Used by the CLI's `--channel auto` mode so the
// operator doesn't have to remember channel ids by hand.
//
// Audit-safety rules (per driver's slice-3 design review):
//   - Only public + private channels (`types=public_channel,private_channel`).
//     No mpim/im — DMs are scoped to specific humans, scanning them
//     would be the wrong product behaviour.
//   - `exclude_archived=true` so the scan doesn't waste budget on
//     dead channels.
//   - The function does NOT join channels it isn't in. `users.conversations`
//     should normally return only joined channels. If that endpoint
//     returns an empty list for a bot token, we fall back to
//     `conversations.list` filtered by `is_member=true`; this mirrors
//     the live 2026-05-18 incident where users.conversations returned
//     zero while conversations.list showed the bot in 44 channels.
func ListBackfillJoinedChannels(ctx context.Context, token string) ([]SlackBackfillJoinedChannel, error) {
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("ListBackfillJoinedChannels: token is required")
	}
	out, err := listBackfillJoinedChannelsViaUsersConversations(ctx, token)
	if err != nil {
		return nil, err
	}
	if len(out) > 0 {
		return out, nil
	}
	return listBackfillJoinedChannelsViaConversationsList(ctx, token)
}

func listBackfillJoinedChannelsViaUsersConversations(ctx context.Context, token string) ([]SlackBackfillJoinedChannel, error) {
	out := make([]SlackBackfillJoinedChannel, 0)
	cursor := ""
	for {
		values := url.Values{
			"types":            {"public_channel,private_channel"},
			"exclude_archived": {"true"},
			"limit":            {"200"},
		}
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		var resp slackUsersConversationsResponse
		if err := doSlackGetWithRetry(ctx, token, "users.conversations", values, &resp, nil); err != nil {
			return nil, err
		}
		if !resp.OK {
			return nil, fmt.Errorf("users.conversations returned ok=false (%s)", resp.Error)
		}
		for _, ch := range resp.Channels {
			if ch.IsArchived || !ch.IsMember {
				continue
			}
			out = append(out, ch)
		}
		next := strings.TrimSpace(resp.ResponseMetadata.NextCursor)
		if next == "" {
			break
		}
		cursor = next
	}
	return out, nil
}

func listBackfillJoinedChannelsViaConversationsList(ctx context.Context, token string) ([]SlackBackfillJoinedChannel, error) {
	out := make([]SlackBackfillJoinedChannel, 0)
	cursor := ""
	for {
		values := url.Values{
			"types":            {"public_channel,private_channel"},
			"exclude_archived": {"true"},
			"limit":            {"200"},
		}
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		var resp slackBackfillConversationsListResponse
		if err := doSlackGetWithRetry(ctx, token, "conversations.list", values, &resp, nil); err != nil {
			return nil, err
		}
		if !resp.OK {
			return nil, fmt.Errorf("conversations.list returned ok=false (%s)", resp.Error)
		}
		for _, ch := range resp.Channels {
			if ch.IsArchived || !ch.IsMember {
				continue
			}
			out = append(out, ch)
		}
		next := strings.TrimSpace(resp.ResponseMetadata.NextCursor)
		if next == "" {
			break
		}
		cursor = next
	}
	return out, nil
}

func parseRetryAfterSeconds(raw string) time.Duration {
	value := strings.TrimSpace(raw)
	if value == "" {
		return backfillLiveRetryDefault
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		return backfillLiveRetryDefault
	}
	d := time.Duration(seconds) * time.Second
	if d > backfillLiveRetryMax {
		return backfillLiveRetryMax
	}
	return d
}
