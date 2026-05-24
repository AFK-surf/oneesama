package slackagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type capturePersonaRuntime struct {
	mu       sync.Mutex
	requests []persona.Request
	response persona.Response
	err      error
}

func (r *capturePersonaRuntime) Decide(_ context.Context, req persona.Request) (persona.Response, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, req)
	if r.err != nil {
		return persona.Response{}, r.err
	}
	return r.response, nil
}

func (r *capturePersonaRuntime) Status(context.Context) persona.Status {
	return persona.Status{Provider: "capture", Mode: persona.ModeShadow, Ready: true, Healthy: true, ShadowOnly: true}
}

type blockingPersonaRuntime struct {
	requests chan persona.Request
	release  chan struct{}
	response persona.Response
}

func newBlockingPersonaRuntime(response persona.Response) *blockingPersonaRuntime {
	return &blockingPersonaRuntime{
		requests: make(chan persona.Request, 1),
		release:  make(chan struct{}),
		response: response,
	}
}

func (r *blockingPersonaRuntime) Decide(ctx context.Context, req persona.Request) (persona.Response, error) {
	select {
	case r.requests <- req:
	default:
	}
	select {
	case <-r.release:
		return r.response, nil
	case <-ctx.Done():
		return persona.Response{}, ctx.Err()
	}
}

func (r *blockingPersonaRuntime) Status(context.Context) persona.Status {
	return persona.Status{Provider: persona.ProviderPi, Mode: persona.ModeShadow, Ready: true, Healthy: true, ShadowOnly: true}
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

func TestPersonaRelatedMemoryInputsScrubSidecarMarkers(t *testing.T) {
	t.Parallel()

	records := []SlackRelatedMemoryRecord{{
		Kind:       "legacy_triage_archive",
		Source:     "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-20.md",
		SourcePath: "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-20.md",
		Content:    "alpha[[MSG_BREAK]]beta[[WORLD_BRIEF]]internal only[[/WORLD_BRIEF]]",
		Score:      0.9,
	}}

	memory := personaMemoryRecordsFromRelatedMemory(records)
	if len(memory) != 1 {
		t.Fatalf("memory records = %#v, want one record", memory)
	}
	if strings.Contains(memory[0].Text, "MSG_BREAK") || strings.Contains(memory[0].Text, "WORLD_BRIEF") || strings.Contains(memory[0].Text, "internal only") {
		t.Fatalf("persona memory leaked sidecar marker content: %q", memory[0].Text)
	}
	if !strings.Contains(memory[0].Text, "alpha\n\nbeta") {
		t.Fatalf("persona memory = %q, want paragraph-preserving sanitized content", memory[0].Text)
	}

	citations := personaCitationsFromRelatedMemory(records)
	if len(citations) != 1 {
		t.Fatalf("citations = %#v, want one citation", citations)
	}
	if strings.Contains(citations[0].Snippet, "MSG_BREAK") || strings.Contains(citations[0].Snippet, "internal only") {
		t.Fatalf("persona citation leaked sidecar marker content: %q", citations[0].Snippet)
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

func TestQueueSlackTriagePersonaShadowDoesNotBlockAndRecordsLater(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				WorkspacePolicy: "Source-backed product articles are worth concise comments in this workspace.",
			},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider:   persona.ProviderFake,
			Mode:       persona.ModeShadow,
			Timeout:    time.Second,
			ShadowOnly: true,
		},
	})
	runtime := newBlockingPersonaRuntime(persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionDelegateWorker,
		Reason:     "shadow accepted after slow sidecar",
		ShadowOnly: true,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Timeout = time.Second

	run, err := service.triage.RecordRun(ctx, SlackTriageContext{
		Status:  "ok",
		Summary: "initial triage result",
		ToolCalls: []SlackTriageToolCall{{
			Tool:    "agent_runner",
			Action:  "slack_triage",
			Success: true,
			Result:  "ok",
		}},
		Metadata: map[string]any{"persona_shadow_queued": true},
	})
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	start := time.Now()
	queued := service.queueSlackTriagePersonaShadow(
		ctx,
		run.ID,
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{{ChannelIDSnake: "C_TRIAGE", TS: "200.000", UserIDSnake: "U_PENG", Text: "Pi sidecar 会不会拖住 triage？"}},
		SlackTriageDecision{Summary: "Need non-blocking shadow.", ParseOK: true},
		nil,
	)
	if !queued {
		t.Fatal("queueSlackTriagePersonaShadow returned false, want queued")
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("queueSlackTriagePersonaShadow blocked for %s, want <50ms", elapsed)
	}

	select {
	case req := <-runtime.requests:
		if req.Event.Kind != "slack_triage" || req.Anchor.ChannelID != "C_TRIAGE" {
			t.Fatalf("persona request = %#v, want triage request for C_TRIAGE", req)
		}
		if got := personaContextText(req.Context, "workspace_triage_policy"); got != "" {
			t.Fatalf("workspace policy stable context = %q, want dynamic envelope only", got)
		}
		if got := personaDynamicContextText(req.DynamicContext, "workspace_triage_policy"); !strings.Contains(got, "product articles") {
			t.Fatalf("workspace policy dynamic context = %q, want configured policy", got)
		}
	case <-time.After(time.Second):
		t.Fatal("persona runtime was not called")
	}

	beforeRelease, err := service.triage.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("GetRun before release: %v", err)
	}
	if _, ok := beforeRelease.Metadata["persona_shadow"]; ok {
		t.Fatalf("persona shadow result recorded before sidecar returned: %#v", beforeRelease.Metadata)
	}

	close(runtime.release)
	updated := waitForPersonaShadowRun(t, service, run.ID)
	if len(updated.ToolCalls) != 2 {
		t.Fatalf("tool calls = %#v, want agent_runner + persona_runtime", updated.ToolCalls)
	}
	personaCall := updated.ToolCalls[1]
	if personaCall.Tool != "persona_runtime" || personaCall.Action != "shadow_triage" || !personaCall.Success || personaCall.Result != persona.DecisionDelegateWorker {
		t.Fatalf("persona tool call = %#v, want successful delegate_worker shadow", personaCall)
	}
	shadow, ok := updated.Metadata["persona_shadow"].(map[string]any)
	if !ok {
		t.Fatalf("persona_shadow metadata = %#v, want object", updated.Metadata["persona_shadow"])
	}
	if shadow["decision"] != persona.DecisionDelegateWorker || shadow["success"] != true {
		t.Fatalf("persona_shadow metadata = %#v, want successful delegate_worker", shadow)
	}
	if updated.Metadata["persona_shadow_queued"] != false {
		t.Fatalf("persona_shadow_queued = %#v, want false after completion", updated.Metadata["persona_shadow_queued"])
	}
}

func TestSlackTriageLivePersonaForegroundPostsPersonaReplyInsteadOfCodexAction(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex suggested a reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"200.000"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir, PilotUserID: "U_PENG"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi 读完后给一个轻量回复。",
		Reason:      "persona foreground owns the visible reply",
		Confidence:  0.82,
		Citations:   []persona.Citation{{Kind: "memory", SourceRef: "memory/team/persona-foreground.md:4", Snippet: "这个没人回，oneesama 应该补一下吗？"}},
		WorkerRequests: []persona.WorkerRequest{{
			Kind:   "agent_read",
			Prompt: "read linked article before next follow-up",
		}},
		MemoryWrites: []persona.MemoryWrite{{
			Kind:      "episode",
			Text:      "Peng asked Oneesama to use Pi persona for memory-backed replies.",
			SourceRef: "slack:C_TRIAGE:200.000",
		}},
		ShadowOnly: false,
	}}
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "这个没人回，oneesama 应该补一下吗？",
		TS:             "200.000",
	}}, "#meeting-avatar: 这个没人回，oneesama 应该补一下吗？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalization", started)
	}
	if started.Finalization.Run.Metadata["persona_foreground_queued"] != true {
		t.Fatalf("metadata = %#v, want persona_foreground_queued", started.Finalization.Run.Metadata)
	}

	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "200.000" {
		t.Fatalf("post call = %#v, want direct thread reply", calls[0])
	}
	if got := calls[0].Text; !strings.Contains(got, "Pi 读完后") || strings.Contains(got, "Pending action") || strings.Contains(got, "codex visible reply") {
		t.Fatalf("posted text = %q, want direct Pi reply and no Codex visible reply", got)
	}

	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if updated.Mutations != 1 || updated.Failures != 0 {
		t.Fatalf("updated mutations/failures = %d/%d, want one public reply mutation; run=%#v", updated.Mutations, updated.Failures, updated)
	}
	if updated.Metadata["persona_dynamic_context_expected"] != true {
		t.Fatalf("metadata = %#v, want persona_dynamic_context_expected", updated.Metadata)
	}
	if intFromAny(updated.Metadata["persona_dynamic_context_count"]) == 0 {
		t.Fatalf("metadata = %#v, want persona_dynamic_context_count > 0", updated.Metadata)
	}
	if updated.Metadata["context_budget_expected"] != true ||
		intFromAny(updated.Metadata["context_budget_stable_tokens"]) <= 0 ||
		intFromAny(updated.Metadata["context_budget_dynamic_tokens"]) <= 0 ||
		intFromAny(updated.Metadata["context_budget_total_tokens"]) <= 0 {
		t.Fatalf("metadata = %#v, want persona context budget audit", updated.Metadata)
	}
	if len(updated.Actions) != 1 || !strings.Contains(updated.Actions[0].Brief, "Review reply") {
		t.Fatalf("actions = %#v, want one persona action", updated.Actions)
	}
	var sawForeground bool
	var sawThreadReply bool
	for _, call := range updated.ToolCalls {
		if call.Tool == "persona_runtime" && call.Action == "foreground_triage" && call.Success && call.Result == persona.DecisionReply {
			sawForeground = true
		}
		if call.Tool == "slack_api" && call.Action == "post_thread_reply" && call.Success {
			sawThreadReply = true
		}
	}
	if !sawForeground || !sawThreadReply {
		t.Fatalf("tool calls = %#v, want persona foreground + direct thread reply", updated.ToolCalls)
	}
	pending, err := service.triage.ListPendingActions(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListPendingActions: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending actions = %#v, want no pending thread reply", pending)
	}
	if updated.Metadata["persona_foreground_queued"] != false {
		t.Fatalf("metadata = %#v, want foreground queue cleared", updated.Metadata)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok {
		t.Fatalf("persona_foreground = %#v, want metadata object", updated.Metadata["persona_foreground"])
	}
	if lenStringSliceFromAny(foreground["worker_requests"]) != 1 || lenStringSliceFromAny(foreground["memory_writes"]) != 1 {
		t.Fatalf("persona_foreground = %#v, want worker request and memory write intent summaries", foreground)
	}
	files := stringSliceFromAny(updated.Metadata["persona_memory_write_files"])
	if len(files) != 1 {
		t.Fatalf("persona_memory_write_files = %#v, want one durable memory file", updated.Metadata["persona_memory_write_files"])
	}
	raw, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(files[0])))
	if err != nil {
		t.Fatalf("read persona memory write %s: %v", files[0], err)
	}
	if text := string(raw); !strings.Contains(text, "Peng asked Oneesama to use Pi persona") || !strings.Contains(text, "slack:C_TRIAGE:200.000") {
		t.Fatalf("persona memory file = %q, want Pi supplied memory text and source", text)
	}
	search := service.SearchRelatedMemory("Pi persona memory-backed replies", SlackRelatedMemorySearchOptions{Limit: 5})
	if record := firstPersonaRelatedMemory(search.Results); record == nil {
		t.Fatalf("search results = %#v, want durable persona memory evidence", search.Results)
	} else {
		if record.Kind != "persona_memory_write" {
			t.Fatalf("persona memory kind = %q, want persona_memory_write; record=%#v", record.Kind, *record)
		}
		if !relatedMemoryReasonsContain(record.Reasons, "family_boost:persona_memory_write") {
			t.Fatalf("persona memory reasons = %#v, want persona_memory_write family boost", record.Reasons)
		}
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.requests) != 1 || runtime.requests[0].Mode != persona.ModeLive {
		t.Fatalf("persona requests = %#v, want one live request", runtime.requests)
	}
}

