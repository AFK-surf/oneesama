package slackagent

import (
	"strings"
	"testing"
)

// TestLooksLikeHandledTaskSummaryRejectsSkipOutcomes covers the canonical
// triage SKIP path: even when the bot wrote a summary, the ledger row should
// not be advertised to the assistant as a "recent handled task" because no
// action was actually taken.
func TestLooksLikeHandledTaskSummaryRejectsSkipOutcomes(t *testing.T) {
	cases := []struct {
		name   string
		ledger SlackThreadLedgerRecord
		want   bool
	}{
		{
			name:   "skip status",
			ledger: SlackThreadLedgerRecord{Summary: "follow-up question, no action.", LastActionType: "triage", LastActionStatus: "SKIP"},
			want:   false,
		},
		{
			name:   "failed status",
			ledger: SlackThreadLedgerRecord{Summary: "triage failed to parse", LastActionType: "triage", LastActionStatus: "failed"},
			want:   false,
		},
		{
			name:   "observed status",
			ledger: SlackThreadLedgerRecord{Summary: "channel chatter", LastActionType: "triage", LastActionStatus: "observed"},
			want:   false,
		},
		{
			name:   "summary starts with SKIP prefix",
			ledger: SlackThreadLedgerRecord{Summary: "SKIP: low signal social thread", LastActionType: "triage", LastActionStatus: "act"},
			want:   false,
		},
		{
			name:   "summary explicitly says no action",
			ledger: SlackThreadLedgerRecord{Summary: "No action needed; user already resolved.", LastActionType: "triage", LastActionStatus: "act"},
			want:   false,
		},
		{
			name:   "real handled action",
			ledger: SlackThreadLedgerRecord{Summary: "Routed user request to Linear LIN-42.", LastActionType: "create_issue", LastActionStatus: "confirmed"},
			want:   true,
		},
		{
			name:   "empty summary",
			ledger: SlackThreadLedgerRecord{Summary: "", LastActionType: "triage", LastActionStatus: "act"},
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := looksLikeHandledTaskSummary(&tc.ledger)
			if got != tc.want {
				t.Fatalf("looksLikeHandledTaskSummary() = %v, want %v (ledger=%+v)", got, tc.want, tc.ledger)
			}
		})
	}
}

// TestFormatSlackDurableContextDemotesSkipSummariesToThreadNote pins the
// downstream behavior in the assistant prompt: a SKIP-style ledger entry no
// longer appears as "recent handled task"; instead it shows up as a softer
// "recent thread note" line so prompt context retains the observation
// without misclassifying it.
func TestFormatSlackDurableContextDemotesSkipSummariesToThreadNote(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Summary:          "SKIP: dev bot stuck, no action.",
		LastActionType:   "triage",
		LastActionStatus: "SKIP",
		Status:           "active",
	}
	got := formatSlackDurableContext(ledger, nil, nil)
	if strings.Contains(got, "- recent handled task:") {
		t.Fatalf("expected SKIP summary to be demoted, but got handled-task line: %q", got)
	}
	if !strings.Contains(got, "- recent thread note: SKIP: dev bot stuck, no action.") {
		t.Fatalf("expected SKIP summary to surface as thread note, got: %q", got)
	}
}

// TestFormatSlackDurableContextKeepsHandledTaskForRealActions verifies the
// guard does not over-restrict — actual confirmed actions still surface as
// "recent handled task" so the assistant can lean on prior history.
func TestFormatSlackDurableContextKeepsHandledTaskForRealActions(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Summary:          "Routed user request to Linear LIN-42.",
		LastActionType:   "create_issue",
		LastActionStatus: "confirmed",
		Status:           "active",
	}
	got := formatSlackDurableContext(ledger, nil, nil)
	if !strings.Contains(got, "- recent handled task: Routed user request to Linear LIN-42.") {
		t.Fatalf("expected confirmed action to surface as handled task, got: %q", got)
	}
}

// TestFormatSlackDurableContextOmitsHandledTaskFallbackForSkipStatus pins the
// fallback branch: when there's no summary but the recorded action status is
// SKIP/observed/failed, the prompt should NOT print
// "recent handled task: triage (SKIP)" — that line was the original source
// of the "we already handled this" misclassification.
func TestFormatSlackDurableContextOmitsHandledTaskFallbackForSkipStatus(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Summary:          "",
		LastActionType:   "triage",
		LastActionStatus: "SKIP",
		Status:           "active",
	}
	got := formatSlackDurableContext(ledger, nil, nil)
	if strings.Contains(got, "recent handled task") {
		t.Fatalf("expected SKIP-only ledger to omit handled-task fallback, got: %q", got)
	}
}

// TestIsNoActionLedgerOutcomeCaseInsensitive guards against status casing
// drift between cueboard ("SKIP") and oneesama ("skip"). Both must map to
// the no-action bucket.
func TestIsNoActionLedgerOutcomeCaseInsensitive(t *testing.T) {
	for _, status := range []string{"SKIP", "skip", "Skip", "FAILED", "noop", "no-op", "observed"} {
		if !isNoActionLedgerOutcome(status) {
			t.Errorf("isNoActionLedgerOutcome(%q) = false, want true", status)
		}
	}
	for _, status := range []string{"confirmed", "act", "MAYBE", "completed"} {
		if isNoActionLedgerOutcome(status) {
			t.Errorf("isNoActionLedgerOutcome(%q) = true, want false", status)
		}
	}
}
