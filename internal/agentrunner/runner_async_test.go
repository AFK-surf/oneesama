package agentrunner

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type blockingProvider struct {
	provider string
	ready    chan struct{}
}

func (p *blockingProvider) Provider() string {
	return p.provider
}

func (p *blockingProvider) DryRun() bool {
	return false
}

func (p *blockingProvider) Run(ctx context.Context, _ StartInput) (RunResult, error) {
	select {
	case p.ready <- struct{}{}:
	default:
	}

	<-ctx.Done()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return RunResult{
			Status: StatusTimeout,
			Error:  "job timed out",
		}, ctx.Err()
	}
	return RunResult{
		Status: StatusFailed,
		Error:  "job canceled",
	}, ctx.Err()
}

func TestRunnerCancelRequestsStop(t *testing.T) {
	t.Parallel()

	store, err := openStore(appconfig.PersistenceConfig{Provider: "memory"})
	if err != nil {
		t.Fatalf("openStore() error = %v", err)
	}
	provider := &blockingProvider{provider: "codex", ready: make(chan struct{}, 1)}
	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: time.Minute},
		provider:    provider,
		store:       store,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	job, err := runner.StartTask(context.Background(), StartInput{Task: "cancel me"})
	if err != nil {
		t.Fatalf("StartTask() error = %v", err)
	}
	<-provider.ready

	if _, err := runner.Cancel(context.Background(), job.ID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}

	finalJob := waitForJobTerminal(t, runner, job.ID)
	if finalJob.Status != StatusFailed {
		t.Fatalf("final status = %q, want failed", finalJob.Status)
	}
	if finalJob.Error != "job canceled" {
		t.Fatalf("final error = %q, want job canceled", finalJob.Error)
	}
	if finalJob.FailureCode != FailureCanceled {
		t.Fatalf("final failure_code = %q, want %q", finalJob.FailureCode, FailureCanceled)
	}
}