func firstPersonaRelatedMemory(records []SlackRelatedMemoryRecord) *SlackRelatedMemoryRecord {
	for index := range records {
		if strings.HasPrefix(records[index].SourcePath, "memory/persona/writes/") {
			return &records[index]
		}
	}
	return nil
}

func TestPersistPersonaForegroundMemoryWritesRoutesIdentityContradictionToReview(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/oneesama-identity.md", strings.Join([]string{
		"# Oneesama identity",
		"",
		"kind: foreground_identity",
		"scope: foreground",
		"subject: oneesama",
		"Oneesama foreground identity is Oneesama Pi agent serving Slack and meetings.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})
	result := SlackPersonaShadowResult{
		Success:   true,
		RequestID: "req_identity_conflict",
		Runtime:   persona.ProviderPi,
		Decision:  persona.DecisionReply,
		ChannelID: "C_TRIAGE",
		ThreadTS:  "200.000",
		memoryRecords: []persona.MemoryWrite{{
			Kind:      "identity_fact",
			Text:      "kind: worker_identity\nscope: worker\nsubject: oneesama\nOneesama is codex-3720 delegated worker.",
			SourceRef: "slack:C_TRIAGE:200.000",
			Metadata: map[string]any{
				"kind":    "worker_identity",
				"scope":   "worker",
				"subject": "oneesama",
				"source":  "codex-3720",
			},
		}},
	}

	persistence := service.persistPersonaForegroundMemoryWrites(context.Background(), result)
	if len(persistence.Files) != 0 {
		t.Fatalf("persona memory files = %#v, want no active writes for contradiction", persistence.Files)
	}
	if persistence.ContradictionReviews != 1 || len(persistence.ContradictionReviewFiles) != 1 {
		t.Fatalf("persistence = %#v, want one contradiction review file", persistence)
	}
	reviewRel := persistence.ContradictionReviewFiles[0]
	if !strings.HasPrefix(reviewRel, "memory/persona/contradiction-review/") {
		t.Fatalf("contradiction review path = %q, want contradiction-review lane", reviewRel)
	}
	raw, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(reviewRel)))
	if err != nil {
		t.Fatalf("read contradiction review %s: %v", reviewRel, err)
	}
	text := string(raw)
	for _, want := range []string{
		"Status: contradiction_review",
		"worker_identity_write_conflicts_with_foreground_identity_fact",
		"memory/team/facts/oneesama-identity.md",
		"Oneesama is codex-3720 delegated worker.",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("contradiction review file = %q, want %q", text, want)
		}
	}
	search := service.SearchRelatedMemory("Oneesama codex-3720 worker identity", SlackRelatedMemorySearchOptions{Limit: 8})
	for _, record := range search.Results {
		if strings.HasPrefix(record.SourcePath, "memory/persona/writes/") {
			t.Fatalf("search results = %#v, contradiction leaked into active persona writes", search.Results)
		}
	}
}

func stringSliceFromAny(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(fmt.Sprint(item)); text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func TestSlackTriageCodexOnlyDoesNotCallPersonaRuntime(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_codex_only",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex-only reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"200.000","evidence_anchors":[{"kind":"explicit_user_command","source_ref":"slack:C_TRIAGE:200.000","quote":"这个 thread 值得回一下。"}]}]}`,
	}}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi/Linger should not be called.",
		Confidence:  0.9,
		ShadowOnly:  false,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			PilotUserID:  "U_PENG",
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: "codex_only"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "这个 thread 值得回一下。",
		TS:             "200.000",
	}}, "#meeting-avatar: 这个 thread 值得回一下。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want Codex finalization", started)
	}
	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "200.000" || !strings.Contains(calls[0].Text, "codex visible reply") {
		t.Fatalf("poster calls = %#v, want direct Codex thread reply", calls)
	}
	runtime.mu.Lock()
	requests := len(runtime.requests)
	runtime.mu.Unlock()
	if requests != 0 {
		t.Fatalf("persona runtime requests = %d, want 0 in codex_only foreground chain", requests)
	}
	updated := started.Finalization.Run
	if updated.Metadata["foreground_chain"] != slackTriageForegroundChainCodexOnly {
		t.Fatalf("metadata = %#v, want foreground_chain=codex_only", updated.Metadata)
	}
	if boolFromAny(updated.Metadata["persona_foreground_queued"], false) || boolFromAny(updated.Metadata["persona_shadow_queued"], false) {
		t.Fatalf("metadata = %#v, want no persona queues", updated.Metadata)
	}
}

func TestSlackTriageLivePersonaForegroundFailureSuppressesCodexFallback(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_error",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex suggested a reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"200.000"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = &capturePersonaRuntime{err: errors.New("pi sidecar unavailable")}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "请补一下这个 thread。",
		TS:             "200.000",
	}}, "#meeting-avatar: 请补一下这个 thread。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no Codex fallback post when persona foreground fails", got)
	}
	if updated.Status != "failed" || !strings.Contains(updated.Error, "pi sidecar unavailable") {
		t.Fatalf("run status/error = %q/%q, want foreground failure recorded", updated.Status, updated.Error)
	}
	if updated.Mutations != 0 || updated.Failures != 1 {
		t.Fatalf("run mutations/failures = %d/%d, want 0/1", updated.Mutations, updated.Failures)
	}
}

func TestSlackTriageLivePersonaRequestIncludesFilteredCandidateButPiOwnsVisibleReply(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_candidate_with_pi_reply",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex found a useful factual reply","actions":[{"type":"post_thread_reply","title":"factual reply","message":"Google 这轮发布更像是在预热 Gemini 2.5 的能力更新。","channelId":"C_TRIAGE","threadTs":"200.000","confidence":0.74,"requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{BotUserID: "U_ONEE", PilotUserID: "U_PENG"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "我查了下，更像是在预热 Gemini 2.5 的能力更新。",
		Reason:      "persona used the candidate action as evidence, then owned the visible reply",
		Confidence:  0.61,
		Citations:   []persona.Citation{{Kind: "memory", SourceRef: "memory/team/model-launch.md:4", Snippet: "Google 这次到底要发什么模型？"}},
		ShadowOnly:  false,
	}}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U_ONEE> Google 这次到底要发什么模型？",
		TS:             "200.000",
	}}, "#meeting-avatar: <@U_ONEE> Google 这次到底要发什么模型？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "200.000" || !strings.Contains(calls[0].Text, "我查了下") || strings.Contains(calls[0].Text, "Google 这轮发布") {
		t.Fatalf("poster calls = %#v, want direct Pi-owned reply, not raw Codex candidate", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if updated.Mutations != 1 || updated.Failures != 0 {
		t.Fatalf("updated mutations/failures = %d/%d, want one public reply mutation", updated.Mutations, updated.Failures)
	}
	if len(updated.Actions) != 1 || updated.Actions[0].Brief != "Review reply" {
		t.Fatalf("actions = %#v, want Pi persona action recorded", updated.Actions)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok || boolFromAny(foreground["codex_fallback"], false) {
		t.Fatalf("persona_foreground = %#v, want no Codex-visible fallback marker", updated.Metadata["persona_foreground"])
	}
	if foreground["decision"] != persona.DecisionReply || !strings.Contains(fmt.Sprint(foreground["visible_text"]), "我查了下") {
		t.Fatalf("persona_foreground = %#v, want Pi reply metadata", foreground)
	}
	runtime := service.personaRuntime.(*capturePersonaRuntime)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.requests) != 1 {
		t.Fatalf("persona requests = %#v, want one request", runtime.requests)
	}
	var sawCandidate bool
	for _, item := range runtime.requests[0].Context {
		if item.Kind == "triage_candidate_actions" && strings.Contains(item.Text, "Google 这轮发布") {
			sawCandidate = true
			break
		}
	}
	if !sawCandidate {
		t.Fatalf("persona request context = %#v, want filtered candidate action evidence", runtime.requests[0].Context)
	}
}

