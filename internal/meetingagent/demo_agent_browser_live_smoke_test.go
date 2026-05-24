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
	if start.Presentation == nil || start.Presentation.Source != "screen_share_present" {
		t.Fatalf("presentation = %#v, want synthetic share", start.Presentation)
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
	if len(share.startCalls) != 1 || len(share.appCalls) != 0 || len(share.presentCalls) != 1 {
		t.Fatalf("share calls start=%d app=%d present=%d, want same synthetic shared surface reused", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
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
	if len(share.startCalls) != 1 || len(share.appCalls) != 0 || len(share.presentCalls) != 1 {
		t.Fatalf("share calls start=%d app=%d present=%d, want same synthetic shared surface reused", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
	}
}

func TestLiveDemoAgentBrowserTaskToSnakeWorkflowScenario(t *testing.T) {
	var implemented atomic.Bool
	var issueClosed atomic.Bool
	var score atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/linear":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, `<!doctype html>
<html>
<head><title>Linear Tasks</title></head>
<body>
  <h1>Linear Tasks</h1>
  <section aria-label="task list">
    <h2>Todo</h2>
    <a href="/linear/ENG-42">ENG-42 Build Snake game</a>
    <p>Create a playable browser Snake demo and show it in the meeting.</p>
  </section>
</body>
</html>`)
		case "/linear/ENG-42":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			status := "Todo"
			closeLink := `<a href="/api/close">Close issue</a>`
			if issueClosed.Load() {
				status = "Closed"
				closeLink = `<span id="closed">Issue closed</span>`
			}
			_, _ = fmt.Fprintf(w, `<!doctype html>
<html>
<head><title>ENG-42 Build Snake game</title></head>
<body>
  <h1>ENG-42 Build Snake game</h1>
  <p id="status">Issue status: %s</p>
  <p>Acceptance: implement a playable Snake page, open it, prove score changes, then close this issue.</p>
  <a href="/codex">Open Codex worker</a>
  %s
</body>
</html>`, status, closeLink)
		case "/codex":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			progress := "Waiting for worker"
			artifact := ""
			if implemented.Load() {
				progress = "Codex implemented Snake"
				artifact = `<a href="/snake">Open Snake demo</a>`
			}
			_, _ = fmt.Fprintf(w, `<!doctype html>
<html>
<head><title>Codex Worker</title></head>
<body>
  <h1>Codex Worker</h1>
  <p id="progress">%s</p>
  <a href="/api/implement">Implement Snake</a>
  %s
</body>
</html>`, progress, artifact)
		case "/api/implement":
			implemented.Store(true)
			http.Redirect(w, r, "/codex", http.StatusSeeOther)
		case "/snake":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if !implemented.Load() {
				_, _ = fmt.Fprint(w, `<!doctype html>
<html>
<head><title>Snake not ready</title></head>
<body><h1>Snake not ready</h1><p>Codex has not implemented the game yet.</p></body>
</html>`)
				return
			}
			_, _ = fmt.Fprintf(w, `<!doctype html>
<html>
<head><title>Snake Demo</title></head>
<body>
  <h1>Snake Demo</h1>
  <p id="status">ready to play</p>
  <p id="score">score: %d</p>
  <a href="/api/play">Start snake</a>
</body>
</html>`, score.Load())
		case "/api/play":
			if implemented.Load() {
				score.Add(1)
			}
			http.Redirect(w, r, "/snake", http.StatusSeeOther)
		case "/api/close":
			issueClosed.Store(true)
			http.Redirect(w, r, "/linear/ENG-42", http.StatusSeeOther)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	sessionID := "demo_live_agent_browser_task_to_snake"
	browserSession := demoAgentBrowserSessionName(sessionID)
	_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	t.Cleanup(func() {
		_ = exec.Command("agent-browser", "--session", browserSession, "close").Run()
	})

	now := time.Date(2026, 5, 21, 19, 20, 0, 0, time.UTC)
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 7003}})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: &DemoAgentBrowserClient{
				Timeout: 35 * time.Second,
				Now:     func() time.Time { return now },
			},
			Safety: DemoSafetyPolicy{
				ApprovedSessionURLs: []string{
					server.URL + "/linear",
					server.URL + "/linear/ENG-42",
					server.URL + "/codex",
					server.URL + "/snake",
				},
				AllowActiveControl: true,
			},
			Now: func() time.Time { return now },
		},
		Store:        NewDemoSessionStore().WithClock(func() time.Time { return now }),
		Observations: NewDemoObservationBus(),
	}

	start, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		URL:              server.URL + "/linear",
		Goal:             "find the Snake task, run the worker, demo the game, and close the issue",
		Title:            "Oneesama demo surface workflow",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	requireDemoObservationContains(t, "task list start", start, "ENG-42 Build Snake game")

	openIssue := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "ENG-42 Build Snake game",
	})
	requireDemoObservationContains(t, "issue detail", openIssue, "Open Codex worker")

	openWorker := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Open Codex worker",
	})
	requireDemoObservationContains(t, "codex worker", openWorker, "Codex Worker")

	implementedResult := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Implement Snake",
	})
	if !implemented.Load() {
		t.Fatalf("implemented = false, want worker action to build Snake")
	}
	requireDemoObservationContains(t, "worker implemented", implementedResult, "Codex implemented Snake")

	openSnake := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Open Snake demo",
	})
	requireDemoObservationContains(t, "snake page", openSnake, "Snake Demo")

	playSnake := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Start snake",
	})
	if score.Load() != 1 {
		t.Fatalf("score = %d, want playable Snake demo to advance", score.Load())
	}
	requireDemoObservationContains(t, "snake played", playSnake, "score: 1")

	returnToIssue := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionOpenURL,
		URL:              server.URL + "/linear/ENG-42",
	})
	requireDemoObservationContains(t, "issue before close", returnToIssue, "Issue status: Todo")

	closeIssue := requireDemoControl(t, bridge, sessionID, RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Action:           DemoActionClick,
		Text:             "Close issue",
	})
	if !issueClosed.Load() {
		t.Fatalf("issueClosed = false, want final issue close action")
	}
	requireDemoObservationContains(t, "issue closed", closeIssue, "Issue status: Closed")
	if !strings.Contains(closeIssue.ObservationContext, "ENG-42 Build Snake game") ||
		!strings.Contains(closeIssue.ObservationContext, "Codex implemented Snake") ||
		!strings.Contains(closeIssue.ObservationContext, "score: 1") ||
		!strings.Contains(closeIssue.ObservationContext, "Issue status: Closed") {
		t.Fatalf("observation context = %q, want full task-to-demo workflow trail", closeIssue.ObservationContext)
	}
	if entries, _ := bridge.Store.Entries(sessionID); len(entries) < 8 {
		t.Fatalf("audit entries = %d, want trigger plus workflow actions", len(entries))
	}

	stop, err := bridge.Cancel(context.Background(), RealtimeDemoSurfaceCancelRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    sessionID,
		Reason:           "workflow_complete",
	})
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if !stop.OK || stop.Status != realtimeDemoBridgeStatusStopped {
		t.Fatalf("Cancel() = %#v, want stopped", stop)
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after workflow cancel")
	}
	if len(share.startCalls) != 1 || len(share.appCalls) != 0 || len(share.presentCalls) != 1 || len(share.stopCalls) != 1 {
		t.Fatalf("share calls start=%d app=%d present=%d stop=%d, want one synthetic shared surface reused then stopped", len(share.startCalls), len(share.appCalls), len(share.presentCalls), len(share.stopCalls))
	}
}

func requireDemoControl(t *testing.T, bridge *RealtimeDemoBridge, sessionID string, req RealtimeDemoSurfaceControlRequest) RealtimeDemoBridgeResult {
	t.Helper()
	if req.DemoSessionID == "" {
		req.DemoSessionID = sessionID
	}
	result, err := bridge.Control(context.Background(), req)
	if err != nil {
		t.Fatalf("Control(%s %q) error = %v", req.actionKind(), req.Text, err)
	}
	if !result.OK || result.Observation == nil {
		t.Fatalf("Control(%s %q) = %#v, want observation", req.actionKind(), req.Text, result)
	}
	return result
}

func requireDemoObservationContains(t *testing.T, label string, result RealtimeDemoBridgeResult, want string) {
	t.Helper()
	if result.Observation == nil {
		t.Fatalf("%s observation = nil, want %q", label, want)
	}
	if !strings.Contains(result.Observation.Summary, want) && !strings.Contains(result.ObservationContext, want) {
		t.Fatalf("%s summary/context = %q / %q, want %q", label, result.Observation.Summary, result.ObservationContext, want)
	}
}
