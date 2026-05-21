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
		if got := personaContextText(req.Context, "workspace_triage_policy"); !strings.Contains(got, "product articles") {
			t.Fatalf("workspace policy context = %q, want configured policy", got)
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
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi 读完后给一个轻量回复。",
		Reason:      "persona foreground owns the visible reply",
		Confidence:  0.82,
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
	if got := calls[0].Text; !strings.Contains(got, "Pi 读完后") || strings.Contains(got, "codex visible reply") {
		t.Fatalf("posted text = %q, want Pi reply and no Codex visible reply", got)
	}

	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if updated.Mutations != 1 || updated.Failures != 0 {
		t.Fatalf("updated mutations/failures = %d/%d, want 1/0; run=%#v", updated.Mutations, updated.Failures, updated)
	}
	if len(updated.Actions) != 1 || !strings.Contains(updated.Actions[0].Brief, "Persona reply") {
		t.Fatalf("actions = %#v, want one persona action", updated.Actions)
	}
	var sawForeground bool
	var sawPost bool
	for _, call := range updated.ToolCalls {
		if call.Tool == "persona_runtime" && call.Action == "foreground_triage" && call.Success && call.Result == persona.DecisionReply {
			sawForeground = true
		}
		if call.Tool == "slack_api" && call.Action == "post_thread_reply" && call.Success {
			sawPost = true
		}
	}
	if !sawForeground || !sawPost {
		t.Fatalf("tool calls = %#v, want persona foreground + Slack post", updated.ToolCalls)
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
		Result:   `{"summary":"codex-only reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"200.000"}]}`,
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
	if calls := poster.Calls(); len(calls) != 1 || !strings.Contains(calls[0].Text, "codex visible reply") {
		t.Fatalf("poster calls = %#v, want Codex direct reply", calls)
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
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "我查了下，更像是在预热 Gemini 2.5 的能力更新。",
		Reason:      "persona used the candidate action as evidence, then owned the visible reply",
		Confidence:  0.61,
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
		Text:           "Google 这次到底要发什么模型？",
		TS:             "200.000",
	}}, "#meeting-avatar: Google 这次到底要发什么模型？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 || !strings.Contains(calls[0].Text, "我查了下") || strings.Contains(calls[0].Text, "Google 这轮发布") {
		t.Fatalf("poster calls = %#v, want Pi-owned reply, not raw Codex candidate", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if updated.Mutations != 1 || updated.Failures != 0 {
		t.Fatalf("updated mutations/failures = %d/%d, want 1/0", updated.Mutations, updated.Failures)
	}
	if len(updated.Actions) != 1 || updated.Actions[0].Brief != "Persona reply" {
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
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi-first 直接评价：这篇文章和我们的产品判断很接近。",
		Reason:      "workspace policy says to engage product-adjacent evidence-backed links",
		Confidence:  0.86,
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
	if calls := poster.Calls(); len(calls) != 1 || !strings.Contains(calls[0].Text, "Pi-first 直接评价") {
		t.Fatalf("poster calls = %#v, want Pi-first visible reply", calls)
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
	var sawPolicy, sawDigest, sawCandidate bool
	for _, item := range runtime.requests[0].Context {
		switch item.Kind {
		case "workspace_triage_policy":
			sawPolicy = strings.Contains(item.Text, "product-adjacent")
		case "triage_digest":
			sawDigest = strings.Contains(item.Text, "产品评论文章")
		case "triage_candidate_actions":
			sawCandidate = true
		}
	}
	if !sawPolicy || !sawDigest || sawCandidate {
		t.Fatalf("persona context = %#v, want policy+digest and no Codex candidate actions", runtime.requests[0].Context)
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
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindSlack {
		t.Fatalf("runner context session_kind = %#v, want slack_case", runner.startInput.Context["session_kind"])
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer asynchronously later", got)
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
	for _, want := range []string{"slack.fetchImage", "F0B540Q5J5Q", "F0B55RA382V", "IMG_0083.jpg", "[image:"} {
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
			Triage: appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
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
	if len(calls) != 1 || !strings.Contains(calls[0].Text, "项目 owner") || !strings.Contains(calls[0].Text, "不直接下场查 repo") {
		t.Fatalf("poster calls = %#v, want secretary routing reply", calls)
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
	if got := personaContextText(withPolicy.Context, "workspace_triage_policy"); !strings.Contains(got, "product-adjacent articles") {
		t.Fatalf("workspace policy context = %q, want configured policy", got)
	}
	metadata := personaContextText(withPolicy.Context, "workspace_triage_policy_metadata")
	for _, want := range []string{
		"source=config.slack.triage.workspace_policy",
		"version=sha256:",
		"hash=",
		"length_chars=",
	} {
		if !strings.Contains(metadata, want) {
			t.Fatalf("workspace policy metadata = %q, want %q", metadata, want)
		}
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
