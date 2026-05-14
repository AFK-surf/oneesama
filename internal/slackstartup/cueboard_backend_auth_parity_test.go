//go:build cueboardparity

package slackstartup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCueboardParityProbeBackendAuthOK(t *testing.T) {
	t.Parallel()

	var gotAuth string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	previousClient := backendProbeHTTPClient
	backendProbeHTTPClient = server.Client()
	defer func() { backendProbeHTTPClient = previousClient }()

	fatal, err := probeBackendAuth(context.Background(), server.URL, "jwt-token")
	if err != nil {
		t.Fatalf("probeBackendAuth: %v", err)
	}
	if fatal {
		t.Fatal("probeBackendAuth marked OK response as fatal")
	}
	if gotPath != "/v1/llm/models" {
		t.Fatalf("path = %q, want /v1/llm/models", gotPath)
	}
	if gotAuth != "Bearer jwt-token" {
		t.Fatalf("Authorization = %q, want Bearer jwt-token", gotAuth)
	}
}

func TestCueboardParityProbeBackendAuthUnauthorizedIsFatal(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"invalid authentication token"}}`))
	}))
	defer server.Close()

	previousClient := backendProbeHTTPClient
	backendProbeHTTPClient = server.Client()
	defer func() { backendProbeHTTPClient = previousClient }()

	fatal, err := probeBackendAuth(context.Background(), server.URL, "jwt-token")
	if err == nil {
		t.Fatal("probeBackendAuth error = nil, want unauthorized failure")
	}
	if !fatal {
		t.Fatal("probeBackendAuth should mark 401 as fatal")
	}
	if !strings.Contains(err.Error(), "status 401") {
		t.Fatalf("error = %q, want status 401", err)
	}
}

func TestCueboardParityProbeBackendAuthServerErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`gateway unavailable`))
	}))
	defer server.Close()

	previousClient := backendProbeHTTPClient
	backendProbeHTTPClient = server.Client()
	defer func() { backendProbeHTTPClient = previousClient }()

	fatal, err := probeBackendAuth(context.Background(), server.URL, "jwt-token")
	if err == nil {
		t.Fatal("probeBackendAuth error = nil, want 502 failure")
	}
	if fatal {
		t.Fatal("probeBackendAuth should treat 502 as non-fatal")
	}
	if !strings.Contains(err.Error(), "status 502") {
		t.Fatalf("error = %q, want status 502", err)
	}
}
