package slackagent

import (
	"regexp"
	"strings"
)

var slackVisibleReplyCommitLikePattern = regexp.MustCompile(`(?i)\b[0-9a-f]{7,40}\b`)

const (
	slackVisibleReplyAllowReasonAllowed               = "allowed"
	slackVisibleReplyAllowReasonMissingEvidenceAnchor = "missing_evidence_anchor"
	slackVisibleReplyAllowReasonNotHumanFacing        = "not_human_facing"
	slackVisibleReplyAllowReasonDuplicateHandled      = "duplicate_handled"
	slackVisibleReplyAllowReasonBoundaryMismatch      = "boundary_mismatch"
	slackVisibleReplyAllowReasonInternalMeta          = "internal_meta"
)

type slackVisibleReplyAllowListVerdict struct {
	Allowed         bool
	Reason          string
	EvidenceAnchors []SlackVisibleEvidenceAnchor
}

type SlackVisibleReplyCandidate struct {
	Message         string                       `json:"message"`
	EvidenceAnchors []SlackVisibleEvidenceAnchor `json:"evidenceAnchors,omitempty"`
}

type SlackVisibleReplyCandidateVerdict struct {
	Allowed         bool                         `json:"allowed"`
	Reason          string                       `json:"reason"`
	EvidenceAnchors []SlackVisibleEvidenceAnchor `json:"evidenceAnchors,omitempty"`
}

func EvaluateSlackVisibleReplyCandidate(candidate SlackVisibleReplyCandidate) SlackVisibleReplyCandidateVerdict {
	verdict := slackVisibleReplyAllowListVerdictForAction(SlackTriageDecisionAction{
		Type:            slackActionTypeThreadReply,
		Message:         candidate.Message,
		EvidenceAnchors: candidate.EvidenceAnchors,
	})
	return SlackVisibleReplyCandidateVerdict{
		Allowed:         verdict.Allowed,
		Reason:          verdict.Reason,
		EvidenceAnchors: verdict.EvidenceAnchors,
	}
}

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
	if slackVisibleReplyIsReadingProcessNarration(lower) {
		return "reading_process_narration"
	}
	return ""
}

func slackVisibleReplyAllowListVerdictForAction(action SlackTriageDecisionAction) slackVisibleReplyAllowListVerdict {
	message := strings.TrimSpace(firstNonEmpty(action.Message, action.Reason))
	if message == "" {
		return slackVisibleReplyAllowListVerdict{Reason: slackVisibleReplyAllowReasonNotHumanFacing}
	}
	if reason := slackVisibleReplyQualityBlockReason(message); reason != "" {
		return slackVisibleReplyAllowListVerdict{Reason: slackVisibleReplyAllowReasonInternalMeta}
	}
	anchors := slackVisibleEvidenceAnchorsForAction(action)
	if slackVisibleReplyMakesExternalStatusClaim(message) && !slackVisibleReplyHasNonThreadEvidenceAnchor(anchors) {
		return slackVisibleReplyAllowListVerdict{
			Reason:          slackVisibleReplyAllowReasonBoundaryMismatch,
			EvidenceAnchors: normalizeSlackVisibleEvidenceAnchors(anchors),
		}
	}
	if !slackVisibleReplyHasAllowListEvidenceAnchor(anchors, message) {
		return slackVisibleReplyAllowListVerdict{
			Reason:          slackVisibleReplyAllowReasonMissingEvidenceAnchor,
			EvidenceAnchors: anchors,
		}
	}
	if slackVisibleReplyLooksLikeHandledMeta(message) {
		return slackVisibleReplyAllowListVerdict{
			Reason:          slackVisibleReplyAllowReasonDuplicateHandled,
			EvidenceAnchors: anchors,
		}
	}
	return slackVisibleReplyAllowListVerdict{
		Allowed:         true,
		Reason:          slackVisibleReplyAllowReasonAllowed,
		EvidenceAnchors: anchors,
	}
}

func slackVisibleReplyHasAllowListEvidenceAnchor(anchors []SlackVisibleEvidenceAnchor, message string) bool {
	for _, anchor := range normalizeSlackVisibleEvidenceAnchors(anchors) {
		switch strings.TrimSpace(anchor.Kind) {
		case slackVisibleEvidenceKindFetchedLink:
			if slackVisibleEvidenceAnchorLooksLikeReaderFailure(anchor) {
				continue
			}
			return true
		case slackVisibleEvidenceKindWorkspaceMemory,
			slackVisibleEvidenceKindPersonMemory,
			slackVisibleEvidenceKindFile,
			slackVisibleEvidenceKindImage,
			slackVisibleEvidenceKindWorkerResult,
			slackVisibleEvidenceKindExplicitUserCommand:
			return true
		case slackVisibleEvidenceKindSlackThread:
			if slackVisibleReplyLooksLikeRoutingHandoff(message) {
				return true
			}
		}
	}
	return false
}

func slackVisibleReplyHasNonThreadEvidenceAnchor(anchors []SlackVisibleEvidenceAnchor) bool {
	for _, anchor := range normalizeSlackVisibleEvidenceAnchors(anchors) {
		switch strings.TrimSpace(anchor.Kind) {
		case "":
			continue
		case slackVisibleEvidenceKindSlackThread:
			continue
		case slackVisibleEvidenceKindFetchedLink:
			if slackVisibleEvidenceAnchorLooksLikeReaderFailure(anchor) {
				continue
			}
			return true
		default:
			return true
		}
	}
	return false
}

func slackVisibleReplyMakesExternalStatusClaim(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	if slackVisibleReplyCommitLikePattern.MatchString(lower) {
		return true
	}
	return slackVisibleTextContainsAny(lower, []string{
		"pr #",
		"pull request",
		"staging",
		"production",
		" prod",
		"deploy",
		"deployed",
		"deployment",
		"release",
		"merged",
		"commit",
		"build",
		"部署",
		"已部署",
		"上线",
		"已上线",
		"合并",
		"已合并",
		"包含在内",
	})
}

func slackVisibleEvidenceAnchorLooksLikeReaderFailure(anchor SlackVisibleEvidenceAnchor) bool {
	return slackExternalLinkContextLooksLikeReaderFailure(SlackExternalLinkContext{
		URL:     strings.TrimSpace(anchor.SourceRef),
		Title:   strings.TrimSpace(anchor.Quote),
		Excerpt: strings.TrimSpace(anchor.Quote),
	})
}

func slackVisibleReplyIsReadingProcessNarration(lower string) bool {
	return slackVisibleTextContainsAny(lower, []string{
		"我粗读了一下",
		"核心信息是",
		"我的初步判断",
		"这类内容适合作为讨论引子",
		"如果继续聊",
		"i skimmed",
		"core signal",
		"my initial take",
		"discussion prompt",
	})
}

func slackVisibleReplyLooksLikeRoutingHandoff(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	return slackVisibleTextContainsAny(lower, []string{
		"owner",
		"handoff",
		"route",
		"routing",
		"不直接下场查 repo",
		"不直接下场",
		"明确授权",
		"项目 owner",
		"路由",
		"转给",
	})
}

func slackVisibleReplyLooksLikeHandledMeta(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	return slackVisibleTextContainsAny(lower, []string{
		"already handled",
		"already answered",
		"already replied",
		"no additional value",
		"no action needed",
		"无需回复",
		"无需处理",
		"已经处理",
		"已经回复",
	})
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
		"我是 codex",
		"我是一个 codex",
		"我是 openrouter",
		"i am codex",
		"i'm codex",
		"i am openrouter",
		"i'm openrouter",
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
