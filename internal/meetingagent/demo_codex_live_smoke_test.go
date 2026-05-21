//go:build demo_live_smoke

package meetingagent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestLiveDemoCodexBrowserSmoke(t *testing.T) {
	client := newLiveDemoCodexSmokeClient(t)

	req := DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{
			SessionID:    "demo_live_browser_smoke",
			RuntimeDir:   t.TempDir(),
			ProfileDir:   t.TempDir(),
			FramesDir:    t.TempDir(),
			DownloadsDir: t.TempDir(),
		},
		Kind:        DemoActionOpenURL,
		URL:         "https://example.com/",
		Instruction: "Open the page and report the visible page title or heading.",
		Sequence:    1,
	}
	result, err := client.DoDemoAction(context.Background(), req)
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	t.Logf("result source=%s kind=%s confidence=%.2f frame=%q summary=%q metadata=%v", result.Source, result.Kind, result.Confidence, result.FramePath, result.Summary, result.Metadata)
	assertLiveDemoCodexObservation(t, result)
	if !strings.Contains(strings.ToLower(result.Summary), "example domain") || result.Confidence < defaultDemoFeedbackConfidenceFloor {
		t.Fatalf("result = %#v, want verified Example Domain observation", result)
	}
}

func TestLiveDemoCodexBrowserCompositeSnakeSmoke(t *testing.T) {
	if os.Getenv("ONEESAMA_DEMO_LIVE_COMPOSITE") != "1" {
		t.Skip("set ONEESAMA_DEMO_LIVE_COMPOSITE=1 for the slower exploratory composite browser smoke")
	}
	var score atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, `<!doctype html>
<html>
<head><title>Oneesama Snake POC</title></head>
<body>
  <h1>Oneesama Snake POC</h1>
  <p id="status">ready</p>
  <p id="score">score: 0</p>
  <button id="start" onclick="fetch('/api/play',{method:'POST'}).then(r=>r.json()).then(s=>{document.getElementById('status').textContent=s.status;document.getElementById('score').textContent='score: '+s.score})">Start snake</button>
</body>
</html>`)
		case "/api/play":
			w.Header().Set("Content-Type", "application/json")
			next := score.Add(1)
			_, _ = fmt.Fprintf(w, `{"status":"playing","score":%d}`, next)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := newLiveDemoCodexSmokeClient(t)
	req := DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{
			SessionID:    "demo_live_snake_smoke",
			RuntimeDir:   t.TempDir(),
			ProfileDir:   t.TempDir(),
			FramesDir:    t.TempDir(),
			DownloadsDir: t.TempDir(),
		},
		Kind:        DemoActionOpenURL,
		URL:         server.URL,
		Instruction: "Open this local mini Snake app, start one game, make one simple move if possible, and report the final visible status and score.",
		Sequence:    1,
	}
	result, err := client.DoDemoAction(context.Background(), req)
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	t.Logf("composite result source=%s kind=%s confidence=%.2f frame=%q summary=%q metadata=%v", result.Source, result.Kind, result.Confidence, result.FramePath, result.Summary, result.Metadata)
	assertLiveDemoCodexObservation(t, result)
	lower := strings.ToLower(result.Summary)
	if score.Load() == 0 || !strings.Contains(lower, "score") || !strings.Contains(lower, "1") {
		t.Fatalf("result = %#v score=%d, want interacted local Snake app score", result, score.Load())
	}
}

func newLiveDemoCodexSmokeClient(t *testing.T) *DemoCodexBrowserClient {
	t.Helper()
	cfg, err := appconfig.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if strings.TrimSpace(cfg.AgentRunner.Provider) != "codex" || cfg.AgentRunner.DryRun {
		t.Fatalf("AgentRunner = %#v, want live codex non-dry-run", cfg.AgentRunner)
	}
	cfg.AgentRunner.JobTimeout = 120 * time.Second
	cfg.Persistence = appconfig.PersistenceConfig{Provider: "memory", DataDir: ".", SQLitePath: "state.sqlite3"}
	runner, err := agentrunner.New(agentrunner.Config{
		Persistence: cfg.Persistence,
		AgentRunner: cfg.AgentRunner,
	})
	if err != nil {
		t.Fatalf("agentrunner.New() error = %v", err)
	}
	client := NewDemoCodexBrowserClient(runner)
	client.Timeout = 150 * time.Second
	return client
}

func assertLiveDemoCodexObservation(t *testing.T, result DemoKWWKActionResult) {
	t.Helper()
	if result.Source != demoCodexBrowserObservationSource {
		t.Fatalf("Source = %q, want %q", result.Source, demoCodexBrowserObservationSource)
	}
	if strings.TrimSpace(result.Metadata["job_id"]) == "" {
		t.Fatalf("metadata = %#v, want job_id", result.Metadata)
	}
	if strings.TrimSpace(result.Summary) == "" {
		t.Fatalf("summary empty in result %#v", result)
	}
}