func TestSlackTriageLivePersonaStaySilentDoesNotPostOldBridgeMentionCandidate(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_old_bridge_mention",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex suggested answering old Bridge mention","actions":[{"type":"post_thread_reply","title":"old bridge reply","message":"我来补一个回答。","channelId":"C_TRIAGE","threadTs":"200.000","confidence":0.8,"requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{BotUserID: "U_ONEE"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "the user addressed another bot identity",
		ShadowOnly: false,
	}}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U09SF0MQZ5M> 我们讨论过这个 repo 嘛？",
		TS:             "200.000",
	}}, "#meeting-avatar: <@U09SF0MQZ5M> 我们讨论过这个 repo 嘛？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no fallback when user addressed old Bridge", got)
	}
	if updated.Mutations != 0 || len(updated.Actions) != 0 {
		t.Fatalf("updated mutations/actions = %d/%#v, want no action", updated.Mutations, updated.Actions)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok {
		t.Fatalf("persona_foreground = %#v, want metadata object", updated.Metadata["persona_foreground"])
	}
	if boolFromAny(foreground["codex_fallback"], false) {
		t.Fatalf("persona_foreground = %#v, want no Codex visible fallback marker", foreground)
	}
	if intFromAny(updated.Metadata["codex_suggested_actions"]) != 0 {
		t.Fatalf("metadata = %#v, want Codex action filtered before persona fallback", updated.Metadata)
	}
}

func TestSlackTriagePiFirstLiveSkipsPrePiRunnerAndPostsPersonaReply(t *testing.T) {
	ctx := context.Background()
	workspaceDir, err := os.MkdirTemp("", "oneesama-pi-first-live-*")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer func() { _ = os.RemoveAll(workspaceDir) }()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start_before_pi",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex should not run","actions":[{"type":"post_thread_reply","message":"wrong"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			PilotUserID:  "U_PENG",
			Triage: appconfig.SlackTriageConfig{
				ForegroundChain: "pi_first_live",
				WorkspacePolicy: "In this workspace, reply to source-backed product-adjacent articles when evidence is available.",
			},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi-first 直接评价：这篇文章和我们的产品判断很接近。",
		Reason:      "workspace policy says to engage product-adjacent evidence-backed links",
		Confidence:  0.86,
		Citations:   []persona.Citation{{Kind: "memory", SourceRef: "memory/team/product-links.md:4", Snippet: "这条产品评论文章你怎么看？"}},
		ShadowOnly:  false,
	}}
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U_ONEE> 这条产品评论文章你怎么看？",
		TS:             "220.000",
	}}, "#meeting-avatar: <@U_ONEE> 这条产品评论文章你怎么看？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Job != nil || started.Finalization != nil {
		t.Fatalf("started = %#v, want no pre-Pi agent_runner job/finalization", started)
	}
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want no pre-Pi StartTask", runner.startCount)
	}
	poster.WaitForCalls(t, 1)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount after Pi reply = %d, want no StartTask", runner.startCount)
	}
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "220.000" || !strings.Contains(calls[0].Text, "Pi-first 直接评价") {
		t.Fatalf("poster calls = %#v, want direct Pi-first thread reply", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if updated.Metadata["foreground_chain"] != slackTriageForegroundChainPiFirstLive {
		t.Fatalf("metadata = %#v, want foreground_chain=pi_first_live", updated.Metadata)
	}
	if boolFromAny(updated.Metadata["pre_pi_agent_runner_started"], true) {
		t.Fatalf("metadata = %#v, want pre_pi_agent_runner_started=false", updated.Metadata)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionReply {
		t.Fatalf("metadata = %#v, want pi_first_decision=reply", updated.Metadata)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.requests) != 1 || runtime.requests[0].Mode != persona.ModeLive {
		t.Fatalf("persona requests = %#v, want one live request", runtime.requests)
	}
	var sawDigest, sawCandidate bool
	for _, item := range runtime.requests[0].Context {
		switch item.Kind {
		case "triage_digest":
			sawDigest = strings.Contains(item.Text, "产品评论文章")
		case "triage_candidate_actions":
			sawCandidate = true
		}
	}
	if policy := personaDynamicContextText(runtime.requests[0].DynamicContext, "workspace_triage_policy"); !strings.Contains(policy, "product-adjacent") {
		t.Fatalf("persona dynamic context = %#v, want workspace policy envelope", runtime.requests[0].DynamicContext)
	}
	if !sawDigest || sawCandidate {
		t.Fatalf("persona context = %#v, want digest and no Codex candidate actions", runtime.requests[0].Context)
	}
}

func TestSlackTriagePiFirstLiveDelegatesWorkerAfterPiDecision(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "needs repository/tool inspection before answering",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "inspect-repo",
			Kind:   "codex",
			Prompt: "Inspect the linked repository and summarize whether it overlaps with our product.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
		Confidence: 0.41,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_delegate_after_pi",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U_ONEE> 这个 repo 和我们的产品方向重合吗？",
		TS:             "221.000",
	}}, "#meeting-avatar: <@U_ONEE> 这个 repo 和我们的产品方向重合吗？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want exactly one post-Pi delegate worker", runner.startCount)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate decision + one worker job", updated.Metadata)
	}
	slack, ok := mapFromAny(runner.startInput.Context["slack"])
	if !ok || stringFromAny(slack["channel_id"]) != "C_TRIAGE" || stringFromAny(slack["thread_ts"]) != "221.000" {
		t.Fatalf("runner slack context = %#v, want channel/thread context", runner.startInput.Context["slack"])
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner context session_kind = %#v, want secretary_lookup", runner.startInput.Context["session_kind"])
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer asynchronously later", got)
	}
}

func TestPersonaDelegateWorkerAlreadyHandledReasonDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		reason    string
		visible   string
		wantMatch string
	}{
		{
			name: "already_reviewed_pr",
			reason: strings.Join([]string{
				"Claude (U0AMN6TKVJ8) has already reviewed and approved PR #444 in msg_ts:1779442634.699649, directly addressing the request.",
				"No further triage action needed.",
			}, " "),
			wantMatch: "already reviewed",
		},
		{
			name: "nothing_to_add_reply",
			visible: strings.Join([]string{
				"This is a technical statement about the authorization flow working on web now.",
				"No external link to look up here, and the persona already determined this thread is handled.",
				"Nothing for me to add.",
			}, " "),
			wantMatch: "nothing for me to add",
		},
		{
			name: "already_approved_sibling_pr",
			reason: strings.Join([]string{
				"codex-3720 resolved the underlying bug via PR #2017, and the sibling PR at #444 was already approved.",
				"No further action is needed.",
			}, " "),
			wantMatch: "already approved",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09LB7V1WGJ:1779442219.313689",
				ChannelID:   "C09LB7V1WGJ",
				ThreadTS:    "1779442219.313689",
				Decision:    persona.DecisionDelegateWorker,
				Reason:      tc.reason,
				VisibleText: tc.visible,
				workerRecords: []persona.WorkerRequest{{
					ID:     "secretary-link-fact-lookup",
					Kind:   "codex",
					Prompt: "Summarize this thread.",
					Context: map[string]any{
						"delegation_scope": "secretary_lookup",
					},
				}},
				WorkerRequests: []string{"secretary-link-fact-lookup"},
			}

			downgraded, toolCalls := applyPersonaCompletedDelegationDisposition(result)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if downgraded.VisibleText != "" {
				t.Fatalf("VisibleText = %q, want empty", downgraded.VisibleText)
			}
			if len(downgraded.workerRecords) != 0 || len(downgraded.WorkerRequests) != 0 {
				t.Fatalf("worker records = %#v summaries = %#v, want none", downgraded.workerRecords, downgraded.WorkerRequests)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "delegate_worker_already_handled_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want already-handled suppression with marker %q", toolCalls, tc.wantMatch)
			}

			runner := &fakeRunner{job: agentrunner.Job{
				ID:       "job_should_not_start",
				Provider: "codex",
				Status:   agentrunner.StatusRunning,
			}}
			service := NewService(Config{Runner: runner})
			started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 99, downgraded, persona.Request{}, nil)
			if runner.startCount != 0 || len(started.JobIDs) != 0 {
				t.Fatalf("runner.startCount=%d started=%#v, want no worker start", runner.startCount, started)
			}
		})
	}
}

func TestPersonaAmbientDelegateWorkerDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		reason    string
		messages  []SlackInboundMessage
		botUserID string
		wantMatch string
	}{
		{
			name:   "mentions_another_user_without_bot",
			reason: "用户分享了一个Cue共享链接询问压缩视频性能问题，但triage无法直接访问共享内容，需委托worker检索以提供有依据的回应。",
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L4CPK3BL",
				Text:      "<https://app.cue.surf/c/eaa6adb7-129d-4542-b36d-c430d311a23b> 看看这个压缩视频的为什么这么慢，是不是在找工具 <@U09L0U0SJ3F> :eyes:",
				TS:        "1779442587.111859",
				ThreadTS:  "1779438182.306539",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "mentioned_other_user_without_bot",
		},
		{
			name:   "no_explicit_question_or_bot_mention",
			reason: "Two technical progress messages from team members in the same channel—one about API latency improvement/CH migration, another about redeem code UX limitation. No explicit question or @Oneesama. Workspace policy allows lightweight product-adjacent commentary, but the topic is internal engineering progress.",
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L0U0SJ3F",
				Text:      "现在api响应基本压到1s以内了，ch还没搬完，下周搬完后把可以把历史数据和中转逻辑去掉，直传ch后应该可以进一步加速",
				TS:        "1779438182.306539",
				ThreadTS:  "1779438182.306539",
				Files: []SlackFile{{
					ID:       "F0B5NB5T75J",
					Name:     "image.png",
					Filetype: "png",
					Mimetype: "image/png",
				}},
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "no_explicit_question_or_bot_mention",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := SlackPersonaShadowResult{
				Success:   true,
				RequestID: "triage:C09KVPBMLJ3:1779438182.306539",
				ChannelID: "C09KVPBMLJ3",
				ThreadTS:  "1779438182.306539",
				Decision:  persona.DecisionDelegateWorker,
				Reason:    tc.reason,
				workerRecords: []persona.WorkerRequest{{
					ID:     "ambient-secretary-lookup",
					Kind:   "codex",
					Prompt: "Synthesize a concise answer.",
					Context: map[string]any{
						"delegation_scope": "secretary_lookup",
					},
				}},
				WorkerRequests: []string{"ambient-secretary-lookup"},
			}

			downgraded, toolCalls := applyPersonaAmbientDelegationDisposition(result, tc.messages, tc.botUserID)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if len(downgraded.workerRecords) != 0 || len(downgraded.WorkerRequests) != 0 {
				t.Fatalf("worker records = %#v summaries = %#v, want none", downgraded.workerRecords, downgraded.WorkerRequests)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "delegate_worker_ambient_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want ambient suppression marker %q", toolCalls, tc.wantMatch)
			}
		})
	}
}

func TestPersonaAmbientDirectReplyDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		result    SlackPersonaShadowResult
		messages  []SlackInboundMessage
		botUserID string
		wantMatch string
	}{
		{
			name: "speculative_direct_reply_without_bot_mention",
			result: SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09LB7V1WGJ:1779446155.743689",
				ChannelID:   "C09LB7V1WGJ",
				ThreadTS:    "1779446155.743689",
				Decision:    persona.DecisionReply,
				VisibleText: "从之前的讨论看，local VM 文件变更检测原本有一个确认面板，现在可能被「直接完成」取代了。要不要看看最近的 release note 或代码变更？",
				Reason:      "User is discussing a missing file change panel; memory provides relevant context to comment briefly.",
			},
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09LB7V1WGJ",
				UserID:    "U09KY0GE28K",
				Text:      "vm 用得少了？",
				TS:        "1779446155.743689",
				ThreadTS:  "1779446155.743689",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "ambient_speculative_direct_reply",
		},
		{
			name: "mentions_another_user_without_bot",
			result: SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09KVPBMLJ3:1779438182.306539",
				ChannelID:   "C09KVPBMLJ3",
				ThreadTS:    "1779438182.306539",
				Decision:    persona.DecisionReply,
				VisibleText: "这个压缩视频慢可能是因为 ffmpeg 转码。",
			},
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L4CPK3BL",
				Text:      "<https://app.cue.surf/c/eaa6adb7-129d-4542-b36d-c430d311a23b> 看看这个压缩视频的为什么这么慢，是不是在找工具 <@U09L0U0SJ3F> :eyes:",
				TS:        "1779442587.111859",
				ThreadTS:  "1779438182.306539",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "mentioned_other_user_without_bot",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			downgraded, toolCalls := applyPersonaAmbientDirectReplyDisposition(tc.result, tc.messages, tc.botUserID)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if downgraded.VisibleText != "" {
				t.Fatalf("VisibleText = %q, want empty", downgraded.VisibleText)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "persona_reply_ambient_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want ambient direct reply suppression marker %q", toolCalls, tc.wantMatch)
			}
		})
	}
}

func TestPersonaAmbientDirectReplyKeepsAddressedBotAnswer(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C123:177.123",
		ChannelID:   "C123",
		ThreadTS:    "177.123",
		Decision:    persona.DecisionReply,
		VisibleText: "看起来根因是重复 Socket Mode listener 抢走了 Slack interaction。",
	}
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "<@U0AP5UFU0FR> 为什么 Join with realtime 点完会回到默认卡片？",
		TS:        "177.123",
		ThreadTS:  "177.123",
	}}
	got, toolCalls := applyPersonaAmbientDirectReplyDisposition(result, messages, "U0AP5UFU0FR")
	if got.Decision != persona.DecisionReply || got.VisibleText != result.VisibleText || len(toolCalls) != 0 {
		t.Fatalf("result=%#v toolCalls=%#v, want addressed bot reply preserved", got, toolCalls)
	}
}

func TestPersonaVisibleReplyQualityGateSuppressesInternalMeta(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C09LB7V1WGJ:1779385051.079739",
		ChannelID:   "C09LB7V1WGJ",
		ThreadTS:    "1779371525.004829",
		Decision:    persona.DecisionReply,
		VisibleText: "根据 persona 分析，当前线程已被分类；persona 已判定 Oneesama 不应在此线程插话，我无可见输出。",
		Reason:      "The persona already classified this thread as no visible output.",
	}

	got, toolCalls := applyPersonaVisibleReplyQualityDisposition(result)
	if got.Decision != persona.DecisionStaySilent || got.VisibleText != "" {
		t.Fatalf("result = %#v, want stay_silent with empty visible text", got)
	}
	if len(toolCalls) != 1 || toolCalls[0].Action != "persona_reply_quality_gate_silent" || toolCalls[0].Result != "internal_control_plane_leak" {
		t.Fatalf("toolCalls = %#v, want quality gate block", toolCalls)
	}
	if actions := slackPersonaForegroundActions("C123", "123.456", got, persona.Request{}); len(actions) != 0 {
		t.Fatalf("actions = %#v, want no pending reply for internal meta", actions)
	}
}

func TestPersonaVisibleReplyQualityGateAllowsSourceBackedLinkSynthesis(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C09L0TAN31T:1779425315.544949",
		ChannelID:   "C09L0TAN31T",
		ThreadTS:    "1779425315.544949",
		Decision:    persona.DecisionReply,
		VisibleText: "《Claw Patrol: an open-source security firewall for agents | Deno》这条值得看的一点是：At Deno, agents help with production operations, but an agent cannot be trusted to police itself.",
		Reason:      "A substantive shared link is synthesis-eligible under the workspace policy or explicit thread request.",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://deno.com/blog/clawpatrol",
			Quote:     "Claw Patrol: an open-source security firewall for agents | Deno",
		}},
	}

	got, toolCalls := applyPersonaVisibleReplyQualityDisposition(result)
	if got.Decision != persona.DecisionReply || got.VisibleText == "" {
		t.Fatalf("result = %#v, want source-backed reply preserved", got)
	}
	if len(toolCalls) != 0 {
		t.Fatalf("toolCalls = %#v, want no quality gate block", toolCalls)
	}
}

func TestSlackTriagePiFirstLiveAutoDelegatesExternalLinkIdentityLookupAfterStaySilent(t *testing.T) {
	ctx := context.Background()
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`Title: User: Johnson8053 | Hacker News

Markdown Content:
HN profile for Johnson8053. Submissions include SQLite is the best home for AI agents and a link to github.com/zanwei/design-dna.`))
	}))
	defer reader.Close()
	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = reader.Client()
	slackExternalLinkReaderURL = func(string) string { return reader.URL + "/reader" }
	t.Cleanup(func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	})

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "uncertain identity and teammate said no idea",
		Confidence: 0.37,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_hn_secretary_lookup",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_HEYANG",
		Text:           "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:             "500.000",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_VINCENT",
		Text:           "不认识 他咋了？",
		TS:             "501.000",
	}}, "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁\n不认识 他咋了？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want secretary lookup worker after Pi stay_silent", runner.startCount)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no pre-evidence visible reply", got)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["secretary_lookup_auto_delegates"]) != 1 {
		t.Fatalf("metadata = %#v, want auto-delegated secretary lookup", updated.Metadata)
	}
	if got := stringFromAny(runner.startInput.Context["session_kind"]); got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner session_kind = %q, want secretary lookup case", got)
	}
	if prompt := runner.startInput.Task + "\n" + stringFromAny(runner.startInput.Context["slackAssistantPrompt"]); !strings.Contains(prompt, "Johnson8053") || !strings.Contains(prompt, "github.com/zanwei/design-dna") || !strings.Contains(prompt, "concrete evidence") || !strings.Contains(prompt, `"evidence_anchors"`) {
		t.Fatalf("secretary lookup prompt missing old-slackd evidence shape:\n%s", prompt)
	}
}

