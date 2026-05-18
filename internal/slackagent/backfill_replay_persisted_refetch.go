package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// DefaultBackfillPersistedMaxAge is how stale a persisted
// delayed_no_reply followup can be before the backfill treats it as
// `expired` (caller resolves it as `done` with reason `expired`).
// 72h chosen so weekend-old followups still get one verify pass on
// Monday morning, but week-old followups stop polluting the report.
const DefaultBackfillPersistedMaxAge = 72 * time.Hour

// FilterBackfillFollowupsByAge splits a list of persisted followups
// into (kept, expired) by record age. `expired` is everything whose
// last-known activity (UpdatedAt, falling back to LastSurfacedAt,
// then CreatedAt) is older than `maxAge` relative to `now`. The
// returned slices share no aliasing with the input — caller is free
// to mutate either.
//
// Pure function so unit tests do not have to pin a persistence
// backend; the CLI wraps it after LoadDelayedNoReplyFollowups.
func FilterBackfillFollowupsByAge(followups []SlackHeartbeatFollowup, maxAge time.Duration, now time.Time) (kept, expired []SlackHeartbeatFollowup) {
	if maxAge <= 0 {
		return append([]SlackHeartbeatFollowup(nil), followups...), nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	cutoff := now.Add(-maxAge)
	for _, followup := range followups {
		ref := backfillFollowupLastTouch(followup)
		if ref.IsZero() || ref.After(cutoff) {
			kept = append(kept, followup)
			continue
		}
		expired = append(expired, followup)
	}
	return kept, expired
}

// backfillFollowupLastTouch returns the most-recent timestamp known
// for a followup, picking the freshest of UpdatedAt / LastSurfacedAt /
// CreatedAt. Returns zero time if none parse — caller treats that as
// "no age info" and keeps the followup.
func backfillFollowupLastTouch(followup SlackHeartbeatFollowup) time.Time {
	var newest time.Time
	for _, candidate := range []string{followup.UpdatedAt, followup.LastSurfacedAt, followup.CreatedAt} {
		parsed := parseHeartbeatTime(candidate)
		if parsed == nil {
			continue
		}
		if newest.IsZero() || parsed.After(newest) {
			newest = *parsed
		}
	}
	return newest
}

// BackfillResolveDelayedNoReplyFollowups marks the given followups as
// resolved with the given reason (`expired`, `superseded_by_human`,
// etc.). Opens the runtime store with the standard typed-collection
// helper, mutates each matching record, and returns the count of
// records that were actually written.
//
// Write-side complement to LoadDelayedNoReplyFollowups (read-only).
// Slice 3 piece A's `MergeAndRefetchPersisted` returns a `superseded`
// slice for the caller to feed here; the new TTL filter does the
// same for `expired`.
//
// Failure to open the store or to write individual records is
// returned as a non-nil error; the count reflects the records that
// were successfully written before the first failure.
func BackfillResolveDelayedNoReplyFollowups(ctx context.Context, cfg appconfig.PersistenceConfig, followupIDs []int64, reason string) (int, error) {
	if len(followupIDs) == 0 {
		return 0, nil
	}
	store, err := persistence.OpenTyped[SlackHeartbeatFollowup](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackHeartbeatFollowupsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		return 0, fmt.Errorf("open slack_heartbeat_followups for resolve: %w", err)
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "resolved_by_backfill"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	count := 0
	for _, id := range followupIDs {
		record, ok, err := store.Get(ctx, heartbeatKey(id))
		if err != nil {
			return count, fmt.Errorf("load followup %d: %w", id, err)
		}
		if !ok {
			continue
		}
		if isResolvedFollowupStatus(record.Status) {
			// Already resolved by another path; skip silently.
			continue
		}
		record.Status = "done"
		record.UpdatedAt = now
		if record.Metadata == nil {
			record.Metadata = map[string]any{}
		}
		record.Metadata["resolution"] = reason
		if err := store.Set(ctx, heartbeatKey(id), normalizeHeartbeatFollowup(record)); err != nil {
			return count, fmt.Errorf("resolve followup %d: %w", id, err)
		}
		count++
	}
	return count, nil
}

// NewBackfillSlackRefetcher builds a BackfillPersistedRefetcher backed
// by Slack's `conversations.replies` API + the standard
// `isAuthoredByBot` rule. CLI callers wire this in when a live bot
// token is available so persisted-only candidates get verified before
// they appear in the report.
//
// The returned refetcher:
//   - Calls `fetchRepliesFor` (the same path BackfillReplayLive uses).
//   - Marks HumanRepliedAfter=true if any non-bot reply has TS newer
//     than sinceTS.
//   - Marks RefetchFailed=true with the underlying error on transient
//     failure; callers keep the candidate in that case so the operator
//     can re-check.
//
// botUserIDs are passed to `isAuthoredByBot` so the bot's own posts
// don't accidentally count as "human caught it" — same semantic as
// the live triage freshness check.
func NewBackfillSlackRefetcher(token string, botUserIDs []string) BackfillPersistedRefetcher {
	if strings.TrimSpace(token) == "" {
		return nil
	}
	return func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult {
		stats := SlackBackfillReplayLiveStats{}
		replies, err := fetchRepliesFor(ctx, token, channelID, threadTS, &stats)
		if err != nil {
			return BackfillPersistedRefetchResult{
				RefetchFailed: true,
				Error:         fmt.Errorf("conversations.replies refetch %s/%s: %w", channelID, threadTS, err),
			}
		}
		var newest string
		for _, reply := range replies {
			ts := firstNonEmpty(reply.TS, reply.EventTS)
			if !slackTSGreater(ts, sinceTS) {
				continue
			}
			if isAuthoredByBot(reply, botUserIDs) {
				continue
			}
			if slackTSGreater(ts, newest) {
				newest = ts
			}
		}
		if newest != "" {
			return BackfillPersistedRefetchResult{
				HumanRepliedAfter:  true,
				NewestHumanReplyTS: newest,
			}
		}
		return BackfillPersistedRefetchResult{}
	}
}

// Backfill refetch path for persisted delayed_no_reply followups.
//
// Why this exists (per Peng's 5/18 critique at 16:42-16:49):
// the report's first version of persisted-only candidates rendered the
// stored Summary verbatim as a "Draft reply", which made stale or
// already-answered followups look postable. Peng's framing:
// **persisted state is a lead, not a candidate**. Before we put a
// persisted followup back into a review report, the backfill must
// re-check the underlying Slack thread:
//
//   - If a human already replied → resolve the followup as
//     `superseded_by_human` and DROP it from the report. The live
//     triage's delayed_no_reply path will catch this on its next tick
//     too, but the backfill should not leave the stale entry showing.
//   - If no human reply yet → the followup graduates to a fresh-like
//     candidate. The caller (driver's #188 quality-gate work) will
//     then run the full link-synthesis or LLM-draft path on the
//     verified thread, instead of trusting the stored Summary.
//
// This file is intentionally additive: `MergePersistedDelayedNoReply`
// (in backfill_replay_persisted.go) is left unchanged for callers
// that have no Slack token. The CLI's `--live` path uses
// `MergeAndRefetchPersistedDelayedNoReply` instead.

// BackfillPersistedRefetcher is the per-thread re-check the merger
// calls for every persisted followup. Implementations typically wrap
// `conversations.replies`. `sinceTS` is the followup's last-known
// activity timestamp (UpdatedAt / LastSurfacedAt); the implementation
// only needs to scan replies newer than that.
type BackfillPersistedRefetcher func(ctx context.Context, channelID, threadTS, sinceTS string) BackfillPersistedRefetchResult

// BackfillPersistedRefetchResult is the per-thread refetch verdict.
// Exactly one of HumanRepliedAfter / RefetchFailed is meaningful when
// Error == nil; on Error != nil the caller treats the thread as
// "could not verify" and keeps the candidate but flags it as
// needing manual re-check.
type BackfillPersistedRefetchResult struct {
	// HumanRepliedAfter is true when at least one non-bot reply with
	// TS > sinceTS was found. This means a human caught the thread
	// and the persisted followup is no longer "still owed".
	HumanRepliedAfter bool
	// NewestHumanReplyTS is the timestamp of the newest human reply
	// found (empty if HumanRepliedAfter is false). Useful for the
	// resolution audit trail.
	NewestHumanReplyTS string
	// RefetchFailed is true when the implementation could not fetch
	// the thread for whatever reason (auth, channel deleted, etc.).
	// Combined with `Error`, this tells the caller to keep the
	// candidate but flag it as unverifiable.
	RefetchFailed bool
	// Error is the underlying fetch error if any.
	Error error
}

// MergeAndRefetchPersistedDelayedNoReply extends
// MergePersistedDelayedNoReply by calling the refetcher for every
// persisted-only candidate before deciding whether to surface it.
// The returned slice of `SlackHeartbeatFollowup` lists records the
// caller should resolve as `superseded_by_human` (the merger does
// not have a store handle, so resolution is the caller's job).
//
// Refetcher contract:
//   - nil refetcher → behavior identical to MergePersistedDelayedNoReply.
//     Use this for stand-alone runs with no Slack token.
//   - non-nil refetcher → every persisted followup whose (channel,
//     thread) does not also appear in `fresh` is re-checked. If
//     refetch reports HumanRepliedAfter, the followup is added to
//     `superseded` and NOT to the returned candidate list.
func MergeAndRefetchPersistedDelayedNoReply(
	ctx context.Context,
	fresh []SlackBackfillCandidate,
	followups []SlackHeartbeatFollowup,
	refetcher BackfillPersistedRefetcher,
) (merged []SlackBackfillCandidate, superseded []SlackHeartbeatFollowup) {
	if refetcher == nil {
		return MergePersistedDelayedNoReply(fresh, followups), nil
	}

	out := make([]SlackBackfillCandidate, 0, len(fresh)+len(followups))
	freshIndex := make(map[string]int, len(fresh))
	for i := range fresh {
		out = append(out, fresh[i])
		freshIndex[backfillCandidateDedupeKey(out[i].ChannelID, out[i].ThreadTS, out[i].Classification)] = i
	}

	for _, followup := range followups {
		channel := strings.TrimSpace(followup.ChannelID)
		thread := strings.TrimSpace(followup.ThreadTS)
		classification := persistedFollowupClassification(followup)
		if channel == "" || thread == "" {
			continue
		}
		if persistedFollowupLooksLowValueForBackfill(followup, classification) {
			continue
		}

		key := backfillCandidateDedupeKey(channel, thread, classification)
		if i, ok := freshIndex[key]; ok {
			// Overlap with a fresh scan candidate: the fresh draft
			// wins; flag the persisted source. No refetch needed —
			// the fresh scan already saw the thread.
			out[i].FromPersistedState = true
			out[i].FollowupID = followup.ID
			continue
		}

		// Persisted-only: refetch before surfacing.
		sinceTS := firstNonEmpty(followup.LastSurfacedAt, followup.UpdatedAt, followup.CreatedAt)
		result := refetcher(ctx, channel, thread, sinceTS)
		if result.HumanRepliedAfter {
			superseded = append(superseded, followup)
			continue
		}

		// Either refetch succeeded with no human reply, OR refetch
		// failed (auth/channel-deleted/etc.). In either case the
		// candidate surfaces; the report renderer will mark it
		// appropriately. The caller can inspect result.Error for
		// the failure-specific subtype if needed.
		candidate := SlackBackfillCandidate{
			ChannelID:          channel,
			ThreadTS:           thread,
			OriginatorTS:       thread,
			Classification:     classification,
			Title:              strings.TrimSpace(followup.Title),
			Draft:              strings.TrimSpace(followup.Summary),
			OriginalText:       "",
			FromPersistedState: true,
			FollowupID:         followup.ID,
		}
		out = append(out, candidate)
	}
	return out, superseded
}
