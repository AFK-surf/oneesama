package slackagent

import "testing"

func TestVisibleReplyQualityGateDropsFrameworkProtocolLeaks(t *testing.T) {
	t.Parallel()

	message := `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="openrouter_web_search">
<｜｜DSML｜｜parameter name="query" string="true">nitter.net thet8or</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`
	if got := slackVisibleReplyQualityBlockReason(message); got != "internal_control_plane_leak" {
		t.Fatalf("block reason = %q, want internal_control_plane_leak", got)
	}

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   message,
		ChannelID: "C123",
		ThreadTS:  "123.456",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://nitter.net/thet8or",
			Quote:     "profile excerpt",
		}},
	}
	if verdict := slackVisibleReplyAllowListVerdictForAction(action); verdict.Allowed || verdict.Reason != slackVisibleReplyAllowReasonInternalMeta {
		t.Fatalf("verdict = %#v, want internal-meta block despite anchor", verdict)
	}
	if actions := requireSlackTriageVisibleReplyApproval([]SlackTriageDecisionAction{action}); len(actions) != 0 {
		t.Fatalf("actions = %#v, want framework protocol leak dropped", actions)
	}
}
