package persona

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestReadPersonaBodyRejectsOversizedBody(t *testing.T) {
	_, err := readPersonaBody(strings.NewReader(strings.Repeat("x", int(maxHTTPRuntimeResponseBytes)+1)), maxHTTPRuntimeResponseBytes)
	if err == nil {
		t.Fatal("readPersonaBody() error = nil, want oversized body error")
	}
	if !strings.Contains(err.Error(), "persona response body exceeds") {
		t.Fatalf("readPersonaBody() error = %v, want size limit error", err)
	}
}

func TestHTTPRuntimeSanitizesRemoteErrorAndStoresSanitizedLastError(t *testing.T) {
	runtime := newHTTPRuntimeForTest(t, HTTPConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			return personaTestResponse(http.StatusBadGateway, `{"error":{"code":"upstream_failed","message":"Bearer secret-token xoxb-secret-token https://hooks.slack.com/services/T/B/C"}}`), nil
		}),
	})
	_, err := runtime.Decide(context.Background(), Request{ID: "req-error"})
	if err == nil {
		t.Fatal("Decide() error = nil, want remote error")
	}
	assertContainsNone(t, err.Error(), "secret-token", "xoxb-secret-token", "hooks.slack.com/services")
	runtime.mu.Lock()
	lastError := runtime.lastError
	runtime.mu.Unlock()
	if lastError != err.Error() {
		t.Fatalf("lastError = %q, want sanitized decide error %q", lastError, err.Error())
	}
}

func TestHTTPRuntimeStatusSanitizesRemoteErrors(t *testing.T) {
	runtime := newHTTPRuntimeForTest(t, HTTPConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/persona/status":
				return personaTestResponse(http.StatusBadGateway, `{"error":{"message":"Bearer status-secret upstream down"}}`), nil
			default:
				return personaTestResponse(http.StatusNotFound, `{}`), nil
			}
		}),
	})
	status := runtime.Status(context.Background())
	if !strings.Contains(status.LastError, "persona runtime returned 502") || !strings.Contains(status.LastError, "[redacted]") {
		t.Fatalf("LastError = %q, want sanitized remote status error", status.LastError)
	}
	if strings.Contains(status.LastError, "status-secret") {
		t.Fatalf("LastError leaked secret: %q", status.LastError)
	}
}

func TestHTTPRuntimeStatusSanitizesRemoteLastError(t *testing.T) {
	runtime := newHTTPRuntimeForTest(t, HTTPConfig{
		Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
			return personaTestResponse(http.StatusOK, `{"provider":"http","mode":"shadow","healthy":false,"last_error":"token=status-secret xoxb-status-secret"}`), nil
		}),
	})
	status := runtime.Status(context.Background())
	if !strings.Contains(status.LastError, "[redacted]") {
		t.Fatalf("LastError = %q, want redacted remote last error", status.LastError)
	}
	assertContainsNone(t, status.LastError, "status-secret", "xoxb-status-secret")
}

func TestHTTPRuntimeCustomClientContextDeadline(t *testing.T) {
	runPersonaDeadlineCases(t, "req-http", func(t *testing.T, tt personaDeadlineCase, parentCtx context.Context) {
		runtime := newHTTPRuntimeForTest(t, HTTPConfig{
			Timeout: tt.timeout,
			Client: personaHTTPClient(func(req *http.Request) (*http.Response, error) {
				assertRequestDeadlineWithin(t, req, tt.wantWithin)
				return personaTestResponse(http.StatusOK, `{"runtime":"http","decision":"stay_silent"}`), nil
			}),
		})
		if _, err := runtime.Decide(parentCtx, Request{ID: tt.requestID}); err != nil {
			t.Fatalf("Decide() error = %v", err)
		}
	})
}

type personaDeadlineCase struct {
	name       string
	parent     time.Duration
	timeout    time.Duration
	wantWithin time.Duration
	requestID  string
}

func runPersonaDeadlineCases(t *testing.T, requestPrefix string, run func(*testing.T, personaDeadlineCase, context.Context)) {
	t.Helper()
	for _, tt := range []personaDeadlineCase{
		{
			name:       "runtime timeout wins",
			parent:     10 * time.Minute,
			timeout:    50 * time.Millisecond,
			wantWithin: time.Second,
			requestID:  requestPrefix + "-deadline",
		},
		{
			name:       "parent deadline wins",
			parent:     20 * time.Millisecond,
			timeout:    time.Second,
			wantWithin: 200 * time.Millisecond,
			requestID:  requestPrefix + "-parent-deadline",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			parentCtx, cancel := context.WithTimeout(context.Background(), tt.parent)
			defer cancel()
			run(t, tt, parentCtx)
		})
	}
}

type personaRoundTripFunc func(*http.Request) (*http.Response, error)

func (f personaRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func newHTTPRuntimeForTest(t *testing.T, config HTTPConfig) *HTTPRuntime {
	t.Helper()
	if config.Provider == "" {
		config.Provider = ProviderHTTP
	}
	if config.Mode == "" {
		config.Mode = ModeShadow
	}
	if config.BaseURL == "" {
		config.BaseURL = "https://persona.example"
	}
	if config.Timeout == 0 {
		config.Timeout = time.Second
	}
	runtime, err := NewHTTPRuntime(config)
	if err != nil {
		t.Fatalf("NewHTTPRuntime() error = %v", err)
	}
	return runtime
}

func personaHTTPClient(fn personaRoundTripFunc) *http.Client {
	return &http.Client{Transport: fn}
}

func personaTestResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func assertRequestDeadlineWithin(t *testing.T, req *http.Request, maxRemaining time.Duration) {
	t.Helper()
	deadline, ok := req.Context().Deadline()
	if !ok {
		t.Fatal("request context has no deadline")
	}
	if time.Until(deadline) > maxRemaining {
		t.Fatalf("request deadline = %v, want within %s", deadline, maxRemaining)
	}
}