func TestSlackTriagePiFirstLiveUpgradesProductLinkReactionToSecretaryLookup(t *testing.T) {
	ctx := context.Background()
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`Title: Tana announces meeting workspace

Markdown Content:
Tana is adding meeting workflows, agenda notes, and collaboration features.`))
	}))
	defer reader.Close()
	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = reader.Client()
	slackExternalLinkReaderURL = func(string) string { return reader.URL + "/reader" }
	t.Cleanup(func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	})

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	reactions := &recordingReactions{}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionReact,
		Reason:   "Casual banter reacting to a product pivot link share. No question or request.",
		Reactions: []persona.ReactionIntent{{
			Emoji:      "吃瓜",
			Confidence: 0.9,
			Reason:     "spectating",
		}},
		Confidence: 0.9,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_tana_product_link_lookup",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				ForegroundChain: "pi_first_live",
				WorkspacePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent AI agent, coding tool, creative workflow, Memory, Bridge/Cue-like collaboration, AI lab/researcher, and coding-agent ecosystem topics, even in casual channels.",
			},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster:    poster,
		Reactions: reactions,
		Runner:    runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C09L0TAN31T", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_PENG",
		Text:           "转业了 https://tana.inc/",
		TS:             "1779421855.728099",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_TEAMMATE",
		Text:           "这尼玛 woc meeting 要和Zoom干？",
		TS:             "1779421882.604639",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_TEAMMATE",
		Text:           "这感觉怕是有点难哦",
		TS:             "1779421920.854339",
	}}, "#watercooler: 转业了 https://tana.inc/\n这尼玛 woc meeting 要和Zoom干？\n这感觉怕是有点难哦")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want secretary lookup worker after product link reaction", runner.startCount)
	}
	if got := len(reactions.Calls()); got != 0 {
		t.Fatalf("reaction calls = %d, want no reaction-only product link disposition", got)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer asynchronously later", got)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate_worker after reaction guard", updated.Metadata)
	}
	if !hasTriageToolCall(updated.ToolCalls, "persona_runtime", "product_link_reaction_upgraded_to_secretary_lookup") {
		t.Fatalf("tool calls = %#v, want product link reaction upgrade marker", updated.ToolCalls)
	}
	if got := stringFromAny(runner.startInput.Context["session_kind"]); got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner session_kind = %q, want secretary_lookup", got)
	}
	if prompt := runner.startInput.Task; !strings.Contains(prompt, "tana.inc") || !strings.Contains(prompt, "meeting") || !strings.Contains(prompt, "source") {
		t.Fatalf("secretary lookup prompt missing Tana product-link context:\n%s", prompt)
	}
}

func TestSlackTriageProductLinkReactionAlreadyHandledDoesNotDelegate(t *testing.T) {
	request := persona.Request{
		Event: persona.Event{Text: "review 一下 <https://github.com/AFK-surf/cue/pull/2033>"},
		Context: []persona.ContextItem{{
			Kind: "external_link_context",
			Text: "1. https://github.com/AFK-surf/cue/pull/2033\n   title: PR #2033",
		}},
		DynamicContext: []persona.DynamicContextEnvelope{{
			Kind:    "workspace_triage_policy",
			Content: "For this workspace, lightweight source-backed comments are welcome for product-adjacent links.",
		}},
	}
	result := SlackPersonaShadowResult{
		Success:   true,
		Decision:  persona.DecisionReact,
		Reason:    "Claude already approved PR #2033 in-thread; request is fully handled and no action needed.",
		Reactions: []string{"white_check_mark"},
		reactionRecords: []persona.ReactionIntent{{
			Emoji:      "white_check_mark",
			Confidence: 0.9,
			Reason:     "acknowledge completed review",
		}},
	}

	updated, calls := applyPersonaProductLinkReactionDisposition(result, request)
	if updated.Decision != persona.DecisionReact {
		t.Fatalf("Decision = %q, want reaction preserved", updated.Decision)
	}
	if len(updated.workerRecords) != 0 || len(updated.WorkerRequests) != 0 {
		t.Fatalf("worker records = %#v summaries=%#v, want no delegate", updated.workerRecords, updated.WorkerRequests)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_reaction_preserved_already_handled" || !strings.Contains(calls[0].Result, "already approved") {
		t.Fatalf("tool calls = %#v, want already-handled product-link guard", calls)
	}
}

func TestPersonaDelegatedWorkerDefaultsToReadOnlyUnlessExplicitlyAuthorized(t *testing.T) {
	lookup := personaDelegatedWorkerSessionKind(persona.WorkerRequest{
		Prompt:  "Please inspect this PR review thread and summarize the facts.",
		Context: map[string]any{"delegation_scope": "review_followup"},
	})
	if lookup != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("session kind = %q, want secretary_lookup for untrusted delegated worker", lookup)
	}

	code := personaDelegatedWorkerSessionKind(persona.WorkerRequest{
		Prompt:  "Peng explicitly asked: fix this Oneesama bug in code.",
		Context: map[string]any{"delegation_scope": "implementation"},
	})
	if code != agentrunner.SessionKindSlack {
		t.Fatalf("session kind = %q, want slack_case for explicitly authorized code work", code)
	}
}

func TestProductLinkReactionGuardFollowsWorkspacePolicy(t *testing.T) {
	request := persona.Request{
		Event: persona.Event{Text: "转业了 https://tana.inc/"},
		Context: []persona.ContextItem{{
			Kind: "external_link_context",
			Text: "1. https://tana.inc/\n   title: Tana\n   excerpt: Tana is adding meeting workflows and collaboration features.",
		}},
		DynamicContext: []persona.DynamicContextEnvelope{{
			Kind:    "workspace_triage_policy",
			Content: "For this workspace, lightweight source-backed comments are welcome for product-adjacent articles.",
		}},
	}
	if !slackPersonaRequestNeedsProductLinkCommentary(request) {
		t.Fatal("workspace policy should enable source-backed link commentary")
	}

	noPolicy := request
	noPolicy.DynamicContext = nil
	if slackPersonaRequestNeedsProductLinkCommentary(noPolicy) {
		t.Fatal("reaction guard should not hard-code product topics without workspace policy")
	}

	explicitAsk := noPolicy
	explicitAsk.Event.Text = "看看这个 https://tana.inc/"
	if !slackPersonaRequestNeedsProductLinkCommentary(explicitAsk) {
		t.Fatal("explicit link synthesis request should still trigger lookup without workspace policy")
	}
}

func TestProductLinkSynthesisDispositionConvertsDelegateToVisibleReply(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_PAPERS",
		UserID:    "U_PENG",
		Text:      "<https://arxiv.org/html/2510.04607v2>",
		TS:        "1779434704.255149",
	}, {
		TeamID:    "T123",
		ChannelID: "C_PAPERS",
		UserID:    "U_TEAMMATE",
		Text:      "写成论文可还行",
		TS:        "1779434750.000000",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_PAPERS",
		ThreadTS:  "1779434704.255149",
		Messages:  messages,
		Digest:    "#papers: https://arxiv.org/html/2510.04607v2\n写成论文可还行",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://arxiv.org/html/2510.04607v2",
			Title:   "A Benchmark for Evaluating Agentic Systems",
			Excerpt: "The paper evaluates AI agent systems, tool use, planning, reliability, and benchmark methodology across multiple tasks.",
			Source:  "reader",
		}},
		WorkspaceTriagePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent AI agent papers and coding-agent ecosystem links.",
	})
	result, calls := applyPersonaProductLinkSynthesisDisposition(SlackPersonaShadowResult{
		Success:       true,
		Decision:      persona.DecisionDelegateWorker,
		Reason:        "Paper link matches workspace policy but Memory evidence is missing.",
		Confidence:    0.72,
		workerRecords: []persona.WorkerRequest{{ID: "lookup", Kind: "codex"}},
		WorkerRequests: []string{
			"codex: lookup",
		},
	}, request, messages)

	if result.Decision != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		t.Fatalf("result=%#v, want visible reply", result)
	}
	if len(result.workerRecords) != 0 || len(result.WorkerRequests) != 0 {
		t.Fatalf("worker records = %#v summaries=%#v, want cleared", result.workerRecords, result.WorkerRequests)
	}
	if !strings.Contains(result.VisibleText, "A Benchmark for Evaluating Agentic Systems") {
		t.Fatalf("VisibleText = %q, want synthesized paper title", result.VisibleText)
	}
	if len(result.EvidenceAnchors) < 2 || result.EvidenceAnchors[1].Kind != slackVisibleEvidenceKindFetchedLink {
		t.Fatalf("evidence anchors = %#v, want fetched-link evidence", result.EvidenceAnchors)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_synthesized_visible_reply" {
		t.Fatalf("tool calls = %#v, want synthesis marker", calls)
	}
}

func TestProductLinkSynthesisDispositionKeepsIdentityLookupDelegated(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:        "500.000",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages:  messages,
		Digest:    "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		WorkspaceTriagePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent links.",
	})
	result, calls := applyPersonaProductLinkSynthesisDisposition(SlackPersonaShadowResult{
		Success:       true,
		Decision:      persona.DecisionDelegateWorker,
		workerRecords: []persona.WorkerRequest{{ID: "lookup", Kind: "codex"}},
	}, request, messages)

	if result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v, want identity lookup to remain delegated", result)
	}
	if len(calls) != 0 {
		t.Fatalf("tool calls = %#v, want no synthesis for identity lookup", calls)
	}
}

func TestExplicitSmokeCommandDispositionConvertsSilentToAck(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_BENCH",
		UserID:    "U_PENG",
		Text:      "@oneesama smoke：用一句话确认你看到了这条，不要展开。",
		TS:        "1779450005.000005",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_BENCH",
		ThreadTS:  "1779450005.000005",
		Messages:  messages,
		Digest:    "#bench: @oneesama smoke：用一句话确认你看到了这条，不要展开。",
	})
	result, calls := applyPersonaExplicitSmokeCommandDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionStaySilent,
		Confidence: 0.4,
	}, request, messages)

	if result.Decision != persona.DecisionReply || result.VisibleText != "看到了。" {
		t.Fatalf("result=%#v, want short ack reply", result)
	}
	if len(result.EvidenceAnchors) != 1 || result.EvidenceAnchors[0].Kind != slackVisibleEvidenceKindExplicitUserCommand {
		t.Fatalf("anchors=%#v, want explicit command anchor", result.EvidenceAnchors)
	}
	if len(calls) != 1 || calls[0].Action != "explicit_smoke_command_visible_reply" {
		t.Fatalf("tool calls=%#v, want explicit smoke marker", calls)
	}
}

