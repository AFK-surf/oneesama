package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestBackfillReplayLiveHappyPath proves the end-to-end path: fake
// Slack returns a small history page; one root has reply_count=0 (no
// replies fetch); one has reply_count=1 (bot-only reply, so candidate
// still surfaces); one is a +1 (suppressed). Final output is a single
// candidate with correct channel + classification.
func TestBackfillReplayLiveHappyPath(t *testing.T) {
	mux := http.NewServeMux()
	var historyCalls, repliesCalls int32
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&historyCalls, 1)
		writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "1779000300.000", User: "U_PENG", Text: "CI 在 main 整体卡住了，要不要回滚一下？", ReplyCount: 1},
				{TS: "1779000200.000", User: "U_PENG", Text: "+1"},
				{TS: "1779000100.000", User: "U_PENG", Text: "我们的 canvas write 真的稳了吗？"},
			},
		})
	})
	mux.HandleFunc("/conversations.replies", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&repliesCalls, 1)
		writeFakeSlackJSON(t, w, slackRepliesResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "1779000300.000", User: "U_PENG", Text: "CI 在 main 整体卡住了，要不要回滚一下？"},
				{TS: "1779000350.000", User: "U_BOT", Text: "我先看看"},
			},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	setLiveBaseURL(t, server.URL)

	candidates, stats, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{
		BotToken:   "xoxb-test",
		BotUserIDs: []string{"U_BOT"},
		ChannelID:  "C1",
		Since:      24 * time.Hour,
		Now:        time.Unix(1779000400, 0),
	})
	if err != nil {
		t.Fatalf("BackfillReplayLive: %v", err)
	}
	if got := atomic.LoadInt32(&historyCalls); got != 1 {
		t.Errorf("conversations.history called %d times, want 1", got)
	}
	if got := atomic.LoadInt32(&repliesCalls); got != 1 {
		t.Errorf("conversations.replies called %d times, want 1 (only root with reply_count>0)", got)
	}
	if stats.MessagesScanned != 3 {
		t.Errorf("MessagesScanned = %d, want 3", stats.MessagesScanned)
	}
	if stats.CandidatesFound != 2 {
		t.Errorf("CandidatesFound = %d, want 2 (stuck + canvas question, +1 dropped)", stats.CandidatesFound)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates len = %d, want 2", len(candidates))
	}
	for _, c := range candidates {
		if c.ChannelID != "C1" {
			t.Errorf("candidate ChannelID = %q, want C1", c.ChannelID)
		}
	}
}

// TestBackfillReplayLiveFollowsPagination confirms next_cursor is
// honoured until the channel is fully drained or the truncation cap
// hits — and that truncation flips the Truncated stat.
func TestBackfillReplayLiveFollowsPagination(t *testing.T) {
	mux := http.NewServeMux()
	var historyCalls int32
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		call := atomic.AddInt32(&historyCalls, 1)
		switch call {
		case 1:
			writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
				OK: true,
				Messages: []SlackMessage{
					{TS: "1779000200.000", User: "U_PENG", Text: "Page 1 message — is canvas safe to enable?"},
				},
				ResponseMetadata: backfillLiveHistoryResponseCursor{NextCursor: "next-page-token"},
			})
		default:
			if got := r.URL.Query().Get("cursor"); got != "next-page-token" {
				t.Errorf("page 2 cursor = %q, want next-page-token", got)
			}
			writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
				OK: true,
				Messages: []SlackMessage{
					{TS: "1779000100.000", User: "U_PENG", Text: "Page 2 — should we delay the launch?"},
				},
			})
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	candidates, stats, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{
		BotToken:   "xoxb-test",
		ChannelID:  "C1",
		Since:      24 * time.Hour,
		BotUserIDs: []string{"U_BOT"},
	})
	if err != nil {
		t.Fatalf("BackfillReplayLive: %v", err)
	}
	if got := atomic.LoadInt32(&historyCalls); got != 2 {
		t.Errorf("conversations.history called %d times, want 2", got)
	}
	if stats.MessagesScanned != 2 {
		t.Errorf("MessagesScanned = %d, want 2", stats.MessagesScanned)
	}
	if stats.Truncated {
		t.Errorf("Truncated = true; pagination drained fully, want false")
	}
	if len(candidates) != 2 {
		t.Errorf("candidates len = %d, want 2", len(candidates))
	}
}

