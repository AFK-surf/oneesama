package slackagent

import "strings"

func slackVisibleReplyQualityBlockReason(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "empty_reply"
	}
	if slackVisibleTextContainsInternalLeak(trimmed) {
		return "internal_control_plane_leak"
	}
	lower := strings.ToLower(trimmed)
	if slackVisibleReplyIsNoVisibleOutputMeta(lower) {
		return "no_visible_output_meta"
	}
	if slackVisibleReplyIsSelfDecisionMeta(lower) {
		return "self_decision_meta"
	}
	return ""
}

func slackVisibleReplyIsNoVisibleOutputMeta(lower string) bool {
	for _, marker := range []string{
		"no visible output",
		"no visible reply",
		"visible_text",
		"stay silent",
		"should stay silent",
		"do not reply",
		"do not post",
		"无可见输出",
		"无可见回复",
		"没有可见输出",
		"没有可见回复",
		"不应在此线程插话",
		"不应该在此线程插话",
		"不应插话",
		"不需要插话",
		"无需插话",
		"无需可见输出",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func slackVisibleReplyIsSelfDecisionMeta(lower string) bool {
	if slackVisibleTextContainsAny(lower, []string{
		"the persona",
		"persona already",
		"persona classified",
		"persona has classified",
		"persona determined",
		"persona decided",
		"根据 persona",
		"persona 分析",
		"persona 判定",
		"persona 已判定",
		"persona 已经判定",
		"persona 已经分析",
	}) {
		return true
	}
	if slackVisibleTextContainsAny(lower, []string{
		"triage decision",
		"foreground triage",
		"pi-first foreground",
		"delegate_worker",
		"post_thread_reply",
		"agent_runner",
		"approval gate",
		"runtime decided",
		"worker classified",
	}) {
		return true
	}
	return (strings.Contains(lower, "oneesama") || strings.Contains(lower, "onee-sama")) &&
		slackVisibleTextContainsAny(lower, []string{
			"不应",
			"不应该",
			"无需",
			"不需要",
			"should stay silent",
			"should not reply",
			"no visible",
		})
}