func TestPositiveStatusSummaryDispositionConvertsSilentToReaction(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{
			name: "status summary",
			text: "过去 24 小时概况：合并多项权限与 Willow 集成、对话/权限界面重构与若干 UX/后端修复；Linear 报告 5 条 issue 已同步。",
		},
		{
			name: "team daily report",
			text: "_2026-05-22 团队日报_ 今天主要是权限系统的集中重构日，zzj3720 推进权限审批流重构并修复若干 UI 问题。今日贡献者：zzj3720 · darksky。",
		},
		{
			name: "demo video share",
			text: "录了一个 computer use 操控 iPhone mirroring 创建 shortcut",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			messages := []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C_STATUS",
				UserID:    "U_STATUS_BOT",
				Text:      tc.text,
				TS:        "1779447920.433539",
				ThreadTS:  "1779447920.433539",
			}}
			request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
				ChannelID: "C_STATUS",
				ThreadTS:  "1779447920.433539",
				Messages:  messages,
				Digest:    "#status: " + tc.text,
			})
			result, calls := applyPersonaPositiveStatusSummaryReactionDisposition(SlackPersonaShadowResult{
				Success:    true,
				Decision:   persona.DecisionStaySilent,
				Confidence: 0.41,
			}, request, messages)

			if result.Decision != persona.DecisionReact {
				t.Fatalf("decision = %q, want react", result.Decision)
			}
			if len(result.reactionRecords) != 1 || result.reactionRecords[0].Emoji != "tada" || result.reactionRecords[0].MessageTS != "1779447920.433539" {
				t.Fatalf("reactionRecords=%#v, want tada on status message", result.reactionRecords)
			}
			if len(calls) != 1 || calls[0].Action != "positive_status_summary_reaction" {
				t.Fatalf("tool calls=%#v, want status summary marker", calls)
			}
		})
	}
}

func TestPositiveStatusSummaryDispositionPreservesHandledSilence(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_STATUS",
		UserID:    "U_STATUS_BOT",
		Text:      "Bridge Staging staging-v1.2.17-beta.795 is released. PASS conclusion posted with release/build details and screenshots.",
		TS:        "1779450072.599829",
		ThreadTS:  "1779450072.599829",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_STATUS",
		ThreadTS:  "1779450072.599829",
		Messages:  messages,
		Digest:    "#status: " + messages[0].Text,
	})
	result, calls := applyPersonaPositiveStatusSummaryReactionDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionStaySilent,
		Confidence: 0.95,
		Reason:     "The thread is fully handled by another worker; no open human request remains.",
	}, request, messages)

	if result.Decision != persona.DecisionStaySilent {
		t.Fatalf("decision = %q, want handled silence preserved", result.Decision)
	}
	if len(calls) != 0 {
		t.Fatalf("tool calls=%#v, want no reaction on handled worker thread", calls)
	}
}

func TestProductLinkReactionDispositionPreservesFullyHandledThread(t *testing.T) {
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_STATUS",
		ThreadTS:  "1779445997.412279",
		Messages: []SlackInboundMessage{{
			ChannelID: "C_STATUS",
			Text:      "Bridge Staging staging-v1.2.17-beta.794 is released. <https://github.com/AFK-surf/cueboard/releases/tag/staging-v1.2.17-beta.794>",
			TS:        "1779445997.412279",
			ThreadTS:  "1779445997.412279",
		}},
		Digest: "Bridge Staging staging-v1.2.17-beta.794 is released.",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://github.com/AFK-surf/cueboard/releases/tag/staging-v1.2.17-beta.794",
			Title:   "Build software better, together",
			Excerpt: "GitHub navigation chrome",
		}},
		WorkspaceTriagePolicy: "Reply to source-backed product-adjacent articles in this workspace.",
	})
	result, calls := applyPersonaProductLinkReactionDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionReact,
		Confidence: 0.95,
		Reason:     "The thread is fully handled; the worker already posted PASS and there is no open human request.",
		reactionRecords: []persona.ReactionIntent{{
			Emoji:     "tada",
			MessageTS: "1779450079.850319",
		}},
	}, request)

	if result.Decision != persona.DecisionReact {
		t.Fatalf("decision = %q, want reaction result preserved without worker upgrade", result.Decision)
	}
	if len(result.workerRecords) != 0 {
		t.Fatalf("workerRecords=%#v, want no secretary lookup upgrade", result.workerRecords)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_reaction_preserved_already_handled" {
		t.Fatalf("tool calls=%#v, want handled product-link guard", calls)
	}
}

func hasTriageToolCall(calls []SlackTriageToolCall, tool string, action string) bool {
	for _, call := range calls {
		if call.Tool == tool && call.Action == action && call.Success {
			return true
		}
	}
	return false
}

func handoffSourceRefsContain(refs []persona.HandoffSourceRef, kind string, sourceRef string) bool {
	for _, ref := range refs {
		if ref.Kind == kind && ref.SourceRef == sourceRef {
			return true
		}
	}
	return false
}

func stringSliceContainsSubstring(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func TestSecretaryLookupWorkerPromptCarriesMemoryEvidenceAndFollowupInstruction(t *testing.T) {
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages: []SlackInboundMessage{{
			TeamID:    "T123",
			ChannelID: "C_TRIAGE",
			UserID:    "U_HEYANG",
			Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
			TS:        "500.000",
		}, {
			TeamID:    "T123",
			ChannelID: "C_TRIAGE",
			UserID:    "U_VINCENT",
			Text:      "不认识 他咋了？",
			TS:        "501.000",
		}},
		Digest: "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁\n不认识 他咋了？",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "person_memory",
			SourcePath: "memory/people/zanwei.md",
			StartLine:  4,
			Content:    "Johnson8053 previously matched zanwei evidence: HN submissions mention affine, bridge, fireclaw, and github.com/zanwei/design-dna.",
			Score:      0.92,
		}},
	})
	result, calls := applyPersonaSecretaryLookupDisposition(SlackPersonaShadowResult{
		Success:    true,
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "uncertain identity",
		Confidence: 0.4,
	}, req)

	if len(calls) != 1 || result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v calls=%#v, want one secretary lookup worker", result, calls)
	}
	worker := result.workerRecords[0]
	prompt := worker.Prompt
	for _, want := range []string{
		"Do not stop at the first profile/article excerpt",
		"submissions, comments, favorites, repository",
		"Workspace Memory/person evidence",
		"memory/people/zanwei.md",
		"github.com/zanwei/design-dna",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("secretary lookup worker prompt missing %q:\n%s", want, prompt)
		}
	}
	if evidence := stringFromAny(worker.Context["workspace_memory_evidence"]); !strings.Contains(evidence, "memory/people/zanwei.md") || !strings.Contains(evidence, "Johnson8053") {
		t.Fatalf("workspace_memory_evidence = %q, want source-backed memory", evidence)
	}
}

func TestMediaLookupDispositionDelegatesVagueImageQuestion(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "这货是干啥的，",
		TS:        "700.000",
		Files: []SlackFile{{
			ID:       "F_IMG",
			Name:     "screenshot.png",
			Mimetype: "image/png",
		}},
	}}
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "700.000",
		Messages:  messages,
		Digest:    "#meeting-avatar: 这货是干啥的， [image screenshot.png]",
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "team_fact",
			SourcePath: "memory/team/facts/media.md",
			Content:    "Image identification questions should be delegated to secretary_lookup with Slack file evidence.",
			Score:      0.8,
		}},
	})
	result, calls := applyPersonaMediaLookupDisposition(SlackPersonaShadowResult{
		Success:    true,
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "needs image inspection",
		Confidence: 0.4,
	}, req, messages)

	if len(calls) != 1 || result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v calls=%#v, want one media lookup worker", result, calls)
	}
	worker := result.workerRecords[0]
	if got := stringFromAny(worker.Context["session_kind"]); got != "" {
		t.Fatalf("session_kind should be assigned when starting worker, got %q", got)
	}
	if got := stringFromAny(worker.Context["delegation_scope"]); got != "secretary_lookup" {
		t.Fatalf("delegation_scope = %q, want secretary_lookup", got)
	}
	if !strings.Contains(worker.Prompt, "slack.fetchImage") || !strings.Contains(worker.Prompt, "Workspace Memory/person evidence") {
		t.Fatalf("media worker prompt missing fetch/memory guidance:\n%s", worker.Prompt)
	}
	if _, ok := worker.Context["slack_image_files"]; !ok {
		t.Fatalf("worker context = %#v, want slack_image_files from attached image", worker.Context)
	}
}

func TestStartPersonaDelegatedSecretaryLookupWorkerEnrichesPiWorkerRequest(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_HEYANG",
		Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:        "500.000",
	}}
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages:  messages,
		Digest:    "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "person_memory",
			SourcePath: "memory/people/zanwei.md",
			Content:    "Johnson8053 evidence points at zanwei via github.com/zanwei/design-dna and workspace discussions.",
			Score:      0.91,
		}},
	})
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_direct_pi_secretary",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{Runner: runner})
	result := SlackPersonaShadowResult{
		Success:   true,
		RequestID: req.ID,
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Decision:  persona.DecisionDelegateWorker,
		workerRecords: []persona.WorkerRequest{{
			ID:     "pi-secretary-lookup",
			Kind:   "codex",
			Prompt: "Look up the HN user profile and answer who this is.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
	}

	started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 99, result, req, messages)
	if len(started.JobIDs) != 1 || runner.startCount != 1 {
		t.Fatalf("started=%#v runner.startCount=%d, want one worker", started, runner.startCount)
	}
	if got := runner.startInput.Context["session_kind"]; got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("session_kind = %#v, want secretary_lookup", got)
	}
	for _, want := range []string{
		"Do not stop at the first profile/article excerpt",
		`"evidence_anchors"`,
		"Workspace Memory/person evidence",
		"memory/people/zanwei.md",
		"github.com/zanwei/design-dna",
	} {
		if !strings.Contains(runner.startInput.Task, want) {
			t.Fatalf("direct Pi secretary worker task missing %q:\n%s", want, runner.startInput.Task)
		}
	}
	if evidence := stringFromAny(runner.startInput.Context["workspace_memory_evidence"]); !strings.Contains(evidence, "memory/people/zanwei.md") || !strings.Contains(evidence, "Johnson8053") {
		t.Fatalf("workspace_memory_evidence = %q, want request memory passed through", evidence)
	}
}