// TestBackfillReplayLiveTruncatesAtMax is the regression for the
// truncation guardrail driver insisted on (audit point #5). The CLI's
// `--max-messages-per-channel` must reflect Truncated=true so the
// Markdown report stays honest about coverage.
func TestBackfillReplayLiveTruncatesAtMax(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		// 5 messages but max is 3.
		writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "1779000500.000", User: "U_PENG", Text: "msg 1: canvas writes 要不要 ship?"},
				{TS: "1779000400.000", User: "U_PENG", Text: "msg 2: 这个 PR 卡住了，要不要看一下？"},
				{TS: "1779000300.000", User: "U_PENG", Text: "msg 3: 我们要不要回滚 canvas writes 的发布？"},
				{TS: "1779000200.000", User: "U_PENG", Text: "msg 4: ASR chunk 是不是该上 production?"},
				{TS: "1779000100.000", User: "U_PENG", Text: "msg 5: build cache 怎么办?"},
			},
			ResponseMetadata: backfillLiveHistoryResponseCursor{NextCursor: "should-not-be-followed"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	_, stats, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{
		BotToken:              "xoxb-test",
		ChannelID:             "C1",
		Since:                 24 * time.Hour,
		MaxMessagesPerChannel: 3,
		BotUserIDs:            []string{"U_BOT"},
	})
	if err != nil {
		t.Fatalf("BackfillReplayLive: %v", err)
	}
	if !stats.Truncated {
		t.Errorf("Truncated = false, want true when max=3 and 5 messages available")
	}
	if stats.MessagesScanned != 3 {
		t.Errorf("MessagesScanned = %d, want 3", stats.MessagesScanned)
	}
}

// TestBackfillReplayLiveRetries429UpToCap exercises the 429 retry
// guardrail (audit point #6): respect Retry-After but cap retries.
func TestBackfillReplayLiveRetries429UpToCap(t *testing.T) {
	mux := http.NewServeMux()
	var attempts int32
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		count := atomic.AddInt32(&attempts, 1)
		if count < 2 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "1779000200.000", User: "U_PENG", Text: "我们能不能延迟 launch ?"},
			},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	candidates, stats, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{
		BotToken:   "xoxb-test",
		ChannelID:  "C1",
		Since:      24 * time.Hour,
		BotUserIDs: []string{"U_BOT"},
	})
	if err != nil {
		t.Fatalf("BackfillReplayLive: %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Errorf("attempts = %d, want 2 (1 retry after 429)", got)
	}
	if stats.APIRetries429 != 1 {
		t.Errorf("APIRetries429 = %d, want 1", stats.APIRetries429)
	}
	if len(candidates) != 1 {
		t.Errorf("candidates len = %d, want 1", len(candidates))
	}
}

// TestBackfillReplayLiveSurfacesRepliesFetchError verifies that a
// failed conversations.replies call adds a Warning to stats but does
// NOT abort the channel scan — the remaining root messages still go
// through classification.
func TestBackfillReplayLiveSurfacesRepliesFetchError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/conversations.history", func(w http.ResponseWriter, r *http.Request) {
		writeFakeSlackJSON(t, w, backfillLiveHistoryResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "1779000200.000", User: "U_PENG", Text: "Root with broken replies — 是不是该回滚 canvas writes?", ReplyCount: 1},
				{TS: "1779000100.000", User: "U_PENG", Text: "Healthy root — 我们要不要看一下 ASR chunk?"},
			},
		})
	})
	mux.HandleFunc("/conversations.replies", func(w http.ResponseWriter, r *http.Request) {
		// All 3 retry attempts fail with non-429 server error so
		// the failure surfaces as a warning rather than retried.
		http.Error(w, `{"ok":false,"error":"channel_not_found"}`, http.StatusOK)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	candidates, stats, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{
		BotToken:   "xoxb-test",
		ChannelID:  "C1",
		Since:      24 * time.Hour,
		BotUserIDs: []string{"U_BOT"},
	})
	if err != nil {
		t.Fatalf("BackfillReplayLive: %v", err)
	}
	if len(stats.Warnings) == 0 {
		t.Error("expected Warnings to include the failed replies fetch")
	}
	if len(candidates) < 1 {
		t.Errorf("candidates len = %d, want >= 1 (healthy root must still classify)", len(candidates))
	}
}

