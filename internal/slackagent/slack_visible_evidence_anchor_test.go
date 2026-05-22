package slackagent

import (
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestSlackVisibleEvidenceAnchorsUseSourceDerivedConfidence(t *testing.T) {
	t.Parallel()

	decision := parseSlackTriageDecision(`{
		"summary":"reply with memory-backed fact",
		"actions":[{
			"type":"post_thread_reply",
			"message":"Zanwei is likely Johnson8053 based on old workspace memory.",
			"channelId":"C123",
			"threadTs":"177.000",
			"confidence":0.91,
			"evidence_anchors":[{
				"kind":"workspace_memory",
				"source_ref":"memory/legacy/slack-agent-d/entity.md:12",
				"quote":"Johnson8053 posts affine/bridge links",
				"confidence":0.01,
				"confidence_source":"model_claimed_high_confidence"
			}]
		}]
	}`, slackTriageFallback{Channel: "C123", ThreadTS: "177.000"})

	if len(decision.Actions) != 1 || len(decision.Actions[0].EvidenceAnchors) != 1 {
		t.Fatalf("actions = %#v, want one action with one evidence anchor", decision.Actions)
	}
	anchor := decision.Actions[0].EvidenceAnchors[0]
	if anchor.Kind != slackVisibleEvidenceKindWorkspaceMemory || anchor.Confidence != 0.8 || anchor.ConfidenceSource != "source_derived:workspace_memory" {
		t.Fatalf("anchor = %#v, want normalized source-derived workspace memory confidence", anchor)
	}
	if !strings.Contains(anchor.SourceRef, "memory/legacy") || !strings.Contains(anchor.Quote, "Johnson8053") {
		t.Fatalf("anchor = %#v, want source ref and quote preserved", anchor)
	}
}

func TestSlackVisibleEvidenceAnchorsInferThreadSourceForVisibleReplies(t *testing.T) {
	t.Parallel()

	actions := normalizeSlackTriageActions([]any{map[string]any{
		"type":     "post_thread_reply",
		"message":  "This reply is based on the thread.",
		"channel":  "C123",
		"threadTs": "177.000",
	}}, slackTriageFallback{})

	if len(actions) != 1 || len(actions[0].EvidenceAnchors) != 1 {
		t.Fatalf("actions = %#v, want fallback thread evidence anchor", actions)
	}
	anchor := actions[0].EvidenceAnchors[0]
	if anchor.Kind != slackVisibleEvidenceKindSlackThread || anchor.SourceRef != "slack://channel/C123/thread/177.000" || anchor.ConfidenceSource != "source_derived:slack_thread" {
		t.Fatalf("anchor = %#v, want source-derived slack thread fallback", anchor)
	}
}

func TestSlackPersonaVisibleReplyEvidenceAnchorsMapPiContractAnchors(t *testing.T) {
	t.Parallel()

	anchors := slackPersonaVisibleReplyEvidenceAnchors("C123", "177.000", SlackPersonaShadowResult{
		VisibleText: "Johnson8053 是队友 HN 小号。",
		EvidenceAnchors: slackVisibleEvidenceAnchorsFromPersona([]persona.EvidenceAnchor{{
			Kind:      persona.EvidenceKindFetchedLink,
			SourceRef: "https://news.ycombinator.com/user?id=Johnson8053",
			Quote:     "created 2024-09 / karma 33",
		}}),
	}, persona.Request{})

	if len(anchors) == 0 || anchors[0].Kind != slackVisibleEvidenceKindFetchedLink || anchors[0].ConfidenceSource != "source_derived:fetched_link" {
		t.Fatalf("anchors = %#v, want Pi fetched_link anchor mapped before fallback thread evidence", anchors)
	}
}
