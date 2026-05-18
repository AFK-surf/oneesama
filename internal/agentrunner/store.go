package agentrunner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const jobsCollection = "agent_runner_jobs"

type Store struct {
	mu         sync.Mutex
	collection *persistence.TypedCollection[Job]
}

func openStore(cfg appconfig.PersistenceConfig) (*Store, error) {
	options := persistence.Options{
		Provider:   buildStoreProvider(cfg.Provider),
		Collection: jobsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	}
	collection, err := persistence.OpenTyped[Job](options)
	if err != nil {
		return nil, fmt.Errorf("open agent runner store: %w", err)
	}
	return &Store{collection: collection}, nil
}

func (s *Store) Create(ctx context.Context, provider string, input StartInput, result RunResult) (Job, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := Job{
		ID:               newJobID(),
		Provider:         strings.TrimSpace(provider),
		Status:           result.Status,
		Mode:             defaultMode(input.Mode),
		Task:             strings.TrimSpace(input.Task),
		Context:          cloneMap(input.Context),
		AllowCodeChanges: input.AllowCodeChanges,
		CreatedAt:        now,
		UpdatedAt:        now,
		Result:           strings.TrimSpace(result.Result),
		Error:            strings.TrimSpace(result.Error),
		Debug:            strings.TrimSpace(result.Debug),
	}
	if err := s.collection.Set(ctx, job.ID, job); err != nil {
		return Job{}, fmt.Errorf("create agent runner job: %w", err)
	}
	return job, nil
}

func (s *Store) Update(ctx context.Context, id string, apply func(*Job)) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok, err := s.collection.Get(ctx, id)
	if err != nil {
		return Job{}, fmt.Errorf("get agent runner job %s: %w", id, err)
	}
	if !ok {
		return Job{}, fmt.Errorf("agent runner job %s not found", id)
	}

	apply(&job)
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.collection.Set(ctx, id, job); err != nil {
		return Job{}, fmt.Errorf("update agent runner job %s: %w", id, err)
	}
	return job, nil
}

func (s *Store) Get(ctx context.Context, id string) (Job, bool, error) {
	return s.collection.Get(ctx, id)
}

func (s *Store) List(ctx context.Context) ([]Job, error) {
	jobs, err := s.collection.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list agent runner jobs: %w", err)
	}
	sort.SliceStable(jobs, func(i int, j int) bool {
		return agentRunnerJobCreatedBefore(jobs[i], jobs[j])
	})
	return jobs, nil
}

func agentRunnerJobCreatedBefore(a Job, b Job) bool {
	aTime, aOK := parseAgentRunnerJobTime(a.CreatedAt)
	bTime, bOK := parseAgentRunnerJobTime(b.CreatedAt)
	if aOK && bOK && !aTime.Equal(bTime) {
		return aTime.Before(bTime)
	}
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

func parseAgentRunnerJobTime(value string) (time.Time, bool) {
	timestamp, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, false
	}
	return timestamp, true
}

func buildStoreProvider(raw string) persistence.Provider {
	provider := persistence.NormalizeProvider(raw)
	if provider == "" {
		return persistence.ProviderMemory
	}
	return provider
}

func newJobID() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("job_%d", time.Now().UnixNano())
	}
	return "job_" + hex.EncodeToString(buffer)
}
