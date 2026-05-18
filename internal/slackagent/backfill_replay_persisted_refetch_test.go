package slackagent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// TestFilterBackfillFollowupsByAgeSplitsOnCutoff pins the TTL
// contract: followups whose last-known-touch is older than maxAge
// move to `expired`; the rest stay in `kept`.
func TestFilterBackfillFollowupsByAgeSplitsOnCutoff(t *testing.T) {
	now := time.Date(2026, 5, 18, 17, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{ID: 1, UpdatedAt: now.Add(-12 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 2, UpdatedAt: now.Add(-71 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 3, UpdatedAt: now.Add(-73 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 4, UpdatedAt: now.Add(-200 * time.Hour).Format(time.RFC3339Nano)},
	}
	kept, expired := FilterBackfillFollowupsByAge(followups, 72*time.Hour, now)
	if len(kept) != 2 {
		t.Fatalf("kept len = %d, want 2 (ids 1+2)", len(kept))
	}
	if len(expired) != 2 {
		t.Fatalf("expired len = %d, want 2 (ids 3+4)", len(expired))
	}
}

// TestFilterBackfillFollowupsByAgeZeroMaxAgeKeepsAll: --persistence-max-age 0
// means "don't expire anything".
func TestFilterBackfillFollowupsByAgeZeroMaxAgeKeepsAll(t *testing.T) {
	now := time.Now()
	followups := []SlackHeartbeatFollowup{
		{ID: 1, UpdatedAt: now.Add(-9999 * time.Hour).Format(time.RFC3339Nano)},
	}
	kept, expired := FilterBackfillFollowupsByAge(followups, 0, now)
	if len(kept) != 1 || len(expired) != 0 {
		t.Fatalf("kept=%d expired=%d, want kept=1 expired=0", len(kept), len(expired))
	}
}

// TestFilterBackfillFollowupsByAgeFallsBackToLastSurfaced: priority
// is freshest-of(UpdatedAt, LastSurfacedAt, CreatedAt).
func TestFilterBackfillFollowupsByAgeFallsBackToLastSurfaced(t *testing.T) {
	now := time.Date(2026, 5, 18, 17, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{
			ID:             1,
			CreatedAt:      now.Add(-200 * time.Hour).Format(time.RFC3339Nano),
			LastSurfacedAt: now.Add(-1 * time.Hour).Format(time.RFC3339Nano),
		},
	}
	kept, expired := FilterBackfillFollowupsByAge(followups, 72*time.Hour, now)
	if len(kept) != 1 || len(expired) != 0 {
		t.Fatalf("kept=%d expired=%d; should keep because LastSurfacedAt is fresh", len(kept), len(expired))
	}
}

// TestFilterBackfillFollowupsByAgeKeepsRecordsWithNoParsableTime:
// defensive — unparsable timestamps don't auto-expire.
func TestFilterBackfillFollowupsByAgeKeepsRecordsWithNoParsableTime(t *testing.T) {
	now := time.Now()
	followups := []SlackHeartbeatFollowup{
		{ID: 1, UpdatedAt: "garbage-not-a-timestamp"},
	}
	kept, expired := FilterBackfillFollowupsByAge(followups, 72*time.Hour, now)
	if len(kept) != 1 || len(expired) != 0 {
		t.Fatalf("kept=%d expired=%d; unparsable timestamps should keep the record", len(kept), len(expired))
	}
}

// TestMergeAndRefetchPersistedNilRefetcherFallsBack confirms that
// callers without a Slack token (e.g. NDJSON-only CLI mode) keep the
// pre-existing MergePersistedDelayedNoReply behavior unchanged.
func TestMergeAndRefetchPersistedNilRefetcherFallsBack(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 1, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C1", ThreadTS: "100.000",
			Title: "补一下", Summary: "summary text", Metadata: map[string]any{"classification": "unanswered_question"}},
	}
	merged, superseded := MergeAndRefetchPersistedDelayedNoReply(context.Background(), nil, followups, nil)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1", len(merged))
	}
	if superseded != nil {
		t.Fatalf("superseded should be nil when refetcher is nil, got %v", superseded)
	}
}

// TestMergeAndRefetchPersistedDropsHumanRepliedFollowups is the core
// Peng-asked behavior: a persisted followup whose thread has since
// gotten a human reply must NOT appear in the report. The merger
// returns the followup in `superseded` so the caller can resolve it.
func TestMergeAndRefetchPersistedDropsHumanRepliedFollowups(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 7, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C1", ThreadTS: "100.000",
			Title: "补一下", Summary: "summary", UpdatedAt: "2026-05-18T15:00:00Z",
			Metadata: map[string]any{"classification": "unanswered_question"}},
	}
	refetcher := func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		if channelID != "C1" || threadTS != "100.000" {
			t.Fatalf("refetcher called with channel=%q thread=%q, want C1/100.000", channelID, threadTS)
		}
		return BackfillPersistedRefetchResult{HumanRepliedAfter: true, NewestHumanReplyTS: "200.000"}
	}
	merged, superseded := MergeAndRefetchPersistedDelayedNoReply(context.Background(), nil, followups, refetcher)
	if len(merged) != 0 {
		t.Errorf("merged len = %d, want 0 (human replied → dropped)", len(merged))
	}
	if len(superseded) != 1 || superseded[0].ID != 7 {
		t.Fatalf("superseded = %v, want followup id=7", superseded)
	}
}

