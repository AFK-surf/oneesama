package slackagent

import (
	"strings"
	"testing"
)

func TestBuildSlackSkillPolicyCandidatesConsolidatesReusableGateSignals(t *testing.T) {
	signals := []SlackDreamSignal{
		{
			Source:         "approval_card",
			Verdict:        "rejected",
			Refs:           []string{"pending_action:1"},
			ReasonCode:     "missing_evidence_anchor",
			ProposedAction: "gate_fixture",
			Target:         "visible_reply_gate",
			Subject:        "visible_reply_quality",
			SourceType:     "approval_card",
			Content:        "Reply had no source-backed anchor.",
			Timestamp:      "2026-05-22T10:00:00Z",
		},
		{
			Source:         "visible_reply_allow_list_canary",
			Verdict:        "fail",
			Refs:           []string{"visible_reply_allow_list_canary:framework_protocol_leak_blocks"},
			ReasonCode:     "missing_evidence_anchor",
			ProposedAction: "gate_fixture",
			Target:         "visible_reply_gate",
			Subject:        "visible_reply_quality",
			SourceType:     "visible_reply_allow_list_canary",
			Content:        "Canary caught a reply that should become a fixture.",
			Timestamp:      "2026-05-22T11:00:00Z",
		},
	}

	candidates := BuildSlackSkillPolicyCandidates(signals, SlackSkillPolicyCandidateOptions{Date: "2026-05-22"})
	if len(candidates) != 1 {
		t.Fatalf("candidates = %#v, want one reusable skill/policy candidate", candidates)
	}
	candidate := candidates[0]
	if candidate.Target != "visible_reply_gate" || candidate.ReviewStatus != slackSkillPolicyCandidateReviewPending {
		t.Fatalf("candidate = %#v, want pending visible-reply gate candidate", candidate)
	}
	if candidate.Confidence <= 0.5 || candidate.WhyReusable != "repeated_pattern_across_2_signals" {
		t.Fatalf("candidate = %#v, want repeated reusable confidence", candidate)
	}
	if len(candidate.RequiredCanaries) != 1 || candidate.RequiredCanaries[0] != "visible_reply_allow_list_canary" {
		t.Fatalf("required canaries = %#v, want visible reply canary", candidate.RequiredCanaries)
	}
}

func TestBuildSlackSkillPolicyCandidatesMarksTransientDoNotCapture(t *testing.T) {
	candidates := BuildSlackSkillPolicyCandidates([]SlackDreamSignal{{
		Source:         "production_incident",
		Verdict:        "quality_regression",
		Refs:           []string{"incident:ssl"},
		ReasonCode:     "network_timeout",
		ProposedAction: "prompt_candidate",
		Target:         "prompt_policy",
		Subject:        "local SSL transient",
		SourceType:     "production_incident",
		Content:        "Local machine transient SSL timeout during GitHub push.",
	}}, SlackSkillPolicyCandidateOptions{Date: "2026-05-22"})

	if len(candidates) != 1 {
		t.Fatalf("candidates = %#v, want one candidate with do_not_capture", candidates)
	}
	if candidates[0].DoNotCapture != "environment_or_transient_failure" {
		t.Fatalf("candidate = %#v, want transient do_not_capture", candidates[0])
	}
}

func TestBuildSlackSkillPolicyCandidatesIgnoresMemoryOnlySignals(t *testing.T) {
	candidates := BuildSlackSkillPolicyCandidates([]SlackDreamSignal{{
		Source:         "manual_review",
		ReasonCode:     "identity_scope",
		ProposedAction: "memory_candidate",
		Subject:        "oneesama_identity",
		Content:        "Foreground identity should stay scoped.",
	}}, SlackSkillPolicyCandidateOptions{Date: "2026-05-22"})

	if len(candidates) != 0 {
		t.Fatalf("candidates = %#v, want memory-only signal ignored by skill/policy lane", candidates)
	}
}

func TestRenderSlackSkillPolicyCandidatesMarkdown(t *testing.T) {
	markdown := RenderSlackSkillPolicyCandidatesMarkdown([]SlackSkillPolicyCandidate{{
		ID:               "skill-policy-2026-05-22-test",
		Date:             "2026-05-22",
		ClusterKey:       "visible_reply_gate|visible_reply_quality|missing_anchor|gate_fixture",
		Target:           "visible_reply_gate",
		Proposal:         "Add a canary for source-backed replies.",
		WhyReusable:      "repeated_pattern_across_2_signals",
		RequiredCanaries: []string{"visible_reply_allow_list_canary"},
		ReviewStatus:     slackSkillPolicyCandidateReviewPending,
		SourceSignalRefs: []string{"pending_action:1"},
	}})
	if !strings.Contains(markdown, "Oneesama Skill/Policy Candidates") ||
		!strings.Contains(markdown, "Target: visible_reply_gate") ||
		!strings.Contains(markdown, "pending_action:1") {
		t.Fatalf("markdown = %q, want skill/policy candidate details", markdown)
	}
}
