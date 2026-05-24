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
	if actions := slackTriageVisibleReplyActionsAfterGate([]SlackTriageDecisionAction{action}); len(actions) != 0 {
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

func TestVisibleReplyAllowListRejectsStatusClaimWithOnlyThreadAnchor(t *testing.T) {
	t.Parallel()

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   "PR #2035 已部署到 staging (c44d5d6)。<@U09KNU8QD1V> 或 <@U09KY0GE28K> 可以确认这个修复是否包含在内。",
		ChannelID: "C09KVPBMLJ3",
		ThreadTS:  "1779609962.709059",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindSlackThread,
			SourceRef: "C09KVPBMLJ3/1779609962.709059",
			Quote:     "这修了吗 [file_id:F0B5SLBRVLN, name:image.png, type:image/png]",
		}},
	}
	verdict := slackVisibleReplyAllowListVerdictForAction(action)
	if verdict.Allowed || verdict.Reason != slackVisibleReplyAllowReasonBoundaryMismatch {
		t.Fatalf("verdict = %#v, want boundary mismatch for unverified status claim", verdict)
	}
}

func TestVisibleReplyAllowListAllowsPlainRoutingHandoffWithThreadAnchor(t *testing.T) {
	t.Parallel()

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   "这个需要项目 owner 确认，我先把上下文路由给 <@U09KNU8QD1V>。",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindSlackThread,
			SourceRef: "C123/123.456",
			Quote:     "请 owner 看一下",
		}},
	}
	verdict := slackVisibleReplyAllowListVerdictForAction(action)
	if !verdict.Allowed {
		t.Fatalf("verdict = %#v, want plain routing handoff allowed", verdict)
	}
}