// TestMergeAndRefetchPersistedKeepsCleanFollowups confirms the
// "no human reply yet" verdict: the candidate surfaces but the
// caller (driver's quality-gate work) is responsible for marking it
// `needs_agent_read` / `needs_thread_refetch_done` per renderer rules.
func TestMergeAndRefetchPersistedKeepsCleanFollowups(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 9, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C2", ThreadTS: "200.000",
			Title: "补一下分享", Summary: "summary about PDF",
			Metadata: map[string]any{"classification": "link_followup_candidate"}},
	}
	refetcher := func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		return BackfillPersistedRefetchResult{HumanRepliedAfter: false}
	}
	merged, superseded := MergeAndRefetchPersistedDelayedNoReply(context.Background(), nil, followups, refetcher)
	if len(superseded) != 0 {
		t.Errorf("superseded = %v, want empty when no human replied", superseded)
	}
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1", len(merged))
	}
	if !merged[0].FromPersistedState {
		t.Errorf("FromPersistedState = false, want true")
	}
	if merged[0].FollowupID != 9 {
		t.Errorf("FollowupID = %d, want 9", merged[0].FollowupID)
	}
}

// TestMergeAndRefetchPersistedKeepsCandidateWhenRefetchFails ensures
// a transient Slack failure does not silently drop the candidate.
// Better to over-surface (operator sees it + the renderer can flag
// `needs_thread_refetch`) than to silently lose track.
func TestMergeAndRefetchPersistedKeepsCandidateWhenRefetchFails(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 11, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C3", ThreadTS: "300.000",
			Title: "补一下", Summary: "summary", Metadata: map[string]any{"classification": "stuck_or_handoff"}},
	}
	refetcher := func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		return BackfillPersistedRefetchResult{RefetchFailed: true, Error: errors.New("rate limited")}
	}
	merged, superseded := MergeAndRefetchPersistedDelayedNoReply(context.Background(), nil, followups, refetcher)
	if len(superseded) != 0 {
		t.Errorf("refetch failure must not move followup to superseded; got %v", superseded)
	}
	if len(merged) != 1 {
		t.Fatalf("refetch failure must keep candidate; got len=%d", len(merged))
	}
}

// TestMergeAndRefetchPersistedSkipsOverlapWithFresh confirms the
// (channel, thread, classification) dedupe with the fresh scan still
// works under refetch: when the fresh scan already saw the thread,
// the refetcher is NOT called (the fresh result is the authoritative
// snapshot). The fresh candidate gets FromPersistedState=true.
func TestMergeAndRefetchPersistedSkipsOverlapWithFresh(t *testing.T) {
	fresh := []SlackBackfillCandidate{
		{ChannelID: "C4", ThreadTS: "400.000", Classification: "unanswered_question",
			Title: "fresh title", Draft: "fresh draft", OriginalText: "fresh root text"},
	}
	followups := []SlackHeartbeatFollowup{
		{ID: 13, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C4", ThreadTS: "400.000",
			Title: "persisted title", Summary: "persisted summary",
			Metadata: map[string]any{"classification": "unanswered_question"}},
	}
	refetcherCalled := false
	refetcher := func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		refetcherCalled = true
		return BackfillPersistedRefetchResult{}
	}
	merged, _ := MergeAndRefetchPersistedDelayedNoReply(context.Background(), fresh, followups, refetcher)
	if refetcherCalled {
		t.Error("refetcher should not be called when fresh scan already covers the thread")
	}
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1 (no duplication)", len(merged))
	}
	if !merged[0].FromPersistedState {
		t.Error("overlap candidate should carry FromPersistedState=true")
	}
	if merged[0].FollowupID != 13 {
		t.Error("overlap candidate should carry FollowupID")
	}
	if !strings.Contains(merged[0].Draft, "fresh draft") {
		t.Errorf("overlap must keep fresh draft, got %q", merged[0].Draft)
	}
}

// TestMergeAndRefetchPersistedSkipsLowValueBeforeRefetch protects the
// refetch budget: low-value followups (GitHub PR review pings,
// X/Twitter status) are dropped via persistedFollowupLooksLowValueForBackfill
// BEFORE the refetcher is called. No point spending Slack API
// quota verifying threads we wouldn't post to anyway.
func TestMergeAndRefetchPersistedSkipsLowValueBeforeRefetch(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 15, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C5", ThreadTS: "500.000",
			Title:    "补读这条分享",
			Summary:  "<https://github.com/AFK-surf/cueboard/pull/1917> <@U123> 来 review",
			Metadata: map[string]any{"classification": "link_followup_candidate"}},
	}
	refetcherCalled := false
	refetcher := func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		refetcherCalled = true
		return BackfillPersistedRefetchResult{}
	}
	merged, _ := MergeAndRefetchPersistedDelayedNoReply(context.Background(), nil, followups, refetcher)
	if refetcherCalled {
		t.Error("low-value PR review followup must not trigger refetch")
	}
	if len(merged) != 0 {
		t.Errorf("low-value followup should be filtered before merge; got len=%d", len(merged))
	}
}