func TestStartPersonaDelegatedWorkerCarriesSwarmStyleHandoff(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "帮我查一下这个 HN 用户是谁",
		TS:        "600.000",
		ThreadTS:  "600.000",
	}}
	req := persona.Request{
		ID:    "pi-req-handoff",
		Event: persona.Event{Text: "帮我查一下这个 HN 用户是谁"},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: "C_TRIAGE",
			ThreadTS:  "600.000",
		},
		Context: []persona.ContextItem{{
			Kind:      "external_link_context",
			SourceRef: "https://news.ycombinator.com/user?id=Johnson8053",
			Text:      "HN profile: Johnson8053, created September 20, 2024, karma 33.",
		}},
		Memory: persona.MemoryContext{Items: []persona.MemoryRecord{{
			Kind:      "person_memory",
			SourceRef: "memory/people/zanwei.md",
			Text:      "Johnson8053 has prior workspace evidence linking affine and bridge submissions.",
			Score:     0.91,
		}}},
	}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_handoff",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{Runner: runner})
	result := SlackPersonaShadowResult{
		Success:   true,
		RequestID: req.ID,
		ChannelID: "C_TRIAGE",
		ThreadTS:  "600.000",
		Decision:  persona.DecisionDelegateWorker,
		Reason:    "needs a source-backed identity lookup",
		workerRecords: []persona.WorkerRequest{{
			ID:     "identity-lookup",
			Kind:   "codex",
			Prompt: "Identify the HN user from the supplied thread, fetched link, and memory evidence.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
			Handoff: &persona.WorkerHandoff{
				Boundaries: []string{"custom read-only boundary"},
			},
		}},
	}

	started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 101, result, req, messages)
	if len(started.JobIDs) != 1 || runner.startCount != 1 {
		t.Fatalf("started=%#v runner.startCount=%d, want one worker", started, runner.startCount)
	}
	handoff, ok := runner.startInput.Context["handoff"].(persona.WorkerHandoff)
	if !ok {
		t.Fatalf("handoff = %#v, want persona.WorkerHandoff", runner.startInput.Context["handoff"])
	}
	if handoff.SourceAgent != "oneesama_pi_foreground" || handoff.TargetAgent != "secretary_lookup_worker" {
		t.Fatalf("handoff agents = %#v, want Pi foreground -> secretary lookup worker", handoff)
	}
	if handoff.Reason != result.Reason || !strings.Contains(handoff.UserRequest, "HN 用户") || !strings.Contains(handoff.Task, "Identify the HN user") {
		t.Fatalf("handoff = %#v, want reason/user request/task", handoff)
	}
	for _, want := range []string{
		"custom read-only boundary",
		"Return results to Oneesama",
		"subagent handoff from Oneesama",
		"Only produce Slack-visible text when concrete evidence anchors support it.",
	} {
		if !stringSliceContainsSubstring(handoff.Boundaries, want) {
			t.Fatalf("handoff boundaries = %#v, missing %q", handoff.Boundaries, want)
		}
	}
	if !handoffSourceRefsContain(handoff.SourceRefs, "slack_thread", "C_TRIAGE/600.000") ||
		!handoffSourceRefsContain(handoff.SourceRefs, "external_link_context", "https://news.ycombinator.com/user?id=Johnson8053") ||
		!handoffSourceRefsContain(handoff.SourceRefs, "person_memory", "memory/people/zanwei.md") {
		t.Fatalf("handoff source refs = %#v, want Slack thread, fetched link, and memory refs", handoff.SourceRefs)
	}
}

func TestSlackTriagePiFirstLiveDelegateWorkerCarriesImageFetchContext(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "image contents are required before answering",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "inspect-slack-images",
			Kind:   "codex",
			Prompt: "Read the Slack screenshots and explain what permission is missing. If you cannot inspect the images, return no visible result.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
		Confidence: 0.44,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_image_delegate_after_pi",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "没懂",
		TS:             "300.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "F0B540Q5J5Q",
			Name:      "IMG_0083.jpg",
			Filetype:  "jpg",
			Mimetype:  "image/jpeg",
			Size:      224000,
			OriginalW: 2032,
			OriginalH: 352,
			Permalink: "https://slack.example/files/F0B540Q5J5Q",
		}},
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_OTHER",
		Text:           "look its not letting me i have done everything but it keeps showing as non authorised",
		TS:             "301.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "F0B55RA382V",
			Name:      "IMG_0082.jpg",
			Filetype:  "jpg",
			Mimetype:  "image/jpeg",
			Size:      412000,
			OriginalW: 1206,
			OriginalH: 609,
			Permalink: "https://slack.example/files/F0B55RA382V",
		}},
	}}, "#triage: user is confused by Bridge authorization screenshots")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want one image-inspection delegate worker", runner.startCount)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate decision + one worker job", updated.Metadata)
	}
	prompt := stringFromAny(runner.startInput.Context["slackAssistantPrompt"])
	for _, want := range []string{"slack.fetchImage", "local_path", "do not curl", "F0B540Q5J5Q", "F0B55RA382V", "IMG_0083.jpg", "[image:"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slackAssistantPrompt missing %q:\n%s", want, prompt)
		}
	}
	mention, ok := runner.startInput.Context["slackAppMention"].(*SlackAppMentionContext)
	if !ok || mention == nil {
		t.Fatalf("slackAppMention = %#v, want rich context pointer", runner.startInput.Context["slackAppMention"])
	}
	if len(mention.ImageParts) != 2 || mention.ImageParts[0].ID != "F0B540Q5J5Q" || mention.ImageParts[1].ID != "F0B55RA382V" {
		t.Fatalf("image parts = %#v, want both Slack image file ids", mention.ImageParts)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer after reading images", got)
	}
}

func TestSlackTriagePiFirstLiveSilencesBlockedReadOnlySecretaryLookup(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "Need workspace Memory lookup for what 明天发推 refers to, but surrounding loading/performance context is noisy.",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "lookup-launch-tweet",
			Kind:   "codex",
			Prompt: "Look up workspace Memory for 明天发推 / cue-launch context. Do not investigate loading performance or source code.",
		}},
		Confidence: 0.43,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_HUMAN",
		Text:           "明天发推",
		TS:             "510.000",
	}}, "#cue-launch context: 一直 loading / performance discussion\n--- new messages ---\n明天发推")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want blocked noisy read-only lookup not started", runner.startCount)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no canned secretary-routing refusal", calls)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionStaySilent || intFromAny(updated.Metadata["delegate_worker_blocked_silent"]) != 1 {
		t.Fatalf("metadata = %#v, want blocked read-only secretary lookup downgraded to silence", updated.Metadata)
	}
}

func TestSlackTriagePiFirstLiveDowngradesCannedRefusalReplyToSilence(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: slackPersonaSecretaryRoutingText(),
		Reason:      "The thread has noisy project/loading context and no safe actionable answer.",
		Confidence:  0.61,
		ShadowOnly:  false,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: &fakeRunner{},
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_HUMAN",
		Text:           "明天发推",
		TS:             "520.000",
	}}, "#cue-launch context: 一直 loading / performance discussion\n--- new messages ---\n明天发推")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want canned refusal reply downgraded to silence", calls)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionStaySilent || intFromAny(updated.Metadata["reply_canned_refusal_downgraded_silent"]) != 1 {
		t.Fatalf("metadata = %#v, want canned refusal downgrade", updated.Metadata)
	}
}

func TestPersonaDelegatedWorkerSlackContextForVideoCarriesFileReader(t *testing.T) {
	context := personaDelegatedWorkerSlackContext("C_TRIAGE", "300.000", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_ASK",
		Text:           "",
		TS:             "301.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "FVID",
			Name:      "timeout.mov",
			Filetype:  "mov",
			Mimetype:  "video/quicktime",
			Size:      412000,
			Permalink: "https://slack.example/files/FVID",
		}},
	}})
	prompt := stringFromAny(context["slackAssistantPrompt"])
	for _, want := range []string{"timeout.mov", "File reading rule", "slack.fetchFile", "FVID", "local_path", "Do not answer by saying you cannot view the media", "return no visible result"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slackAssistantPrompt missing %q:\n%s", want, prompt)
		}
	}
	if files, ok := context["slack_files"].([]SlackThreadFile); !ok || len(files) != 1 || files[0].ID != "FVID" {
		t.Fatalf("slack_files = %#v, want video metadata", context["slack_files"])
	}
}

