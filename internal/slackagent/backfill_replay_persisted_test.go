package slackagent

import (
	"strings"
	"testing"
)

// TestMergePersistedDelayedNoReplyOverlapKeepsFreshDraftSetsFlag pins
// the driver-locked rule for the overlap case: if a backfill scan
// found a candidate AND a persisted #186 followup matches the same
// dedupe key, the fresh draft wins (it had channel history context),
// but FromPersistedState flips true so the report cites the live
// state.
func TestMergePersistedDelayedNoReplyOverlapKeepsFreshDraftSetsFlag(t *testing.T) {
	fresh := []SlackBackfillCandidate{
		{
			ChannelID:      "C1",
			ThreadTS:       "100.000",
			Classification: "stuck_or_handoff",
			Title:          "Original title",
			Draft:          "Fresh draft text built from channel history.",
			OriginalText:   "CI 在 main 整体卡住了，要不要看一下？",
		},
	}
	followups := []SlackHeartbeatFollowup{
		{
			ID:        77,
			Kind:      slackDelayedNoReplyFollowupKind,
			ChannelID: "C1",
			ThreadTS:  "100.000",
			Title:     "Persisted title (should be IGNORED for overlap)",
			Summary:   "Persisted summary (should be IGNORED for overlap)",
			Metadata: map[string]any{
				"classification": "stuck_or_handoff",
			},
		},
	}

	merged := MergePersistedDelayedNoReply(fresh, followups)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1 (overlap should not duplicate)", len(merged))
	}
	if !merged[0].FromPersistedState {
		t.Errorf("FromPersistedState = false, want true after overlap merge")
	}
	if merged[0].FollowupID != 77 {
		t.Errorf("FollowupID = %d, want 77", merged[0].FollowupID)
	}
	if !strings.Contains(merged[0].Draft, "Fresh draft text") {
		t.Errorf("Draft = %q, want it to keep the fresh-scan draft", merged[0].Draft)
	}
	if strings.Contains(merged[0].Draft, "Persisted summary") {
		t.Errorf("Draft = %q; overlap must NOT overwrite with persisted summary", merged[0].Draft)
	}
}

// TestMergePersistedDelayedNoReplyPersistedOnlyUsesFollowupTitleSummary
// is the regression for driver's explicit guidance: "persisted-only
// 候选出来时，draft/summary 要用 followup 的 Title/Summary，不要硬造新摘要".
func TestMergePersistedDelayedNoReplyPersistedOnlyUsesFollowupTitleSummary(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{
			ID:        42,
			Kind:      slackDelayedNoReplyFollowupKind,
			ChannelID: "C9",
			ThreadTS:  "999.000",
			Title:     "补一下这个开放问题",
			Summary:   "补一下这条：我理解是在问\"我们要不要回滚 canvas writes 的发布？\"。我的初步判断...",
			Metadata: map[string]any{
				"classification": "unanswered_question",
			},
		},
	}

	merged := MergePersistedDelayedNoReply(nil, followups)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1", len(merged))
	}
	c := merged[0]
	if !c.FromPersistedState {
		t.Error("FromPersistedState = false, want true")
	}
	if c.OriginalText != "" {
		t.Errorf("OriginalText = %q, want empty (persisted-only has no fresh root)", c.OriginalText)
	}
	if c.Title != "补一下这个开放问题" {
		t.Errorf("Title = %q, want followup.Title verbatim", c.Title)
	}
	if !strings.Contains(c.Draft, "我的初步判断") {
		t.Errorf("Draft = %q, want followup.Summary verbatim", c.Draft)
	}
	if c.Classification != "unanswered_question" {
		t.Errorf("Classification = %q, want unanswered_question from metadata", c.Classification)
	}
	if c.FollowupID != 42 {
		t.Errorf("FollowupID = %d, want 42", c.FollowupID)
	}
	if c.ReviewStatus != BackfillReviewNeedsThreadRefetch {
		t.Errorf("ReviewStatus = %q, want %s", c.ReviewStatus, BackfillReviewNeedsThreadRefetch)
	}
}

func TestMergePersistedDelayedNoReplySkipsLowValuePersistedLinkFollowups(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{
			ID:        11,
			Kind:      slackDelayedNoReplyFollowupKind,
			ChannelID: "C1",
			ThreadTS:  "100.000",
			Title:     "补读这条分享",
			Summary:   "补一下这条分享：<https://github.com/AFK-surf/cueboard/pull/1917> <@U123> 来 review，没问题就 approve",
			Metadata:  map[string]any{"classification": "link_followup_candidate"},
		},
		{
			ID:        12,
			Kind:      slackDelayedNoReplyFollowupKind,
			ChannelID: "C1",
			ThreadTS:  "101.000",
			Title:     "补读这条分享",
			Summary:   "补一下这条分享：https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf",
			Metadata:  map[string]any{"classification": "link_followup_candidate"},
		},
	}

	merged := MergePersistedDelayedNoReply(nil, followups)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want only the readable PDF followup", len(merged))
	}
	if merged[0].FollowupID != 12 {
		t.Fatalf("surviving FollowupID = %d, want 12", merged[0].FollowupID)
	}
}

