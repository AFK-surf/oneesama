package persona

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOneesamaPIRuntimeDecideCallsOpenAICompatibleChat(t *testing.T) {
	var seen oneesamaPIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want bearer test-key", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Fatalf("decode chat request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(oneesamaPIChatResponse{Choices: []struct {
			Message oneesamaPIChatMessage `json:"message"`
		}{{
			Message: oneesamaPIChatMessage{Role: "assistant", Content: `{"runtime":"oneesama-pi","decision":"reply","visible_text":"这条可以结合 workspace Memory 轻量评价。","evidence_anchors":[{"kind":"workspace_memory","source_ref":"memory/team.md:7","quote":"workspace Memory 支持这条判断"}],"confidence":0.82,"reason":"source-backed workspace policy"}`},
		}}})
	}))
	defer server.Close()

	runtime, err := NewOneesamaPIRuntime(OneesamaPIConfig{
		Provider: ProviderOneesamaPi,
		Mode:     ModeLive,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Model:    "test-model",
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("NewOneesamaPIRuntime: %v", err)
	}
	resp, err := runtime.Decide(context.Background(), Request{
		ID:    "req-oneesama",
		Mode:  ModeLive,
		Event: Event{Kind: "slack_triage", Text: "这个产品相邻链接值得评论吗？"},
		Safety: SafetyConstraints{
			AllowVisibleReply:  true,
			AllowWorkerRequest: true,
			AllowReactions:     true,
			MaxVisibleChars:    200,
		},
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if seen.Model != "test-model" || len(seen.Messages) != 2 {
		t.Fatalf("seen = %#v, want model + system/user messages", seen)
	}
	systemPrompt := seen.Messages[0].Content
	if !strings.Contains(systemPrompt, "Oneesama's own Slack foreground Pi agent") {
		t.Fatalf("system prompt did not establish Oneesama foreground boundary:\n%s", seen.Messages[0].Content)
	}
	if !strings.Contains(systemPrompt, "Never post visible self-limitations") {
		t.Fatalf("system prompt missing media/tool self-limitation guard:\n%s", systemPrompt)
	}
	if !strings.Contains(systemPrompt, "Do not infer negative product support/status from missing evidence") {
		t.Fatalf("system prompt missing missing-evidence product-claim guard:\n%s", systemPrompt)
	}
	if !strings.Contains(systemPrompt, "External URL identity/fact lookup is bounded secretary work") || !strings.Contains(systemPrompt, "不认识 / 不知道") {
		t.Fatalf("system prompt missing old-slackd secretary lookup guard:\n%s", systemPrompt)
	}
	if !strings.Contains(systemPrompt, "A visible reply must have concrete evidence") || !strings.Contains(systemPrompt, "typed evidence_anchors") {
		t.Fatalf("system prompt missing typed evidence-anchor reply quality guard:\n%s", systemPrompt)
	}
	if !strings.Contains(systemPrompt, `"evidence_anchors"`) || !strings.Contains(systemPrompt, "fetched_link|workspace_memory|person_memory") {
		t.Fatalf("system prompt missing evidence_anchors output schema:\n%s", systemPrompt)
	}
	for _, forbidden := range []string{"[[", "telegram-pi", "Linger"} {
		if strings.Contains(systemPrompt, forbidden) {
			t.Fatalf("system prompt contains old/private marker %q:\n%s", forbidden, systemPrompt)
		}
	}
	if !strings.Contains(seen.Messages[1].Content, "产品相邻链接") {
		t.Fatalf("user request missing persona payload:\n%s", seen.Messages[1].Content)
	}
	if resp.Runtime != ProviderOneesamaPi || resp.Decision != DecisionReply || !strings.Contains(resp.VisibleText, "workspace Memory") {
		t.Fatalf("response = %#v, want oneesama-pi reply", resp)
	}
	if len(resp.EvidenceAnchors) != 1 || resp.EvidenceAnchors[0].Kind != EvidenceKindWorkspaceMemory {
		t.Fatalf("evidence anchors = %#v, want workspace memory anchor", resp.EvidenceAnchors)
	}
	status := runtime.Status(context.Background())
	if status.Provider != ProviderOneesamaPi || !status.Ready || !status.Healthy || status.Version == "" {
		t.Fatalf("status = %#v, want ready healthy oneesama-pi", status)
	}
}

func TestOneesamaPIRuntimeRetriesMalformedDecisionJSONOnce(t *testing.T) {
	var calls int
	var repairRequest oneesamaPIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var seen oneesamaPIChatRequest
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Fatalf("decode chat request: %v", err)
		}
		if calls == 1 {
			_ = json.NewEncoder(w).Encode(oneesamaPIChatResponse{Choices: []struct {
				Message oneesamaPIChatMessage `json:"message"`
			}{{
				Message: oneesamaPIChatMessage{Role: "assistant", Content: `{"runtime":"oneesama-pi","decision":`},
			}}})
			return
		}
		repairRequest = seen
		_ = json.NewEncoder(w).Encode(oneesamaPIChatResponse{Choices: []struct {
			Message oneesamaPIChatMessage `json:"message"`
		}{{
			Message: oneesamaPIChatMessage{Role: "assistant", Content: `{"runtime":"oneesama-pi","decision":"delegate_worker","worker_requests":[{"kind":"codex","prompt":"inspect the source and return evidence-backed summary"}],"confidence":0.8,"reason":"repaired JSON"}`},
		}}})
	}))
	defer server.Close()

	runtime, err := NewOneesamaPIRuntime(OneesamaPIConfig{
		Provider: ProviderOneesamaPi,
		Mode:     ModeLive,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("NewOneesamaPIRuntime: %v", err)
	}
	resp, err := runtime.Decide(context.Background(), Request{
		ID:    "req-malformed-json",
		Mode:  ModeLive,
		Event: Event{Kind: "slack_triage", Text: "查一下这个链接后给结论"},
		Safety: SafetyConstraints{
			AllowWorkerRequest: true,
		},
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want one repair retry after malformed JSON", calls)
	}
	if len(repairRequest.Messages) != 3 || !strings.Contains(repairRequest.Messages[2].Content, "not valid JSON") {
		t.Fatalf("repair request messages = %#v, want bounded JSON repair prompt", repairRequest.Messages)
	}
	if resp.Decision != DecisionDelegateWorker || len(resp.WorkerRequests) != 1 {
		t.Fatalf("response = %#v, want repaired delegate_worker decision", resp)
	}
}

func TestOneesamaPIRuntimeSafetyDowngradesDisallowedReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(oneesamaPIChatResponse{Choices: []struct {
			Message oneesamaPIChatMessage `json:"message"`
		}{{
			Message: oneesamaPIChatMessage{Role: "assistant", Content: `{"runtime":"oneesama-pi","decision":"reply","visible_text":"should not post"}`},
		}}})
	}))
	defer server.Close()

	runtime, err := NewOneesamaPIRuntime(OneesamaPIConfig{
		Provider: ProviderOneesamaPi,
		Mode:     ModeLive,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("NewOneesamaPIRuntime: %v", err)
	}
	resp, err := runtime.Decide(context.Background(), Request{
		ID:     "req-no-visible",
		Mode:   ModeLive,
		Event:  Event{Kind: "slack_triage", Text: "silent path"},
		Safety: SafetyConstraints{AllowVisibleReply: false},
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if resp.Decision != DecisionStaySilent || resp.VisibleText != "" {
		t.Fatalf("response = %#v, want disallowed reply downgraded to stay_silent", resp)
	}
}

func TestOneesamaPIRuntimePreservesActionFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(oneesamaPIChatResponse{Choices: []struct {
			Message oneesamaPIChatMessage `json:"message"`
		}{{
			Message: oneesamaPIChatMessage{Role: "assistant", Content: `{
				"runtime":"oneesama-pi",
				"decision":"delegate_worker",
				"worker_requests":[{"id":"inspect","kind":"codex","prompt":"inspect linked source before replying"}],
				"memory_writes":[{"kind":"episode","text":"Peng prefers workspace-aware link commentary.","source_ref":"slack:C:123"}],
				"reactions":[{"emoji":"eyes_bridge","reason":"worth watching","confidence":0.7}],
				"citations":[{"kind":"memory","source_ref":"memory.md:7","snippet":"workspace-aware commentary"}],
				"evidence_anchors":[{"kind":"workspace_memory","source_ref":"memory.md:7","quote":"workspace-aware commentary"}],
				"confidence":0.62,
				"reason":"needs source inspection"
			}`},
		}}})
	}))
	defer server.Close()

	runtime, err := NewOneesamaPIRuntime(OneesamaPIConfig{
		Provider: ProviderOneesamaPi,
		Mode:     ModeLive,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("NewOneesamaPIRuntime: %v", err)
	}
	resp, err := runtime.Decide(context.Background(), Request{
		ID:    "req-action-fields",
		Mode:  ModeLive,
		Event: Event{Kind: "slack_triage", Text: "linked source"},
		Safety: SafetyConstraints{
			AllowVisibleReply:  true,
			AllowWorkerRequest: true,
			AllowReactions:     true,
		},
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if resp.Decision != DecisionDelegateWorker || len(resp.WorkerRequests) != 1 || resp.WorkerRequests[0].Kind != "codex" {
		t.Fatalf("worker response = %#v, want delegate_worker with codex request", resp)
	}
	if len(resp.MemoryWrites) != 1 || !strings.Contains(resp.MemoryWrites[0].Text, "workspace-aware") {
		t.Fatalf("memory writes = %#v, want preserved memory write", resp.MemoryWrites)
	}
	if len(resp.Reactions) != 1 || resp.Reactions[0].Emoji != "eyes_bridge" {
		t.Fatalf("reactions = %#v, want preserved custom emoji reaction", resp.Reactions)
	}
	if len(resp.Citations) != 1 || resp.Citations[0].SourceRef != "memory.md:7" {
		t.Fatalf("citations = %#v, want preserved citation", resp.Citations)
	}
	if len(resp.EvidenceAnchors) != 1 || resp.EvidenceAnchors[0].SourceRef != "memory.md:7" {
		t.Fatalf("evidence anchors = %#v, want preserved anchor", resp.EvidenceAnchors)
	}
}

func TestDecodeOneesamaPIResponseAcceptsEvidenceAnchorAliases(t *testing.T) {
	resp, err := decodeOneesamaPIResponse(`{
		"runtime":"oneesama-pi",
		"decision":"reply",
		"visible_text":"source-backed answer",
		"evidenceAnchors":[{"kind":"external_link","source_ref":"https://example.com/source","quote":"source fact"}]
	}`)
	if err != nil {
		t.Fatalf("decodeOneesamaPIResponse: %v", err)
	}
	got := normalizeOneesamaPIResponse(Request{Safety: SafetyConstraints{AllowVisibleReply: true}}, resp, &OneesamaPIRuntime{provider: ProviderOneesamaPi})
	if got.Decision != DecisionReply || len(got.EvidenceAnchors) != 1 || got.EvidenceAnchors[0].Kind != EvidenceKindFetchedLink {
		t.Fatalf("normalized response = %#v, want reply with fetched_link alias anchor", got)
	}
}

func TestNormalizeOneesamaPIResponseRequiresDecisionPayloads(t *testing.T) {
	runtime := &OneesamaPIRuntime{
		provider: ProviderOneesamaPi,
		mode:     ModeLive,
	}
	req := Request{
		Mode: ModeLive,
		Safety: SafetyConstraints{
			AllowVisibleReply:  true,
			AllowWorkerRequest: true,
			AllowReactions:     true,
			MaxVisibleChars:    80,
		},
	}

	tests := []struct {
		name         string
		resp         Response
		wantDecision string
		wantEmoji    string
	}{
		{
			name:         "reply requires visible text",
			resp:         Response{Decision: DecisionReply, VisibleText: "   "},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "reply requires evidence anchors",
			resp:         Response{Decision: DecisionReply, VisibleText: "source-backed answer"},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "legacy citation can satisfy reply evidence",
			resp:         Response{Decision: DecisionReply, VisibleText: "source-backed answer", Citations: []Citation{{Kind: "link", SourceRef: "https://example.com/a", Snippet: "source says it"}}},
			wantDecision: DecisionReply,
		},
		{
			name:         "reply cannot narrate video limitation",
			resp:         Response{Decision: DecisionReply, VisibleText: "能简单描述一下 timeout 的具体情况吗？我看不了视频文件。"},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "reply cannot narrate english media limitation",
			resp:         Response{Decision: DecisionReply, VisibleText: "I can't view the video attachment, can you describe it?"},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "media limitation reply can downgrade to reaction",
			resp:         Response{Decision: DecisionReply, VisibleText: "我看不了视频文件，简单描述一下？", Reactions: []ReactionIntent{{Emoji: ":thinking:"}}},
			wantDecision: DecisionReact,
			wantEmoji:    "thinking",
		},
		{
			name:         "react requires emoji",
			resp:         Response{Decision: DecisionReact, Reactions: []ReactionIntent{{Emoji: "  "}}},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "delegate requires kind and prompt",
			resp:         Response{Decision: DecisionDelegateWorker, WorkerRequests: []WorkerRequest{{Kind: "codex"}}},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "memory_write requires kind and text",
			resp:         Response{Decision: DecisionMemoryWrite, MemoryWrites: []MemoryWrite{{Kind: "fact"}}},
			wantDecision: DecisionStaySilent,
		},
		{
			name:         "valid react trims colon wrapper",
			resp:         Response{Decision: DecisionReact, Reactions: []ReactionIntent{{Emoji: ":eyes_bridge:"}}},
			wantDecision: DecisionReact,
			wantEmoji:    "eyes_bridge",
		},
		{
			name:         "valid delegate is preserved",
			resp:         Response{Decision: DecisionDelegateWorker, WorkerRequests: []WorkerRequest{{Kind: "codex", Prompt: "summarize thread"}}},
			wantDecision: DecisionDelegateWorker,
		},
		{
			name:         "valid memory write is preserved",
			resp:         Response{Decision: DecisionMemoryWrite, MemoryWrites: []MemoryWrite{{Kind: "fact", Text: "Peng prefers source-backed commentary."}}},
			wantDecision: DecisionMemoryWrite,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeOneesamaPIResponse(req, tt.resp, runtime)
			if got.Decision != tt.wantDecision {
				t.Fatalf("Decision = %q, want %q; response=%#v", got.Decision, tt.wantDecision, got)
			}
			if tt.wantEmoji != "" && (len(got.Reactions) != 1 || got.Reactions[0].Emoji != tt.wantEmoji) {
				t.Fatalf("Reactions = %#v, want trimmed %q", got.Reactions, tt.wantEmoji)
			}
		})
	}
}