func TestSlackTriagePiFirstLiveBlocksExternalProjectDebugDelegation(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "needs staging investigation",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "investigate-staging",
			Kind:   "codex",
			Prompt: "Investigate staging environment: check recent deployments, database query performance, and API latency for conversation loading.",
		}},
		Confidence: 0.38,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "staging conversations loading is very slow, about 30s",
		TS:             "222.000",
	}}, "#meeting-avatar: staging conversations loading is very slow, about 30s")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want no project-code worker", runner.startCount)
	}
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "222.000" || !strings.Contains(calls[0].Text, "项目 owner") || !strings.Contains(calls[0].Text, "不直接下场查 repo") {
		t.Fatalf("poster calls = %#v, want direct secretary routing reply", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if updated.Metadata["pi_first_decision"] != persona.DecisionReply {
		t.Fatalf("metadata = %#v, want downgraded reply decision", updated.Metadata)
	}
	if intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 0 || intFromAny(updated.Metadata["delegate_worker_scope_blocks"]) != 1 {
		t.Fatalf("metadata = %#v, want no worker jobs and one scope block", updated.Metadata)
	}
	var sawBlock bool
	for _, call := range updated.ToolCalls {
		if call.Tool == "agent_runner" && call.Action == "delegate_worker_blocked_scope" && call.Success {
			sawBlock = true
		}
	}
	if !sawBlock {
		t.Fatalf("tool calls = %#v, want delegate_worker_blocked_scope", updated.ToolCalls)
	}
}

func TestPersonaDelegatedWorkerAllowedBySecretaryPolicyFixtures(t *testing.T) {
	// Ground-truth fixtures from runtime/live-state/agent_runner_jobs.json audit.
	// 3 historical in-scope app_mention worker prompts must NOT be blocked by the
	// heuristic when Pi omits the delegation_scope field; 1 out-of-scope case
	// (the #279 staging perf incident) must be blocked.
	cases := []struct {
		name    string
		request persona.WorkerRequest
		want    bool
	}{
		{
			name: "in_scope/linear_memo",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "记一个 linear 吧，省得忘了",
			},
			want: true,
		},
		{
			name: "in_scope/github_link_discussion_recall",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "https://github.com/msitarzewski/agency-agents 我们讨论过这个嘛",
			},
			want: true,
		},
		{
			name: "in_scope/case_study_video_lookup",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "jc说之前录制了5个Case Study的视频，这个有吗？",
			},
			want: true,
		},
		{
			name: "out_of_scope/staging_perf_investigation_279",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "User reports staging loading conversations is very slow (~30s). Investigate staging environment: check recent deployments, database query performance, API latency for conversation loading.",
			},
			want: false,
		},
		{
			name: "out_of_scope/secretary_lookup_mislabel_does_not_bypass_project_debugging",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Fetch screenshot F0B522G0NUB and analyze why the staging 卡片/notch 没弹出; inspect notification 组件 and 触发条件 in source code.",
				Context: map[string]any{
					"delegation_scope": "secretary_lookup",
				},
			},
			want: false,
		},
		{
			name: "in_scope/explicit_oneesama_code_scope_overrides_markers",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Investigate oneesama meeting-agent recording latency regression in our own code.",
				Context: map[string]any{
					"delegation_scope": "oneesama_code",
				},
			},
			want: true,
		},
		{
			name: "in_scope/oneesama_self_reference_overrides_heuristic",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Investigate slack-agent triage policy regression after the latest deploy.",
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := personaDelegatedWorkerAllowedBySecretaryPolicy(tc.request)
			if got != tc.want {
				t.Fatalf("personaDelegatedWorkerAllowedBySecretaryPolicy = (%v, %q), want allowed=%v", got, reason, tc.want)
			}
		})
	}
}

func TestSlackTriageLivePersonaEmptyReplyRecordsRetryFollowup(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 19, 1, 50, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_empty",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex saw a candidate reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"201.000"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionReply,
		ShadowOnly: false,
	}}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "这条没人接，Pi 如果要回复就必须给 visible_text。",
		TS:             "201.000",
	}}, "#meeting-avatar: 这条没人接，Pi 如果要回复就必须给 visible_text。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no empty persona or Codex fallback post", got)
	}
	if updated.Status != "failed" || !strings.Contains(updated.Error, "empty persona foreground response") {
		t.Fatalf("run status/error = %q/%q, want empty persona failure", updated.Status, updated.Error)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok || boolFromAny(foreground["success"], true) || foreground["error"] == nil {
		t.Fatalf("persona_foreground = %#v, want failed empty persona metadata", updated.Metadata["persona_foreground"])
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one empty-final retry followup", followups)
	}
	got := followups[0]
	if got.Kind != slackTriageEmptyFinalFollowupKind || got.SourceRef != "triage_empty_final_retry:C_TRIAGE:201.000" {
		t.Fatalf("followup = %#v, want persona empty-final retry", got)
	}
	if got.NextCheckAt != now.Add(slackTriageEmptyFinalFollowupDelay).Format(time.RFC3339Nano) {
		t.Fatalf("NextCheckAt = %q, want 15m retry delay", got.NextCheckAt)
	}
	if got.Metadata["failure_source"] != "persona_foreground" || got.Metadata["persona_decision"] != persona.DecisionReply || got.Metadata["persona_runtime"] != persona.ProviderPi {
		t.Fatalf("metadata = %#v, want persona empty-final metadata", got.Metadata)
	}
}

func waitForPersonaShadowRun(t *testing.T, service *Service, runID int64) SlackTriageContext {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run, err := service.triage.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if run != nil {
			if _, ok := run.Metadata["persona_shadow"]; ok {
				return *run
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, _ := service.triage.GetRun(context.Background(), runID)
	if run == nil {
		t.Fatalf("persona shadow result was not recorded; run missing")
	}
	t.Fatalf("persona shadow result was not recorded; metadata=%#v toolCalls=%#v", run.Metadata, run.ToolCalls)
	return SlackTriageContext{}
}

func waitForPersonaForegroundRun(t *testing.T, service *Service, runID int64) SlackTriageContext {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run, err := service.triage.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if run != nil {
			if _, ok := run.Metadata["persona_foreground"]; ok {
				waitForTriageProjection(t, service, runID)
				return *run
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, _ := service.triage.GetRun(context.Background(), runID)
	if run == nil {
		t.Fatalf("persona foreground result was not recorded; run missing")
	}
	t.Fatalf("persona foreground result was not recorded; metadata=%#v toolCalls=%#v", run.Metadata, run.ToolCalls)
	return SlackTriageContext{}
}

func waitForTriageProjection(t *testing.T, service *Service, runID int64) {
	t.Helper()
	if service == nil || strings.TrimSpace(service.workspaceDir) == "" {
		return
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, context := range loadTriageContextsFromProjection(service.workspaceDir) {
			if context.ID == runID {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("triage projection for run %d was not persisted before test cleanup", runID)
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
	if req.Metadata["context_budget_expected"] != true ||
		intFromAny(req.Metadata["context_budget_stable_tokens"]) <= 0 ||
		intFromAny(req.Metadata["context_budget_memory_evidence_tokens"]) <= 0 ||
		intFromAny(req.Metadata["context_budget_total_tokens"]) <= 0 {
		t.Fatalf("metadata = %#v, want harness context budget", req.Metadata)
	}
	var sawCandidateAction bool
	for _, item := range req.Context {
		if item.Kind == "triage_candidate_actions" && strings.Contains(item.Text, "我来补一个轻量意见") {
			sawCandidateAction = true
			break
		}
	}
	if !sawCandidateAction {
		t.Fatalf("context = %#v, want candidate action detail for persona foreground", req.Context)
	}
	if len(req.Evidence.Citations) != 1 || req.Evidence.Citations[0].SourceRef != "memory/questions/aha.md" {
		t.Fatalf("citations = %#v, want related memory citation", req.Evidence.Citations)
	}
}

func TestBuildSlackTriagePersonaRequestIncludesWorkspacePolicyOnlyWhenConfigured(t *testing.T) {
	base := BuildSlackTriagePersonaRequest(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{{Text: "看下这个产品文章"}},
		SlackTriageDecision{Summary: "No workspace policy configured.", ParseOK: true},
		nil,
	)
	if got := personaContextText(base.Context, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy context = %q, want absent by default", got)
	}
	if got := personaContextText(base.Context, "workspace_triage_policy_metadata"); got != "" {
		t.Fatalf("workspace policy metadata context = %q, want absent by default", got)
	}
	if got := personaDynamicContextText(base.DynamicContext, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy dynamic context = %q, want absent by default", got)
	}

	withPolicy := BuildSlackTriagePersonaRequestWithOptions(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{{Text: "看下这个产品文章"}},
		SlackTriageDecision{Summary: "Workspace policy configured.", ParseOK: true},
		nil,
		SlackTriagePersonaRequestOptions{
			WorkspaceTriagePolicy: "Reply to source-backed product-adjacent articles in this workspace.",
		},
	)
	if got := personaContextText(withPolicy.Context, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy stable context = %q, want dynamic envelope only", got)
	}
	if got := personaContextText(withPolicy.Context, "workspace_triage_policy_metadata"); got != "" {
		t.Fatalf("workspace policy metadata stable context = %q, want metadata on dynamic envelope", got)
	}
	env, ok := personaDynamicContextEnvelope(withPolicy.DynamicContext, "workspace_triage_policy")
	if !ok {
		t.Fatalf("dynamic context = %#v, want workspace policy envelope", withPolicy.DynamicContext)
	}
	if !strings.Contains(env.Content, "product-adjacent articles") {
		t.Fatalf("workspace policy dynamic content = %q, want configured policy", env.Content)
	}
	if env.Source != slackWorkspacePolicySourceConfig || !strings.HasPrefix(env.Version, "sha256:") || env.CachePolicy != persona.DynamicContextCachePolicyNotStablePrefix {
		t.Fatalf("workspace policy envelope = %#v, want source/version/cache policy", env)
	}
	if env.Metadata["workspace_policy_source"] != slackWorkspacePolicySourceConfig || env.Metadata["workspace_policy_hash"] == "" || env.Metadata["workspace_policy_length_chars"] == 0 {
		t.Fatalf("workspace policy metadata = %#v, want source/hash/length", env.Metadata)
	}
}

func personaContextText(items []persona.ContextItem, kind string) string {
	for _, item := range items {
		if item.Kind == kind {
			return item.Text
		}
	}
	return ""
}

func personaDynamicContextText(items []persona.DynamicContextEnvelope, kind string) string {
	if env, ok := personaDynamicContextEnvelope(items, kind); ok {
		return env.Content
	}
	return ""
}

func personaDynamicContextEnvelope(items []persona.DynamicContextEnvelope, kind string) (persona.DynamicContextEnvelope, bool) {
	for _, item := range items {
		if item.Kind == kind {
			return item, true
		}
	}
	return persona.DynamicContextEnvelope{}, false
}
