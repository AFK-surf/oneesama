package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// Slice 3 piece A: read driver's persisted `delayed_no_reply` followups
// and merge them into the fresh backfill candidate list, deduplicating
// by the agreed key from the slice-3 design thread:
//
//	(channelID, threadRootTS, classification)
//
// Driver-locked semantics:
//   - Overlap (fresh candidate + persisted followup match the key):
//     keep the fresh candidate's Draft (built from real channel
//     history), but flip FromPersistedState=true and carry FollowupID
//     so the report can correlate.
//   - Persisted-only (followup exists, backfill scan missed the root):
//     synthesize a candidate using the followup's Title + Summary
//     VERBATIM. We do NOT re-classify or paraphrase — the live triage
//     already wrote those with full thread context, and a backfill
//     report should respect that authority.

// LoadDelayedNoReplyFollowups opens the runtime's
// `slack_heartbeat_followups` typed collection in read-only-ish mode
// (the persistence API doesn't distinguish read from write, but this
// caller never mutates) and returns only those entries with
// `Kind == "delayed_no_reply"` whose status is still active
// (`scheduled` or empty — closed/dismissed entries are not re-surfaced).
//
// The function is intentionally a thin wrapper around
// `persistence.OpenTyped` so the CLI can call it without constructing a
// full slackagent Service. Slice 3 piece A's whole point is to read
// the live runtime's state from a stand-alone process.
func LoadDelayedNoReplyFollowups(ctx context.Context, cfg appconfig.PersistenceConfig) ([]SlackHeartbeatFollowup, error) {
	store, err := persistence.OpenTyped[SlackHeartbeatFollowup](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackHeartbeatFollowupsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		return nil, fmt.Errorf("open slack_heartbeat_followups collection: %w", err)
	}
	records, err := store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list heartbeat followups: %w", err)
	}
	filtered := make([]SlackHeartbeatFollowup, 0, len(records))
	for _, record := range records {
		if !strings.EqualFold(record.Kind, slackDelayedNoReplyFollowupKind) {
			continue
		}
		if isResolvedFollowupStatus(record.Status) {
			continue
		}
		filtered = append(filtered, record)
	}
	return filtered, nil
}

// isResolvedFollowupStatus mirrors the live triage convention:
// `resolved` / `dismissed` / `cancelled` followups are no longer
// "we still owe a reply to this thread". An empty status (newly
// created, not yet acted on) counts as active.
func isResolvedFollowupStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "", "scheduled", "active", "open":
		return false
	default:
		return true
	}
}

// MergePersistedDelayedNoReply implements the dedupe rule driver and
// I agreed on in #185 slice 3 thread. It is a pure function — the CLI
// passes in the fresh candidate list it just produced and the
// followups it just loaded, gets back a merged list ready to render.
func MergePersistedDelayedNoReply(fresh []SlackBackfillCandidate, followups []SlackHeartbeatFollowup) []SlackBackfillCandidate {
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
			out[i].FromPersistedState = true
			out[i].FollowupID = followup.ID
			continue
		}
		out = append(out, SlackBackfillCandidate{
			ChannelID:          channel,
			ThreadTS:           thread,
			OriginatorTS:       thread,
			Classification:     classification,
			Title:              strings.TrimSpace(followup.Title),
			Draft:              strings.TrimSpace(followup.Summary),
			OriginalText:       "",
			FromPersistedState: true,
			FollowupID:         followup.ID,
		})
	}
	return out
}

func persistedFollowupLooksLowValueForBackfill(followup SlackHeartbeatFollowup, classification string) bool {
	if !strings.EqualFold(strings.TrimSpace(classification), "link_followup_candidate") {
		return false
	}
	text := strings.TrimSpace(followup.Summary + "\n" + followup.Title)
	if text == "" {
		return false
	}
	return backfillMessageHasLowValueLinkOnly(SlackInboundMessage{Text: text})
}

// backfillCandidateDedupeKey is the canonical (channel, thread,
// classification) key used for both lookups. Whitespace is trimmed
// and case is normalized so persisted "STALE_WAIT_FOR_HUMAN" matches
// fresh "stale_wait_for_human" — Slack id casing has never been a
// problem but the classification labels travel through enough hands
// to make defensive normalization worth one line.
func backfillCandidateDedupeKey(channelID, threadTS, classification string) string {
	return strings.ToLower(strings.TrimSpace(channelID)) + ":" +
		strings.TrimSpace(threadTS) + ":" +
		strings.ToLower(strings.TrimSpace(classification))
}

// persistedFollowupClassification reads the classification label the
// live triage stored on a followup. Driver's #186 writes it under
// `metadata.classification`; we fall back to a generic bucket if the
// metadata is missing so the dedupe key is still computable.
func persistedFollowupClassification(followup SlackHeartbeatFollowup) string {
	if followup.Metadata != nil {
		if raw, ok := followup.Metadata["classification"]; ok {
			if str := strings.TrimSpace(stringFromAny(raw)); str != "" {
				return str
			}
		}
	}
	return "synthesis_eligible_thread"
}
