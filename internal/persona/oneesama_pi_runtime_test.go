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
		writeOneesamaPITestResponse(w, `{"runtime":"oneesama-pi","decision":"reply","visible_text":"这条可以结合 workspace Memory 轻量评价。","evidence_anchors":[{"kind":"workspace_memory","source_ref":"memory/team.md:7","quote":"workspace Memory 支持这条判断"}],"confidence":0.82,"reason":"source-backed workspace policy"}`)
	}))
	defer server.Close()

	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Mode:    ModeLive,
		BaseURL: server.URL,
		Model:   "test-model",
	})
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
	assertContainsAll(t, systemPrompt,
		"Oneesama's own Slack foreground Pi agent",
		"Never post visible self-limitations",
		"Do not infer negative product support/status from missing evidence",
		"External URL identity/fact lookup is bounded secretary work",
		"不认识 / 不知道",
		"A visible reply must have concrete evidence",
		"typed evidence_anchors",
		`"evidence_anchors"`,
		"fetched_link|workspace_memory|person_memory",
	)
	assertContainsNone(t, systemPrompt, "[[", "telegram-pi", "Linger")
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

func TestOneesamaPIRuntimeSafetyDowngradesDisallowedReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeOneesamaPITestResponse(w, `{"runtime":"oneesama-pi","decision":"reply","visible_text":"should not post"}`)
	}))
	defer server.Close()

	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Mode:    ModeLive,
		BaseURL: server.URL,
	})
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

func TestOneesamaPIRuntimeSanitizesRemoteErrorAndRejectsOversizedBody(t *testing.T) {
	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			return personaTestResponse(http.StatusTooManyRequests, `{"error":{"code":"rate_limited","message":"token=secret-token Bearer secret-bearer"}}`), nil
		}),
	})
	_, err := runtime.Decide(context.Background(), Request{ID: "req-pi-error"})
	if err == nil {
		t.Fatal("Decide() error = nil, want remote error")
	}
	assertContainsNone(t, err.Error(), "secret-token", "secret-bearer")
	status := runtime.Status(context.Background())
	assertContainsNone(t, status.LastError, "secret-token", "secret-bearer")
	if !strings.Contains(status.LastError, "[redacted]") {
		t.Fatalf("Status().LastError = %q, want redacted error", status.LastError)
	}

	runtime.client = personaHTTPClient(func(req *http.Request) (*http.Response, error) {
		return personaTestResponse(http.StatusOK, strings.Repeat("x", int(maxOneesamaPIResponseBytes)+1)), nil
	})
	_, err = runtime.Decide(context.Background(), Request{ID: "req-pi-large"})
	if err == nil {
		t.Fatal("Decide() oversized body error = nil")
	}
	if !strings.Contains(err.Error(), "persona response body exceeds") {
		t.Fatalf("Decide() oversized body error = %v, want size limit error", err)
	}
}

func TestOneesamaPIRuntimeCustomClientContextDeadline(t *testing.T) {
	runPersonaDeadlineCases(t, "req-pi", func(t *testing.T, tt personaDeadlineCase, parentCtx context.Context) {
		runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
			Timeout: tt.timeout,
			Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
				assertRequestDeadlineWithin(t, req, tt.wantWithin)
				return oneesamaPITestResponse(`{"runtime":"oneesama-pi","decision":"stay_silent"}`), nil
			}),
		})
		if _, err := runtime.Decide(parentCtx, Request{ID: tt.requestID}); err != nil {
			t.Fatalf("Decide() error = %v", err)
		}
	})
}

func TestOneesamaPIRuntimeRejectsOversizedRequestBudget(t *testing.T) {
	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			t.Fatal("unexpected HTTP request for oversized persona context")
			return nil, nil
		}),
	})
	_, err := runtime.Decide(context.Background(), Request{
		ID: "req-pi-budget",
		DynamicContext: []DynamicContextEnvelope{{
			Kind:    "huge_context",
			Content: strings.Repeat("x", maxOneesamaPIRequestChars+1),
		}},
	})
	if err == nil {
		t.Fatal("Decide() error = nil, want budget error")
	}
	if !strings.Contains(err.Error(), "oneesama Pi request context budget exceeds") {
		t.Fatalf("Decide() error = %v, want budget error", err)
	}
}

