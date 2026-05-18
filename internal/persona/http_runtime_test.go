package persona

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPRuntimeDecideAndStatus(t *testing.T) {
	var seen Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/persona/decide":
			if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			_ = json.NewEncoder(w).Encode(Response{
				Runtime:     ProviderPi,
				Decision:    DecisionReply,
				VisibleText: "我可以先轻量接一下。",
				Citations:   []Citation{{SourceRef: "memory.md:7"}},
			})
		case "/persona/status":
			_ = json.NewEncoder(w).Encode(Status{
				Provider:     ProviderPi,
				Mode:         ModeShadow,
				Ready:        true,
				Healthy:      true,
				ShadowOnly:   true,
				Version:      "pi-shadow-test",
				StateSummary: map[string]any{"episodes": 3},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	runtime, err := NewHTTPRuntime(HTTPConfig{
		Provider:   ProviderPi,
		Mode:       ModeShadow,
		BaseURL:    server.URL,
		Timeout:    time.Second,
		ShadowOnly: true,
	})
	if err != nil {
		t.Fatalf("NewHTTPRuntime() error = %v", err)
	}
	resp, err := runtime.Decide(context.Background(), Request{
		ID:    "req-http",
		Event: Event{Kind: "slack_thread", Text: "read this"},
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if seen.ID != "req-http" || seen.Mode != ModeShadow {
		t.Fatalf("seen request = %#v, want req-http shadow mode", seen)
	}
	if resp.Decision != DecisionReply || !resp.ShadowOnly {
		t.Fatalf("response = %#v, want reply shadow", resp)
	}
	status := runtime.Status(context.Background())
	if status.Provider != ProviderPi || !status.Ready || !status.Healthy || status.Version != "pi-shadow-test" {
		t.Fatalf("status = %#v, want remote pi status", status)
	}
	if status.LastRequestAt == "" {
		t.Fatalf("LastRequestAt is empty")
	}
}

func TestHTTPRuntimeRequiresBaseURL(t *testing.T) {
	_, err := NewHTTPRuntime(HTTPConfig{Provider: ProviderPi})
	if err == nil {
		t.Fatal("NewHTTPRuntime() error = nil, want missing base URL")
	}
}
