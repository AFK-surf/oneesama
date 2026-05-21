package meetingagent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

type fakeDemoCodexRunner struct {
	provider   string
	dryRun     bool
	startInput agentrunner.StartInput
	startCount int
	startJob   agentrunner.Job
	getJobs    []agentrunner.Job
	startErr   error
	getErr     error
}

func (r *fakeDemoCodexRunner) Provider() string {
	if strings.TrimSpace(r.provider) == "" {
		return "codex"
	}
	return r.provider
}

func (r *fakeDemoCodexRunner) DryRun() bool {
	return r.dryRun
}

func (r *fakeDemoCodexRunner) StartTask(_ context.Context, input agentrunner.StartInput) (agentrunner.Job, error) {
	r.startInput = input
	r.startCount++
	if r.startErr != nil {
		return agentrunner.Job{}, r.startErr
	}
	job := r.startJob
	if strings.TrimSpace(job.ID) == "" {
		job.ID = "job_demo_codex"
	}
	if strings.TrimSpace(job.Provider) == "" {
		job.Provider = r.Provider()
	}
	if job.Status == "" {
		job.Status = agentrunner.StatusCompleted
	}
	return job, nil
}

func (r *fakeDemoCodexRunner) GetJob(context.Context, string) (agentrunner.Job, bool, error) {
	if r.getErr != nil {
		return agentrunner.Job{}, false, r.getErr
	}
	if len(r.getJobs) == 0 {
		return r.startJob, true, nil
	}
	job := r.getJobs[0]
	r.getJobs = r.getJobs[1:]
	return job, true, nil
}

func (r *fakeDemoCodexRunner) ListJobs(context.Context) ([]agentrunner.Job, error) {
	return nil, nil
}

func (r *fakeDemoCodexRunner) Cancel(context.Context, string) (agentrunner.Job, error) {
	return agentrunner.Job{}, nil
}

func TestDemoCodexBrowserClientStartsWorkerAndParsesStructuredObservation(t *testing.T) {
	now := time.Date(2026, 5, 21, 16, 50, 0, 0, time.UTC)
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_codex_1",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"summary":"Loaded the product dashboard and saw a green status panel.","confidence":0.82,"frame_path":"/tmp/demo-frame.png","kind":"surface_opened","metadata":{"adapter_detail":"browser_use"}}`,
		},
	}
	client := NewDemoCodexBrowserClient(runner)
	client.Now = func() time.Time { return now }
	req := DemoKWWKActionRequest{
		Session:     DemoKWWKSessionRef{SessionID: "demo_codex", RuntimeDir: "/tmp/demo", ProfileDir: "/tmp/demo/profile"},
		Kind:        DemoActionOpenURL,
		URL:         "https://example.test/demo",
		Instruction: "show the dashboard",
		Sequence:    3,
	}

	result, err := client.DoDemoAction(context.Background(), req)
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}

	if runner.startCount != 1 {
		t.Fatalf("startCount = %d, want 1", runner.startCount)
	}
	if !strings.Contains(runner.startInput.Task, "Codex Browser Use adapter") ||
		!strings.Contains(runner.startInput.Task, "browser-use") ||
		runner.startInput.AllowCodeChanges {
		t.Fatalf("start input = %#v, want browser-use read-only task", runner.startInput)
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindMeetingCopilot ||
		runner.startInput.Context["adapter"] != string(DemoKWWKAdapterCodex) {
		t.Fatalf("context = %#v, want meeting copilot codex context", runner.startInput.Context)
	}
	if result.Source != demoCodexBrowserObservationSource || result.Summary != "Loaded the product dashboard and saw a green status panel." {
		t.Fatalf("result = %#v, want codex observation", result)
	}
	if result.Confidence != 0.82 || result.FramePath != "/tmp/demo-frame.png" {
		t.Fatalf("result = %#v, want structured confidence/frame", result)
	}
	if result.Metadata["job_id"] != "job_codex_1" || result.Metadata["adapter_detail"] != "browser_use" {
		t.Fatalf("metadata = %#v, want job/adaptor details", result.Metadata)
	}
	if !result.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %s, want %s", result.CreatedAt, now)
	}
}

func TestDemoCodexBrowserClientParsesMarkdownFencedJSON(t *testing.T) {
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:       "job_codex_fence",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   "```json\n{\"summary\":\"Screenshot shows the signup form.\",\"confidence\":0.7}\n```",
		},
	}
	client := NewDemoCodexBrowserClient(runner)

	result, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session:  DemoKWWKSessionRef{SessionID: "demo_fence"},
		Kind:     DemoActionCapture,
		Sequence: 1,
	})
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	if result.Summary != "Screenshot shows the signup form." || result.Confidence != 0.7 {
		t.Fatalf("result = %#v, want fenced JSON payload parsed", result)
	}
}

func TestDemoCodexBrowserClientPollsRunningJob(t *testing.T) {
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{ID: "job_codex_running", Provider: "codex", Status: agentrunner.StatusRunning},
		getJobs: []agentrunner.Job{{
			ID:       "job_codex_running",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"summary":"Page is ready.","confidence":0.9}`,
		}},
	}
	client := NewDemoCodexBrowserClient(runner)
	client.PollInterval = time.Millisecond
	client.Timeout = time.Second

	result, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_poll"},
		Kind:    DemoActionOpenURL,
		URL:     "https://example.test/demo",
	})
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	if result.Summary != "Page is ready." {
		t.Fatalf("result = %#v, want completed polled result", result)
	}
}

func TestDemoCodexBrowserClientReturnsFailedJobError(t *testing.T) {
	runner := &fakeDemoCodexRunner{
		startJob: agentrunner.Job{
			ID:     "job_codex_failed",
			Status: agentrunner.StatusFailed,
			Error:  "browser tool unavailable",
		},
	}
	client := NewDemoCodexBrowserClient(runner)

	_, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_failed"},
		Kind:    DemoActionCapture,
	})
	if !errors.Is(err, errDemoCodexJobFailed) {
		t.Fatalf("DoDemoAction() error = %v, want errDemoCodexJobFailed", err)
	}
}

func TestDemoCodexBrowserClientRequiresRunner(t *testing.T) {
	client := NewDemoCodexBrowserClient(nil)
	_, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_missing"},
		Kind:    DemoActionCapture,
	})
	if !errors.Is(err, errDemoCodexRunnerRequired) {
		t.Fatalf("DoDemoAction() error = %v, want errDemoCodexRunnerRequired", err)
	}
}
