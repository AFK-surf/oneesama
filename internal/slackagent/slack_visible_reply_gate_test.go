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

func TestVisibleReplyQualityGateDropsReadingProcessNarration(t *testing.T) {
	t.Parallel()

	message := "我粗读了一下《Not Found | Deno》。核心信息是：Search powered by Orama。我的初步判断：这类内容适合作为讨论引子。"
	if got := slackVisibleReplyQualityBlockReason(message); got != "reading_process_narration" {
		t.Fatalf("block reason = %q, want reading_process_narration", got)
	}
	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   message,
		ChannelID: "C123",
		ThreadTS:  "123.456",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://deno.com/blog/claw-patrol",
			Quote:     "Not Found | Deno",
		}},
	}
	if verdict := slackVisibleReplyAllowListVerdictForAction(action); verdict.Allowed || verdict.Reason != slackVisibleReplyAllowReasonInternalMeta {
		t.Fatalf("verdict = %#v, want narration block despite anchor", verdict)
	}
}

func TestVisibleReplyAllowListRejectsReaderFailureFetchedLinkAnchor(t *testing.T) {
	t.Parallel()

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   "Deno 这条看起来是一个有价值的发布。",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://deno.com/blog/claw-patrol",
			Quote:     "Not Found | Deno",
		}},
	}
	if verdict := slackVisibleReplyAllowListVerdictForAction(action); verdict.Allowed || verdict.Reason != slackVisibleReplyAllowReasonMissingEvidenceAnchor {
		t.Fatalf("verdict = %#v, want reader-failure anchor ignored", verdict)
	}
}
