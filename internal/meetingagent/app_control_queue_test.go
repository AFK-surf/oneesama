package meetingagent

import (
	"fmt"
	"testing"
	"time"
)

func TestAppControlJobStorePrunesOldTerminalJobs(t *testing.T) {
	t.Parallel()

	service := &Service{appControlJobs: map[string]appControlJob{}}
	now := time.Now().UTC()
	for index := range appControlMaxStoredJobs {
		service.storeAppControlJob(appControlJob{
			ID:         fmt.Sprintf("old_terminal_%03d", index),
			Status:     appControlStatusCompleted,
			CreatedAt:  now.Add(time.Duration(-appControlMaxStoredJobs+index) * time.Minute),
			FinishedAt: now.Add(time.Duration(-appControlMaxStoredJobs+index) * time.Minute),
		})
	}
	service.storeAppControlJob(appControlJob{
		ID:        "running_job",
		Status:    appControlStatusRunning,
		CreatedAt: now.Add(-2 * time.Hour),
		StartedAt: now.Add(-2 * time.Hour),
	})
	service.storeAppControlJob(appControlJob{
		ID:         "latest_terminal",
		Status:     appControlStatusCompleted,
		CreatedAt:  now,
		FinishedAt: now,
	})

	if len(service.appControlJobs) != appControlMaxStoredJobs {
		t.Fatalf("stored jobs = %d, want bounded store size %d", len(service.appControlJobs), appControlMaxStoredJobs)
	}
	for _, id := range []string{"running_job", "latest_terminal"} {
		if _, ok := service.appControlJobs[id]; !ok {
			t.Fatalf("stored jobs missing %q: %#v", id, service.appControlJobs)
		}
	}
	for _, id := range []string{"old_terminal_000", "old_terminal_001"} {
		if _, ok := service.appControlJobs[id]; ok {
			t.Fatalf("stored jobs kept oldest terminal job %q: %#v", id, service.appControlJobs)
		}
	}
}

func TestAppControlJobStorePreservesPendingJobsAbovePruneTarget(t *testing.T) {
	t.Parallel()

	service := &Service{appControlJobs: map[string]appControlJob{}}
	now := time.Now().UTC()
	for index := range appControlMaxStoredJobs {
		service.storeAppControlJob(appControlJob{
			ID:        fmt.Sprintf("queued_job_%03d", index),
			Status:    appControlStatusQueued,
			CreatedAt: now.Add(time.Duration(-appControlMaxStoredJobs+index) * time.Minute),
		})
	}
	service.storeAppControlJob(appControlJob{
		ID:        "running_job",
		Status:    appControlStatusRunning,
		CreatedAt: now.Add(-2 * time.Hour),
		StartedAt: now.Add(-2 * time.Hour),
	})
	service.storeAppControlJob(appControlJob{
		ID:         "terminal_job",
		Status:     appControlStatusCompleted,
		CreatedAt:  now,
		FinishedAt: now,
	})

	if len(service.appControlJobs) != appControlMaxStoredJobs+2 {
		t.Fatalf("stored jobs = %d, want pending/running jobs preserved above prune target", len(service.appControlJobs))
	}
	for _, id := range []string{"queued_job_000", "queued_job_099", "running_job", "terminal_job"} {
		if _, ok := service.appControlJobs[id]; !ok {
			t.Fatalf("stored jobs missing pending/running id %q: %#v", id, service.appControlJobs)
		}
	}
}

func TestAppControlJobStorePrunesEqualTimestampTerminalJobsByID(t *testing.T) {
	t.Parallel()

	service := &Service{appControlJobs: map[string]appControlJob{}}
	now := time.Now().UTC()
	for index := 1; index <= appControlMaxStoredJobs; index += 1 {
		service.storeAppControlJob(appControlJob{
			ID:         fmt.Sprintf("terminal_%03d", index),
			Status:     appControlStatusCompleted,
			CreatedAt:  now,
			FinishedAt: now,
		})
	}
	service.storeAppControlJob(appControlJob{
		ID:         "terminal_new",
		Status:     appControlStatusCompleted,
		CreatedAt:  now,
		FinishedAt: now,
	})

	if len(service.appControlJobs) != appControlMaxStoredJobs {
		t.Fatalf("stored jobs = %d, want bounded store size %d", len(service.appControlJobs), appControlMaxStoredJobs)
	}
	if _, ok := service.appControlJobs["terminal_001"]; ok {
		t.Fatalf("stored jobs kept deterministic oldest ID terminal_001: %#v", service.appControlJobs)
	}
	if _, ok := service.appControlJobs["terminal_new"]; !ok {
		t.Fatalf("stored jobs missing protected latest job: %#v", service.appControlJobs)
	}
}