func TestRunnerCallbacksReportProgressAndTerminalUpdate(t *testing.T) {
	t.Parallel()

	store, err := openStore(appconfig.PersistenceConfig{Provider: "memory"})
	if err != nil {
		t.Fatalf("openStore() error = %v", err)
	}
	provider := &blockingProvider{provider: "codex", ready: make(chan struct{}, 1)}
	progressCh := make(chan Job, 1)
	updateCh := make(chan Job, 1)
	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: 20 * time.Millisecond},
		provider:    provider,
		store:       store,
		OnJobProgress: func(_ context.Context, job Job) {
			progressCh <- job
		},
		OnJobUpdate: func(_ context.Context, job Job) {
			updateCh <- job
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	job, err := runner.StartTask(context.Background(), StartInput{Task: "timeout me"})
	if err != nil {
		t.Fatalf("StartTask() error = %v", err)
	}

	select {
	case progress := <-progressCh:
		if progress.ID != job.ID || progress.Status != StatusRunning {
			t.Fatalf("progress = %#v, want running job %s", progress, job.ID)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for progress callback")
	}

	select {
	case update := <-updateCh:
		if update.ID != job.ID || update.Status != StatusTimeout {
			t.Fatalf("update = %#v, want timeout job %s", update, job.ID)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for terminal update callback")
	}
}

func TestRunnerTimesOutLongJobs(t *testing.T) {
	t.Parallel()

	store, err := openStore(appconfig.PersistenceConfig{Provider: "memory"})
	if err != nil {
		t.Fatalf("openStore() error = %v", err)
	}
	provider := &blockingProvider{provider: "claude", ready: make(chan struct{}, 1)}
	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "claude", JobTimeout: 20 * time.Millisecond},
		provider:    provider,
		store:       store,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	job, err := runner.StartTask(context.Background(), StartInput{Task: "timeout me"})
	if err != nil {
		t.Fatalf("StartTask() error = %v", err)
	}
	<-provider.ready

	finalJob := waitForJobTerminal(t, runner, job.ID)
	if finalJob.Status != StatusTimeout {
		t.Fatalf("final status = %q, want timeout", finalJob.Status)
	}
	if finalJob.Error != "job timed out" {
		t.Fatalf("final error = %q, want job timed out", finalJob.Error)
	}
	if finalJob.FailureCode != FailureTimeout {
		t.Fatalf("final failure_code = %q, want %q", finalJob.FailureCode, FailureTimeout)
	}
}

func TestRunnerTimesOutLongJobsWithSQLiteStore(t *testing.T) {
	t.Parallel()

	sqlitePath := filepath.Join(t.TempDir(), "runner.sqlite3")
	store, err := openStore(appconfig.PersistenceConfig{
		Provider:   "sqlite",
		SQLitePath: sqlitePath,
	})
	if err != nil {
		t.Fatalf("openStore() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.collection.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})

	provider := &blockingProvider{provider: "claude", ready: make(chan struct{}, 1)}
	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{
			Provider:   "sqlite",
			SQLitePath: sqlitePath,
		},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "claude", JobTimeout: 20 * time.Millisecond},
		provider:    provider,
		store:       store,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	job, err := runner.StartTask(context.Background(), StartInput{Task: "timeout me in sqlite"})
	if err != nil {
		t.Fatalf("StartTask() error = %v", err)
	}
	<-provider.ready

	finalJob := waitForJobTerminal(t, runner, job.ID)
	if finalJob.Status != StatusTimeout {
		t.Fatalf("final status = %q, want timeout", finalJob.Status)
	}
	if finalJob.Error != "job timed out" {
		t.Fatalf("final error = %q, want job timed out", finalJob.Error)
	}
	if finalJob.FailureCode != FailureTimeout {
		t.Fatalf("final failure_code = %q, want %q", finalJob.FailureCode, FailureTimeout)
	}
	waitForRunnerJobCleanup(t, runner, job.ID)
}

func TestRecoverOrphanedRunningJobsMarksTimeoutAndNotifies(t *testing.T) {
	t.Parallel()

	store, err := openStore(appconfig.PersistenceConfig{Provider: "memory"})
	if err != nil {
		t.Fatalf("openStore() error = %v", err)
	}
	orphan, err := store.Create(context.Background(), "codex", StartInput{Task: "orphaned triage"}, RunResult{Status: StatusRunning})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	updateCh := make(chan Job, 1)
	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "codex", JobTimeout: time.Minute},
		provider:    dryRunProvider{},
		store:       store,
		OnJobUpdate: func(_ context.Context, job Job) {
			updateCh <- job
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	recoverer, ok := runner.(OrphanedRunningRecoverer)
	if !ok {
		t.Fatalf("runner does not implement orphan recovery")
	}

	recovered, err := recoverer.RecoverOrphanedRunning(context.Background(), "agent runner job orphaned after service restart")
	if err != nil {
		t.Fatalf("RecoverOrphanedRunning() error = %v", err)
	}
	if len(recovered) != 1 || recovered[0].ID != orphan.ID {
		t.Fatalf("recovered = %#v, want orphan job", recovered)
	}
	if recovered[0].Status != StatusTimeout || recovered[0].Error != "agent runner job orphaned after service restart" {
		t.Fatalf("recovered job = %#v, want timeout with restart reason", recovered[0])
	}
	if recovered[0].FailureCode != FailureTimeout {
		t.Fatalf("recovered failure_code = %q, want %q", recovered[0].FailureCode, FailureTimeout)
	}

	select {
	case update := <-updateCh:
		if update.ID != orphan.ID || update.Status != StatusTimeout {
			t.Fatalf("update = %#v, want recovered timeout job", update)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for recovery update callback")
	}
}

func waitForJobTerminal(t *testing.T, runner Runner, jobID string) Job {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, ok, err := runner.GetJob(context.Background(), jobID)
		if err != nil {
			t.Fatalf("GetJob() error = %v", err)
		}
		if ok && job.Status != StatusRunning && job.Status != StatusQueued {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s did not reach terminal state", jobID)
	return Job{}
}

func waitForRunnerJobCleanup(t *testing.T, runner Runner, jobID string) {
	t.Helper()

	manager, ok := runner.(*Manager)
	if !ok {
		return
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		manager.cancelMu.Lock()
		_, active := manager.cancelers[jobID]
		manager.cancelMu.Unlock()
		if !active {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s did not finish runner cleanup", jobID)
}
