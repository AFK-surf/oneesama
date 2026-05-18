package slackagent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
)

type capturePersonaRuntime struct {
	requests []persona.Request
	response persona.Response
	err      error
}

func (r *capturePersonaRuntime) Decide(_ context.Context, req persona.Request) (persona.Response, error) {
	r.requests = append(r.requests, req)
	if r.err != nil {
		return persona.Response{}, r.err
	}
	return r.response, nil
}

func (r *capturePersonaRuntime) Status(context.Context) persona.Status {
	return persona.Status{Provider: "capture", Mode: persona.ModeShadow, Ready: true, Healthy: true, ShadowOnly: true}
}

func TestBuildBackfillPersonaRequestCarriesEvidenceAndShadowSafety(t *testing.T) {
	candidate := SlackBackfillCandidate{
		ChannelID:      "C1",
		ThreadTS:       "123.456",
		OriginatorTS:   "123.456",
		Classification: "unanswered_question",
		Title:          "Pi runtime boundary",
		OriginalText:   "Pi-style persona runtime 和 Go 周边应该怎么切？",
		Draft:          "可以先把 persona runtime 做成 sidecar。",
		ReviewStatus:   BackfillReviewReady,
		ReviewReason:   "candidate passes local quality gates with related memory evidence",
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "team_decision",
			Source:     "memory/team/decisions/persona-runtime.md",
			SourcePath: "memory/team/decisions/persona-runtime.md",
			StartLine:  7,
			EndLine:    9,
			Content:    "Meeting Avatar foreground persona should move to a Pi-style runtime.",
			Score:      0.84,
		}},
	}

	req := BuildBackfillPersonaRequest(candidate)
	if req.ID != "backfill:C1:123.456:unanswered_question" || req.Mode != persona.ModeShadow {
		t.Fatalf("request id/mode = %q/%q, want backfill id + shadow", req.ID, req.Mode)
	}
	if req.Event.Kind != "slack_backfill_candidate" || !strings.Contains(req.Event.Text, "Pi-style persona") {
		t.Fatalf("event = %#v, want backfill candidate text", req.Event)
	}
	if req.Anchor.ChannelID != "C1" || req.Anchor.ThreadTS != "123.456" || req.Anchor.MessageTS != "123.456" {
		t.Fatalf("anchor = %#v, want Slack thread anchor", req.Anchor)
	}
	if !req.Safety.AllowVisibleReply || req.Safety.AllowSpeech || !req.Safety.AllowWorkerRequest {
		t.Fatalf("safety = %#v, want shadow-visible candidate with worker allowed and speech disabled", req.Safety)
	}
	if len(req.Evidence.Citations) != 1 || req.Evidence.Citations[0].SourceRef != "memory/team/decisions/persona-runtime.md" || req.Evidence.Citations[0].LineStart != 7 {
		t.Fatalf("citations = %#v, want source path/line evidence", req.Evidence.Citations)
	}
	if len(req.Memory.Items) != 1 || req.Memory.Items[0].Kind != "team_decision" {
		t.Fatalf("memory items = %#v, want related memory record", req.Memory.Items)
	}
	if req.Metadata["review_status"] != BackfillReviewReady {
		t.Fatalf("metadata review_status = %#v, want %s", req.Metadata["review_status"], BackfillReviewReady)
	}
}

func TestBuildBackfillPersonaRequestDisablesVisibleReplyWhenNotReviewReady(t *testing.T) {
	req := BuildBackfillPersonaRequest(SlackBackfillCandidate{
		ChannelID:      "C1",
		ThreadTS:       "123.456",
		Classification: "workflow_question",
		OriginalText:   "CI 为什么红了？",
		ReviewStatus:   BackfillReviewNeedsContext,
		ReviewReason:   "technical workflow question; inspect repo context first",
	})
	if req.Safety.AllowVisibleReply {
		t.Fatalf("AllowVisibleReply = true, want false for %s", BackfillReviewNeedsContext)
	}
	if req.Metadata["review_status"] != BackfillReviewNeedsContext {
		t.Fatalf("metadata review_status = %#v, want %s", req.Metadata["review_status"], BackfillReviewNeedsContext)
	}
}

