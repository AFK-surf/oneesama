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
			Message: oneesamaPIChatMessage{Role: "assistant", Content: `{"runtime":"oneesama-pi","decision":"reply","visible_text":"这条可以结合 workspace Memory 轻量评价。","confidence":0.82,"reason":"source-backed workspace policy"}`},
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
	if !strings.Contains(seen.Messages[0].Content, "not Linger") || strings.Contains(seen.Messages[0].Content, "[[MSG_BREAK]] as allowed") {
		t.Fatalf("system prompt did not establish Oneesama/Linger boundary:\n%s", seen.Messages[0].Content)
	}
	if !strings.Contains(seen.Messages[1].Content, "产品相邻链接") {
		t.Fatalf("user request missing persona payload:\n%s", seen.Messages[1].Content)
	}
	if resp.Runtime != ProviderOneesamaPi || resp.Decision != DecisionReply || !strings.Contains(resp.VisibleText, "workspace Memory") {
		t.Fatalf("response = %#v, want oneesama-pi reply", resp)
	}
	status := runtime.Status(context.Background())
	if status.Provider != ProviderOneesamaPi || !status.Ready || !status.Healthy || status.Version == "" {
		t.Fatalf("status = %#v, want ready healthy oneesama-pi", status)
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