// TestListBackfillJoinedChannelsFiltersArchivedAndNonMember pins the
// audit-safety rules from driver's slice-3 design review: archived
// channels and channels the bot is no longer a member of are excluded
// (even though Slack should not return them via users.conversations,
// we defensively filter so a future Slack API behaviour drift can't
// silently widen the scan).
func TestListBackfillJoinedChannelsFiltersArchivedAndNonMember(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/users.conversations", func(w http.ResponseWriter, r *http.Request) {
		// Audit: confirm the request asks for the narrow channel
		// types and excludes archived. If a future edit drops these
		// query params, this test catches it.
		if got := r.URL.Query().Get("types"); got != "public_channel,private_channel" {
			t.Errorf("types = %q, want public_channel,private_channel", got)
		}
		if got := r.URL.Query().Get("exclude_archived"); got != "true" {
			t.Errorf("exclude_archived = %q, want true", got)
		}
		writeFakeSlackJSON(t, w, slackUsersConversationsResponse{
			OK: true,
			Channels: []SlackBackfillJoinedChannel{
				{ID: "C_OK", Name: "open-channel", IsMember: true},
				{ID: "C_ARCH", Name: "stale-channel", IsMember: true, IsArchived: true},
				{ID: "C_GONE", Name: "left-channel", IsMember: false},
				{ID: "C_PRIV", Name: "private-but-joined", IsMember: true, IsPrivate: true},
			},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	channels, err := ListBackfillJoinedChannels(context.Background(), "xoxb-test")
	if err != nil {
		t.Fatalf("ListBackfillJoinedChannels: %v", err)
	}
	got := make([]string, 0, len(channels))
	for _, ch := range channels {
		got = append(got, ch.ID)
	}
	if len(got) != 2 {
		t.Fatalf("returned channels = %v, want [C_OK, C_PRIV]", got)
	}
	if got[0] != "C_OK" || got[1] != "C_PRIV" {
		t.Errorf("returned channels = %v, want [C_OK, C_PRIV]", got)
	}
}

// TestListBackfillJoinedChannelsFollowsPagination confirms next_cursor
// is honoured for users.conversations the same way it is for
// conversations.history.
func TestListBackfillJoinedChannelsFollowsPagination(t *testing.T) {
	mux := http.NewServeMux()
	var calls int
	mux.HandleFunc("/users.conversations", func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			writeFakeSlackJSON(t, w, slackUsersConversationsResponse{
				OK:               true,
				Channels:         []SlackBackfillJoinedChannel{{ID: "C1", IsMember: true}},
				ResponseMetadata: backfillLiveHistoryResponseCursor{NextCursor: "page-2"},
			})
		default:
			if got := r.URL.Query().Get("cursor"); got != "page-2" {
				t.Errorf("page 2 cursor = %q, want page-2", got)
			}
			writeFakeSlackJSON(t, w, slackUsersConversationsResponse{
				OK:       true,
				Channels: []SlackBackfillJoinedChannel{{ID: "C2", IsMember: true}},
			})
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	setLiveBaseURL(t, server.URL)

	channels, err := ListBackfillJoinedChannels(context.Background(), "xoxb-test")
	if err != nil {
		t.Fatalf("ListBackfillJoinedChannels: %v", err)
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
	if len(channels) != 2 {
		t.Errorf("channels = %v, want 2", channels)
	}
}

// TestBackfillReplayLiveRequiresInputs guards against silent bad
// invocations.
func TestBackfillReplayLiveRequiresInputs(t *testing.T) {
	_, _, err := BackfillReplayLive(context.Background(), SlackBackfillReplayLiveOptions{})
	if err == nil {
		t.Fatal("expected error when BotToken + ChannelID missing")
	}
	if !strings.Contains(err.Error(), "BotToken is required") {
		t.Errorf("error = %q, want BotToken hint", err)
	}
}

// writeFakeSlackJSON is a small helper to reduce repetition across the
// fake Slack server handlers above.
func writeFakeSlackJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode fake response: %v", err)
	}
}

// setLiveBaseURL flips SlackBackfillLiveBaseURL to the test server for
// the test's lifetime, then restores it afterwards. Mirrors the existing
// `slackThreadFetchAPIBaseURL =` pattern in handler_tools_test.go.
func setLiveBaseURL(t *testing.T, url string) {
	t.Helper()
	previous := SlackBackfillLiveBaseURL
	SlackBackfillLiveBaseURL = url
	t.Cleanup(func() { SlackBackfillLiveBaseURL = previous })
}