// TestMergePersistedDelayedNoReplyKeysOnClassificationToAvoidWrongMerge
// is the regression for the (channel, thread, **classification**) key
// design: two persisted followups in the same thread but with
// different classifications must NOT be collapsed. This case is rare
// but possible (driver flagged it in the design lock).
func TestMergePersistedDelayedNoReplyKeysOnClassificationToAvoidWrongMerge(t *testing.T) {
	fresh := []SlackBackfillCandidate{
		{
			ChannelID:      "C1",
			ThreadTS:       "100.000",
			Classification: "unanswered_question",
			Title:          "Q",
			Draft:          "draft Q",
		},
	}
	followups := []SlackHeartbeatFollowup{
		{
			ID: 1, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C1", ThreadTS: "100.000",
			Title: "stuck", Summary: "stuck summary",
			Metadata: map[string]any{"classification": "stuck_or_handoff"},
		},
	}
	merged := MergePersistedDelayedNoReply(fresh, followups)
	if len(merged) != 2 {
		t.Fatalf("merged len = %d, want 2 (different classifications must NOT merge)", len(merged))
	}
}

// TestMergePersistedDelayedNoReplySkipsResolvedFollowups confirms that
// followups that have already been resolved/dismissed do not re-surface
// in the backfill report.
func TestMergePersistedDelayedNoReplySkipsResolvedFollowups(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{
			ID: 1, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C1", ThreadTS: "100.000",
			Status: "resolved", Title: "old", Summary: "old",
		},
	}
	// We test the filter through the higher-level loader contract via
	// `isResolvedFollowupStatus` (the loader filters before merge).
	if !isResolvedFollowupStatus("resolved") {
		t.Fatal("resolved must be treated as inactive")
	}
	if !isResolvedFollowupStatus("dismissed") {
		t.Fatal("dismissed must be treated as inactive")
	}
	if isResolvedFollowupStatus("") {
		t.Fatal("empty status must be treated as active (newly created)")
	}
	if isResolvedFollowupStatus("scheduled") {
		t.Fatal("scheduled must be treated as active")
	}
	_ = followups
}

// TestMergePersistedDelayedNoReplyDefaultsMissingClassification covers
// the safety fallback when a persisted record's `metadata.classification`
// is missing: rather than discarding the record entirely, we slot it
// under `synthesis_eligible_thread` so it still gets reviewed.
func TestMergePersistedDelayedNoReplyDefaultsMissingClassification(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{
			ID: 1, Kind: slackDelayedNoReplyFollowupKind, ChannelID: "C1", ThreadTS: "100.000",
			Title: "no metadata", Summary: "no metadata",
		},
	}
	merged := MergePersistedDelayedNoReply(nil, followups)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1", len(merged))
	}
	if merged[0].Classification != "synthesis_eligible_thread" {
		t.Errorf("default classification = %q, want synthesis_eligible_thread", merged[0].Classification)
	}
}

// TestMergePersistedDelayedNoReplySkipsMalformedRecords protects
// against followups with missing channel/thread anchors that we cannot
// dedupe against. These should be dropped silently — the live triage
// shouldn't produce them, but defensive filtering keeps the report
// honest.
func TestMergePersistedDelayedNoReplySkipsMalformedRecords(t *testing.T) {
	followups := []SlackHeartbeatFollowup{
		{ID: 1, ChannelID: "", ThreadTS: "100.000"},
		{ID: 2, ChannelID: "C1", ThreadTS: ""},
		{ID: 3, ChannelID: "C1", ThreadTS: "200.000", Title: "ok", Summary: "ok"},
	}
	merged := MergePersistedDelayedNoReply(nil, followups)
	if len(merged) != 1 {
		t.Fatalf("merged len = %d, want 1 (malformed should be dropped)", len(merged))
	}
	if merged[0].FollowupID != 3 {
		t.Errorf("only valid followup should survive, got FollowupID=%d", merged[0].FollowupID)
	}
}

// TestRenderBackfillCandidatesMarkdownLabelsSource is the
// driver-audit-required source-label regression: the rendered report
// must show `fresh`, `persisted+fresh`, and `persisted` labels so the
// operator can sort by trust signal at a glance.
func TestRenderBackfillCandidatesMarkdownLabelsSource(t *testing.T) {
	out := RenderBackfillCandidatesMarkdown([]SlackBackfillCandidate{
		{ChannelID: "C1", ThreadTS: "1", Classification: "k", Title: "a", Draft: "d", OriginalText: "scan saw this"},
		{ChannelID: "C2", ThreadTS: "2", Classification: "k", Title: "b", Draft: "d", OriginalText: "scan saw this", FromPersistedState: true, FollowupID: 7},
		{ChannelID: "C3", ThreadTS: "3", Classification: "k", Title: "c", Draft: "d", FromPersistedState: true, FollowupID: 8},
	})
	if !strings.Contains(out, "`fresh` (backfill scan only)") {
		t.Errorf("missing fresh source label:\n%s", out)
	}
	if !strings.Contains(out, "`persisted+fresh`") {
		t.Errorf("missing persisted+fresh source label:\n%s", out)
	}
	if !strings.Contains(out, "`persisted` (only #186 state") {
		t.Errorf("missing persisted-only source label:\n%s", out)
	}
	if !strings.Contains(out, "**Followup ID**: 7") {
		t.Errorf("missing FollowupID for persisted+fresh:\n%s", out)
	}
	if !strings.Contains(out, "**Followup ID**: 8") {
		t.Errorf("missing FollowupID for persisted-only:\n%s", out)
	}
	if !strings.Contains(out, "**Quality gate**: `needs_thread_refetch`") {
		t.Errorf("persisted-only candidate should require thread refetch:\n%s", out)
	}
	if !strings.Contains(out, "no fresh scan match") {
		t.Errorf("persisted-only candidate should explain missing OriginalText:\n%s", out)
	}
}
