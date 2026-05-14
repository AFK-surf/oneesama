package agentrunner

import (
	"context"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestDryRunProvidersCompleteImmediately(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name       string
		provider   string
		wantResult string
		wantDryRun bool
	}{
		{name: "default", provider: "dry-run", wantResult: "Dry-run agent runner accepted the task.", wantDryRun: true},
		{name: "codex", provider: "codex", wantResult: "Dry-run Codex runner accepted the task.", wantDryRun: true},
		{name: "claude", provider: "claude", wantResult: "Dry-run Claude Code runner accepted the task.", wantDryRun: true},
		{name: "ollama", provider: "ollama", wantResult: "Dry-run Ollama runner accepted the task.", wantDryRun: true},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			runner, err := New(Config{
				Persistence: appconfig.PersistenceConfig{Provider: "memory"},
				AgentRunner: appconfig.AgentRunnerConfig{
					Provider: testCase.provider,
					DryRun:   testCase.provider != "dry-run",
				},
			})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}

			job, err := runner.StartTask(context.Background(), StartInput{
				Task:             "Summarize the rewrite",
				Mode:             "code",
				AllowCodeChanges: true,
			})
			if err != nil {
				t.Fatalf("StartTask() error = %v", err)
			}
			if job.Provider != normalizeProvider(testCase.provider) {
				t.Fatalf("job.Provider = %q, want %q", job.Provider, normalizeProvider(testCase.provider))
			}
			if job.Status != StatusCompleted {
				t.Fatalf("job.Status = %q, want %q", job.Status, StatusCompleted)
			}
			if job.Result != testCase.wantResult {
				t.Fatalf("job.Result = %q, want %q", job.Result, testCase.wantResult)
			}
			if runner.DryRun() != testCase.wantDryRun {
				t.Fatalf("runner.DryRun() = %t, want %t", runner.DryRun(), testCase.wantDryRun)
			}
		})
	}
}

func TestListJobsReturnsStoredJobs(t *testing.T) {
	t.Parallel()

	runner, err := New(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "dry-run"},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	first, err := runner.StartTask(context.Background(), StartInput{Task: "first"})
	if err != nil {
		t.Fatalf("first StartTask() error = %v", err)
	}
	second, err := runner.StartTask(context.Background(), StartInput{Task: "second"})
	if err != nil {
		t.Fatalf("second StartTask() error = %v", err)
	}

	jobs, err := runner.ListJobs(context.Background())
	if err != nil {
		t.Fatalf("ListJobs() error = %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("len(jobs) = %d, want 2", len(jobs))
	}
	if jobs[0].ID != first.ID || jobs[1].ID != second.ID {
		t.Fatalf("jobs order = %#v, want [%q, %q]", jobs, first.ID, second.ID)
	}
}
