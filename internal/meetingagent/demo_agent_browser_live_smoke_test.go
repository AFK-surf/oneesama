//go:build demo_live_smoke

package meetingagent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveDemoAgentBrowserBridgeCanChangeSharedContent(t *testing.T) {
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

	sessionID := "demo_live_agent_browser_snake"
	browserSession := demoAgentBrowserSessionName(sessionID)
	_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	t.Cleanup(func() {
		_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	})

	now := time.Date(2026, 5, 21, 19, 0, 0, 0, time.UTC)
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 7001}})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: &DemoAgentBrowserClient{
				Timeout: 30 * time.Second,
				Now:     func() time.Time { return now },
			},
			Safety: DemoSafetyPolicy{
				ApprovedSessionURLs: []string{server.URL + "/"},
				AllowActiveControl:  true,
			},
			Now: func() time.Time { return now },
		},
		Store:        NewDemoSessionStore().WithClock(func() time.Time { return now }),
		Observations: NewDemoObservationBus(),
	}

	start, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		URL:              server.URL + "/",
		Goal:             "show the local Snake fixture",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !start.OK || start.Observation == nil || !strings.Contains(start.Observation.Summary, "Oneesama Snake POC") {
		t.Fatalf("start = %#v, want visible Snake observation", start)
	}
	if start.Presentation == nil || start.Presentation.Source != "screen_share_app" {
		t.Fatalf("presentation = %#v, want app/window share", start.Presentation)
	}

	control, err := bridge.Control(context.Background(), RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Start snake",
	})
	if err != nil {
		t.Fatalf("Control() error = %v", err)
	}
	if score.Load() != 1 {
		t.Fatalf("score = %d, want click to reach fixture backend", score.Load())
	}
	if !control.OK || control.Observation == nil || !strings.Contains(control.Observation.Summary, "score: 1") {
		t.Fatalf("control = %#v, want post-click score observation", control)
	}
	if !strings.Contains(control.ObservationContext, "score: 0") || !strings.Contains(control.ObservationContext, "score: 1") {
		t.Fatalf("observation context = %q, want before/after shared content", control.ObservationContext)
	}
	if len(share.startCalls) != 1 || len(share.appCalls) != 1 || len(share.presentCalls) != 0 {
		t.Fatalf("share calls start=%d app=%d present=%d, want same shared window reused", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
	}
}

func TestLiveDemoAgentBrowserReadOnlyGitHubScenario(t *testing.T) {
	const targetURL = "https://github.com/openai/openai-node"

	sessionID := "demo_live_agent_browser_github"
	browserSession := demoAgentBrowserSessionName(sessionID)
	_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	t.Cleanup(func() {
		_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	})

	now := time.Date(2026, 5, 21, 19, 8, 0, 0, time.UTC)
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 7002}})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: &DemoAgentBrowserClient{
				Timeout: 40 * time.Second,
				Now:     func() time.Time { return now },
			},
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://github.com/openai/openai-node"},
			},
			Now: func() time.Time { return now },
		},
		Store:        NewDemoSessionStore().WithClock(func() time.Time { return now }),
		Observations: NewDemoObservationBus(),
	}

	start, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		URL:              targetURL,
		Goal:             "show a real GitHub repo page",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !start.OK || start.Observation == nil || !strings.Contains(strings.ToLower(start.Observation.Summary), "openai-node") {
		t.Fatalf("start = %#v, want visible openai-node observation", start)
	}

	scroll, err := bridge.Control(context.Background(), RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionScroll,
		Direction:        "down",
		Amount:           900,
	})
	if err != nil {
		t.Fatalf("Control(scroll) error = %v", err)
	}
	if !scroll.OK || scroll.Observation == nil || scroll.Observation.Kind != demoObservationKindScrolled {
		t.Fatalf("scroll = %#v, want scrolled observation", scroll)
	}

	capture, err := bridge.Control(context.Background(), RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionCapture,
	})
	if err != nil {
		t.Fatalf("Control(capture) error = %v", err)
	}
	if !capture.OK || capture.Observation == nil || capture.Observation.FramePath == "" {
		t.Fatalf("capture = %#v, want screenshot artifact", capture)
	}
	if _, err := os.Stat(capture.Observation.FramePath); err != nil {
		t.Fatalf("screenshot artifact %q stat error = %v", capture.Observation.FramePath, err)
	}
	if !strings.Contains(capture.ObservationContext, "openai-node") {
		t.Fatalf("observation context = %q, want real-page context retained", capture.ObservationContext)
	}
	if len(share.startCalls) != 1 || len(share.appCalls) != 1 || len(share.presentCalls) != 0 {
		t.Fatalf("share calls start=%d app=%d present=%d, want same shared window reused", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
	}
}
