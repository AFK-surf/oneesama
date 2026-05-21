package meetingagent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type fakeDemoWorkspaceLauncher struct {
	specs     []DemoWorkspaceLaunchSpec
	process   *fakeDemoWorkspaceProcess
	launchErr error
}

func (f *fakeDemoWorkspaceLauncher) LaunchDemoWorkspace(ctx context.Context, spec DemoWorkspaceLaunchSpec) (DemoWorkspaceProcess, error) {
	f.specs = append(f.specs, spec)
	if f.launchErr != nil {
		return nil, f.launchErr
	}
	if f.process != nil {
		return f.process, nil
	}
	return &fakeDemoWorkspaceProcess{pid: 4242}, nil
}

type fakeDemoWorkspaceProcess struct {
	pid     int
	stopped bool
	stopErr error
}

func (f *fakeDemoWorkspaceProcess) PID() int {
	return f.pid
}

func (f *fakeDemoWorkspaceProcess) Stop(ctx context.Context) error {
	f.stopped = true
	return f.stopErr
}

func TestDemoWorkspaceLifecycleStartCreatesIsolatedSessionDirs(t *testing.T) {
	root := t.TempDir()
	launcher := &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 1234}}
	lifecycle := NewDemoWorkspaceLifecycle(root, launcher)
	now := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)

	session, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{
		SessionID: "demo_test",
		URL:       "https://example.test/dashboard",
		Now:       now,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	if session.ID != "demo_test" {
		t.Fatalf("session.ID = %q, want demo_test", session.ID)
	}
	if session.Status != DemoWorkspaceStatusRunning {
		t.Fatalf("session.Status = %q, want running", session.Status)
	}
	if session.ProcessID != 1234 {
		t.Fatalf("session.ProcessID = %d, want 1234", session.ProcessID)
	}
	if !session.StartedAt.Equal(now) {
		t.Fatalf("session.StartedAt = %s, want %s", session.StartedAt, now)
	}
	for _, path := range []string{session.RuntimeDir, session.ProfileDir, session.FramesDir, session.DownloadsDir} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("expected directory %s to exist, stat=%v err=%v", path, info, err)
		}
	}
	if len(launcher.specs) != 1 {
		t.Fatalf("launcher specs = %d, want 1", len(launcher.specs))
	}
	spec := launcher.specs[0]
	if spec.ProfileDir != filepath.Join(root, "demo_test", demoWorkspaceProfileDirName) {
		t.Fatalf("spec.ProfileDir = %q", spec.ProfileDir)
	}
	if spec.FramesDir != session.FramesDir || spec.DownloadsDir != session.DownloadsDir {
		t.Fatalf("spec dirs = %#v, want frames=%q downloads=%q", spec, session.FramesDir, session.DownloadsDir)
	}
}

func TestDemoWorkspaceLifecycleRejectsSecondActiveAndStopCleansRuntime(t *testing.T) {
	root := t.TempDir()
	process := &fakeDemoWorkspaceProcess{pid: 2222}
	lifecycle := NewDemoWorkspaceLifecycle(root, &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time {
		return time.Date(2026, 5, 21, 12, 30, 0, 0, time.UTC)
	}

	first, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{SessionID: "demo_first"})
	if err != nil {
		t.Fatalf("Start(first) error = %v", err)
	}
	if _, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{SessionID: "demo_second"}); !errors.Is(err, errDemoWorkspaceActive) {
		t.Fatalf("Start(second) error = %v, want errDemoWorkspaceActive", err)
	}

	stopped, err := lifecycle.Stop(context.Background(), first.ID)
	if err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if stopped.Status != DemoWorkspaceStatusStopped {
		t.Fatalf("stopped.Status = %q, want stopped", stopped.Status)
	}
	if !process.stopped {
		t.Fatalf("process was not stopped")
	}
	if _, err := os.Stat(first.RuntimeDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("runtime dir still exists or unexpected stat error: %v", err)
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("ActiveSession() ok = true after stop")
	}

	if _, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{SessionID: "demo_second"}); err != nil {
		t.Fatalf("Start(after stop) error = %v", err)
	}
}

func TestDemoWorkspaceLifecycleLaunchFailureCleansRuntimeAndRecordsHistory(t *testing.T) {
	root := t.TempDir()
	launchErr := errors.New("boom")
	lifecycle := NewDemoWorkspaceLifecycle(root, &fakeDemoWorkspaceLauncher{launchErr: launchErr})

	session, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{SessionID: "demo_fail"})
	if !errors.Is(err, launchErr) {
		t.Fatalf("Start() error = %v, want launchErr", err)
	}
	if session.Status != DemoWorkspaceStatusFailed {
		t.Fatalf("session.Status = %q, want failed", session.Status)
	}
	if _, err := os.Stat(filepath.Join(root, "demo_fail")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("runtime dir still exists or unexpected stat error: %v", err)
	}
	recorded, ok := lifecycle.Session("demo_fail")
	if !ok {
		t.Fatalf("failed session not recorded")
	}
	if recorded.Failure != launchErr.Error() {
		t.Fatalf("recorded.Failure = %q, want %q", recorded.Failure, launchErr.Error())
	}
}

func TestDemoWorkspaceLifecycleCleanupStaleSkipsActiveSession(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 5, 21, 13, 0, 0, 0, time.UTC)
	for _, name := range []string{"old_session", "new_session"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	oldTime := now.Add(-3 * time.Hour)
	newTime := now.Add(-10 * time.Minute)
	if err := os.Chtimes(filepath.Join(root, "old_session"), oldTime, oldTime); err != nil {
		t.Fatalf("chtimes old: %v", err)
	}
	if err := os.Chtimes(filepath.Join(root, "new_session"), newTime, newTime); err != nil {
		t.Fatalf("chtimes new: %v", err)
	}

	lifecycle := NewDemoWorkspaceLifecycle(root, &fakeDemoWorkspaceLauncher{})
	if _, err := lifecycle.Start(context.Background(), DemoWorkspaceStartRequest{SessionID: "active_session", Now: now}); err != nil {
		t.Fatalf("Start(active) error = %v", err)
	}
	activePath := filepath.Join(root, "active_session")
	activeTime := now.Add(-4 * time.Hour)
	if err := os.Chtimes(activePath, activeTime, activeTime); err != nil {
		t.Fatalf("chtimes active: %v", err)
	}

	removed, err := lifecycle.CleanupStale(now, time.Hour)
	if err != nil {
		t.Fatalf("CleanupStale() error = %v", err)
	}
	if !reflect.DeepEqual(removed, []string{"old_session"}) {
		t.Fatalf("removed = %#v, want old_session only", removed)
	}
	for _, name := range []string{"new_session", "active_session"} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Fatalf("%s should remain: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "old_session")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old_session still exists or unexpected stat error: %v", err)
	}
}

func TestNormalizeDemoWorkspaceSessionIDRejectsPathTraversal(t *testing.T) {
	for _, input := range []string{"../bad", "bad/path", "bad path", "bad.path"} {
		if _, err := normalizeDemoWorkspaceSessionID(input); err == nil {
			t.Fatalf("normalizeDemoWorkspaceSessionID(%q) succeeded, want error", input)
		}
	}
	generated, err := normalizeDemoWorkspaceSessionID("")
	if err != nil {
		t.Fatalf("normalize empty error = %v", err)
	}
	if !safeDemoWorkspaceSessionID.MatchString(generated) {
		t.Fatalf("generated session id %q is not safe", generated)
	}
}
