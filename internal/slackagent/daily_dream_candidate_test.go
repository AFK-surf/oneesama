package slackagent

import (
	"strings"
	"testing"
)

func TestBuildSlackDreamCandidatesConsolidatesRepeatedSignals(t *testing.T) {
	signals := []SlackDreamSignal{
		{
			Source:         "approval_card",
			Surface:        "slack",
			Verdict:        "reject",
			Refs:           []string{"slack:C1/100.000"},
			ReasonCode:     "missing_evidence_anchor",
			ProposedAction: "gate_fixture",
			Subject:        "visible_reply_quality",
			SourceType:     "approval_card",
			Content:        "Reply lacked source-backed evidence.",
			Timestamp:      "2026-05-22T10:00:00Z",
		},
		{
			Source:         "triage_sweep",
			Surface:        "slack",
			Verdict:        "block",
			Refs:           []string{"sweep:2026-05-22T11:00:00Z"},
			ReasonCode:     "missing_evidence_anchor",
			ProposedAction: "gate_fixture",
			Subject:        "visible_reply_quality",
			SourceType:     "approval_card",
			Content:        "Shadow gate would block the reply.",
			Timestamp:      "2026-05-22T11:00:00Z",
		},
	}

	candidates := BuildSlackDreamCandidates(signals, SlackDreamCandidateOptions{Date: "2026-05-22"})
	if len(candidates) != 1 {
		t.Fatalf("candidates = %#v, want one consolidated candidate", candidates)
	}
	candidate := candidates[0]
	if candidate.ReviewStatus != slackDreamCandidateReviewPending || candidate.ReviewNotes != "repeated_pattern" {
		t.Fatalf("candidate = %#v, want pending repeated pattern", candidate)
	}
	if candidate.Confidence <= 0.5 {
		t.Fatalf("candidate confidence = %f, want normal confidence for repeated signals", candidate.Confidence)
	}
	if len(candidate.InputRefs) != 2 || !strings.Contains(candidate.Proposal, "Review 2") {
		t.Fatalf("candidate = %#v, want both source refs and repeated proposal", candidate)
	}
	if len(candidate.RequiredCanaries) != 1 || candidate.RequiredCanaries[0] != "visible_reply_allow_list_canary" {
		t.Fatalf("required canaries = %#v, want visible reply canary", candidate.RequiredCanaries)
	}
}

func TestBuildSlackDreamCandidatesKeepsOneOffLowConfidence(t *testing.T) {
	candidates := BuildSlackDreamCandidates([]SlackDreamSignal{{
		Source:         "manual_review",
		Refs:           []string{"slack:C1/200.000"},
		ReasonCode:     "identity_scope",
		ProposedAction: "memory_candidate",
		Subject:        "oneesama_identity",
		SourceType:     "manual_review",
		Content:        "Oneesama identity should stay foreground scoped.",
	}}, SlackDreamCandidateOptions{Date: "2026-05-22"})

	if len(candidates) != 1 {
		t.Fatalf("candidates = %#v, want one low-confidence candidate", candidates)
	}
	if candidates[0].ReviewNotes != "single_signal_low_confidence" || candidates[0].Confidence != 0.35 {
		t.Fatalf("candidate = %#v, want low-confidence one-off", candidates[0])
	}
}

func TestRenderSlackDreamCandidatesMarkdownIsDeterministic(t *testing.T) {
	signals := []SlackDreamSignal{
		{Source: "b", Refs: []string{"ref-b"}, ReasonCode: "same", ProposedAction: "contradiction_review", Subject: "identity", SourceType: "approval", Content: "second", Timestamp: "2026-05-22T11:00:00Z"},
		{Source: "a", Refs: []string{"ref-a"}, ReasonCode: "same", ProposedAction: "contradiction_review", Subject: "identity", SourceType: "approval", Content: "first", Timestamp: "2026-05-22T10:00:00Z"},
	}

	first := RenderSlackDreamCandidatesMarkdown(BuildSlackDreamCandidates(signals, SlackDreamCandidateOptions{Date: "2026-05-22"}))
	second := RenderSlackDreamCandidatesMarkdown(BuildSlackDreamCandidates([]SlackDreamSignal{signals[1], signals[0]}, SlackDreamCandidateOptions{Date: "2026-05-22"}))
	if first != second {
		t.Fatalf("markdown not deterministic:\nfirst=%s\nsecond=%s", first, second)
	}
	if !strings.Contains(first, slackMemoryScopeCanaryContradictionCase) || !strings.Contains(first, "ref-a") || !strings.Contains(first, "ref-b") {
		t.Fatalf("markdown = %q, want canary and source refs", first)
	}
}

func TestReadSlackDreamSignalsNDJSON(t *testing.T) {
	raw := strings.Join([]string{
		`{"source":"approval_card","reason_code":"missing_anchor","refs":["slack:C1/1"],"content":"first"}`,
		`{"source":"triage_sweep","reason_code":"missing_anchor","refs":["sweep:1"],"content":"second"}`,
	}, "\n")

	signals, err := ReadSlackDreamSignalsNDJSON(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("ReadSlackDreamSignalsNDJSON: %v", err)
	}
	if len(signals) != 2 || signals[0].Source != "approval_card" || signals[1].Refs[0] != "sweep:1" {
		t.Fatalf("signals = %#v, want parsed NDJSON", signals)
	}
}
