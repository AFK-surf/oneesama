package slackagent

import "testing"

// TestSlackContextBudgetMatrix pins the centralised Slack thread / external-
// link context budgets (task #287). If a budget changes intentionally, update
// the table here and the matching `slack*BudgetChars` constant together; do
// not silently raise or lower a budget. Catches accidental edits like
// duplicating the same magic number at a new call site instead of reusing the
// named constant.
func TestSlackContextBudgetMatrix(t *testing.T) {
	cases := []struct {
		name  string
		value int
		want  int
	}{
		{"slackThreadContextBudgetChars", slackThreadContextBudgetChars, 6000},
		{"slackTriageDigestBudgetChars", slackTriageDigestBudgetChars, 4000},
		{"slackChannelContextBudgetChars", slackChannelContextBudgetChars, 4000},
		{"slackPreviousTriageContextBudgetChars", slackPreviousTriageContextBudgetChars, 3000},
		{"slackContextLastCommandBudgetChars", slackContextLastCommandBudgetChars, 4000},
		{"slackMemoryProviderTurnBudgetChars", slackMemoryProviderTurnBudgetChars, 4000},
		{"slackExternalLinkContextBudgetChars", slackExternalLinkContextBudgetChars, 4000},
		{"slackExternalLinkTitleBudgetChars", slackExternalLinkTitleBudgetChars, 240},
		{"slackExternalLinkExcerptBudgetChars", slackExternalLinkExcerptBudgetChars, 500},
		{"slackExternalLinkTextBudgetChars", slackExternalLinkTextBudgetChars, 1200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.value != tc.want {
				t.Fatalf("%s = %d, want %d (update context_budget.go and this test together)", tc.name, tc.value, tc.want)
			}
		})
	}
}
