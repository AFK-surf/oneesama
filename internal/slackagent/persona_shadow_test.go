package slackagent

import (
	"context"
	"errors"
	"fmt"
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
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			PilotUserID:  "U_PENG",
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: slackTriageForegroundChainCodexThenPi},
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
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{ForegroundChain: slackTriageForegroundChainCodexThenPi}},
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
		Slack: appconfig.SlackConfig{
			BotUserID:   "U_ONEE",
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: slackTriageForegroundChainCodexThenPi},
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
