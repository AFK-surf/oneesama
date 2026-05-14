package agentrunner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestPreflightSkipsDryRun(t *testing.T) {
	err := Preflight(context.Background(), appconfig.AgentRunnerConfig{
		Provider: "codex", DryRun: true, Codex: appconfig.CodexRunnerConfig{Bin: ""},
	})
	if err != nil {
		t.Fatalf("expected dry-run preflight to pass: %v", err)
	}
}

func TestPreflightCommandProviderRequiresBinary(t *testing.T) {
	err := Preflight(context.Background(), appconfig.AgentRunnerConfig{
		Provider: "codex", Codex: appconfig.CodexRunnerConfig{Bin: "definitely-not-oneesama-codex"},
		JobTimeout: time.Minute,
	})
	if err == nil || !strings.Contains(err.Error(), "codex binary") {
		t.Fatalf("expected missing codex binary error, got %v", err)
	}
}

func TestPreflightCommandProviderFindsBinary(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := Preflight(context.Background(), appconfig.AgentRunnerConfig{
		Provider: "codex", Codex: appconfig.CodexRunnerConfig{Bin: bin},
		JobTimeout: time.Minute,
	})
	if err != nil {
		t.Fatalf("expected codex binary preflight to pass: %v", err)
	}
}

func TestPreflightOllamaProbesTags(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Fatalf("expected /api/tags, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"models":[]}`))
	}))
	defer server.Close()

	err := Preflight(context.Background(), appconfig.AgentRunnerConfig{
		Provider:   "ollama",
		Ollama:     appconfig.OllamaRunnerConfig{BaseURL: server.URL, Model: "llama3.2"},
		JobTimeout: time.Minute,
	})
	if err != nil {
		t.Fatalf("expected ollama preflight to pass: %v", err)
	}
}