func TestShadowPersonaBackfillCandidatesCallsRuntime(t *testing.T) {
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionReply,
		Reason:     "shadow accepted",
		ShadowOnly: true,
		Citations:  []persona.Citation{{SourceRef: "memory/team.md", LineStart: 4}},
	}}
	results := ShadowPersonaBackfillCandidates(context.Background(), runtime, []SlackBackfillCandidate{{
		ChannelID:      "C1",
		ThreadTS:       "100.000",
		Classification: "unanswered_question",
		OriginalText:   "没人回这个架构问题。",
		ReviewStatus:   BackfillReviewReady,
		RelatedMemory:  []SlackRelatedMemoryRecord{{Kind: "team_decision", SourcePath: "memory/team.md", StartLine: 4, Content: "Use Pi sidecar.", Score: 0.9}},
	}})
	if len(runtime.requests) != 1 || runtime.requests[0].Mode != persona.ModeShadow {
		t.Fatalf("runtime requests = %#v, want one shadow request", runtime.requests)
	}
	if len(results) != 1 || !results[0].Success || results[0].Runtime != persona.ProviderPi || results[0].Decision != persona.DecisionReply {
		t.Fatalf("results = %#v, want successful pi reply shadow", results)
	}
	if len(results[0].Citations) != 1 || results[0].Citations[0] != "memory/team.md:4" {
		t.Fatalf("result citations = %#v, want source ref", results[0].Citations)
	}
}

func TestShadowPersonaBackfillCandidatesRecordsErrorsWithoutDroppingResult(t *testing.T) {
	runtime := &capturePersonaRuntime{err: errors.New("sidecar unavailable")}
	results := ShadowPersonaBackfillCandidates(context.Background(), runtime, []SlackBackfillCandidate{{
		ChannelID:      "C1",
		ThreadTS:       "100.000",
		Classification: "unanswered_question",
		OriginalText:   "没人回这个架构问题。",
	}})
	if len(results) != 1 || results[0].Success || !strings.Contains(results[0].Error, "sidecar unavailable") {
		t.Fatalf("results = %#v, want recorded sidecar error", results)
	}
}

func TestBuildSlackTriagePersonaRequestIncludesDecisionAndMemory(t *testing.T) {
	req := BuildSlackTriagePersonaRequest(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{
			{ChannelIDSnake: "C_TRIAGE", TS: "200.000", UserIDSnake: "U_PENG", Text: "这个链接没人读，oneesama 应该补一下吗？"},
			{ChannelIDSnake: "C_TRIAGE", TS: "201.000", ThreadTSSnake: "200.000", UserIDSnake: "U_DRIVER", Text: "补充：需要参考最近的记忆。"},
		},
		SlackTriageDecision{
			Summary: "Thread is synthesis-eligible.",
			ParseOK: true,
			Actions: []SlackTriageDecisionAction{{
				Type:    "post_thread_reply",
				Message: "我来补一个轻量意见。",
			}},
		},
		[]SlackRelatedMemoryRecord{{
			Kind:       "team_question",
			SourcePath: "memory/questions/aha.md",
			StartLine:  12,
			Content:    "Aha moments should recall related recent memory.",
			Score:      0.77,
		}},
	)
	if req.ID != "triage:C_TRIAGE:200.000" || req.Event.Kind != "slack_triage" || req.Mode != persona.ModeShadow {
		t.Fatalf("request identity = %#v, want triage shadow request", req)
	}
	if !strings.Contains(req.Event.Text, "这个链接没人读") || !strings.Contains(req.Event.Text, "补充：需要参考") {
		t.Fatalf("event text = %q, want normalized joined thread text", req.Event.Text)
	}
	if !req.Safety.AllowVisibleReply || req.Safety.AllowSpeech {
		t.Fatalf("safety = %#v, want visible reply allowed in shadow and speech disabled", req.Safety)
	}
	if req.Metadata["actions"] != 1 || req.Metadata["decision_parse_ok"] != true {
		t.Fatalf("metadata = %#v, want action count + parse flag", req.Metadata)
	}
	if len(req.Evidence.Citations) != 1 || req.Evidence.Citations[0].SourceRef != "memory/questions/aha.md" {
		t.Fatalf("citations = %#v, want related memory citation", req.Evidence.Citations)
	}
}