func TestOneesamaPIRuntimeOmitsInternalMetadataFromModelRequest(t *testing.T) {
	var seen oneesamaPIChatRequest
	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			if err := json.NewDecoder(req.Body).Decode(&seen); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			return oneesamaPITestResponse(`{"runtime":"oneesama-pi","decision":"stay_silent"}`), nil
		}),
	})
	if _, err := runtime.Decide(context.Background(), Request{
		ID:    "req-pi-metadata",
		Event: Event{Kind: "slack_triage", Text: "metadata should stay internal"},
		DynamicContext: []DynamicContextEnvelope{{
			Kind:     "workspace_policy",
			Content:  "reply with evidence",
			Metadata: map[string]any{"internal_debug": "do not send"},
		}},
		Metadata: map[string]any{"audit_only": "do not send"},
	}); err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if len(seen.Messages) != 2 {
		t.Fatalf("seen messages = %#v, want system/user", seen.Messages)
	}
	userPayload := seen.Messages[1].Content
	assertContainsNone(t, userPayload, "audit_only", "internal_debug", "do not send")
	assertContainsAll(t, userPayload, "metadata should stay internal", "reply with evidence")
}

func newOneesamaPIRuntimeForTest(t *testing.T, config OneesamaPIConfig) *OneesamaPIRuntime {
	t.Helper()
	if config.Provider == "" {
		config.Provider = ProviderOneesamaPi
	}
	if config.Mode == "" {
		config.Mode = ModeShadow
	}
	if config.BaseURL == "" {
		config.BaseURL = "https://pi.example"
	}
	if config.APIKey == "" {
		config.APIKey = "test-key"
	}
	if config.Timeout == 0 {
		config.Timeout = time.Second
	}
	runtime, err := NewOneesamaPIRuntime(config)
	if err != nil {
		t.Fatalf("NewOneesamaPIRuntime() error = %v", err)
	}
	return runtime
}

func oneesamaPITestResponse(content string) *http.Response {
	return personaTestResponse(http.StatusOK, oneesamaPITestResponseBody(content))
}

func writeOneesamaPITestResponse(w http.ResponseWriter, content string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(oneesamaPITestResponseBody(content)))
}

func oneesamaPITestResponseBody(content string) string {
	raw, _ := json.Marshal(oneesamaPIChatResponse{Choices: []struct {
		Message oneesamaPIChatMessage `json:"message"`
	}{{Message: oneesamaPIChatMessage{Role: "assistant", Content: content}}}})
	return string(raw)
}

func assertContainsAll(t *testing.T, body string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func assertContainsNone(t *testing.T, body string, forbidden ...string) {
	t.Helper()
	for _, item := range forbidden {
		if strings.Contains(body, item) {
			t.Fatalf("body contains forbidden %q:\n%s", item, body)
		}
	}
}

func TestOneesamaPIRuntimePreservesActionFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeOneesamaPITestResponse(w, `{
				"runtime":"oneesama-pi",
				"decision":"delegate_worker",
				"worker_requests":[{"id":"inspect","kind":"codex","prompt":"inspect linked source before replying"}],
				"memory_writes":[{"kind":"episode","text":"Peng prefers workspace-aware link commentary.","source_ref":"slack:C:123"}],
				"reactions":[{"emoji":"eyes_bridge","reason":"worth watching","confidence":0.7}],
				"citations":[{"kind":"memory","source_ref":"memory.md:7","snippet":"workspace-aware commentary"}],
				"evidence_anchors":[{"kind":"workspace_memory","source_ref":"memory.md:7","quote":"workspace-aware commentary"}],
				"confidence":0.62,
				"reason":"needs source inspection"
			}`)
	}))
	defer server.Close()

	runtime := newOneesamaPIRuntimeForTest(t, OneesamaPIConfig{
		Mode:    ModeLive,
		BaseURL: server.URL,
	})
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
