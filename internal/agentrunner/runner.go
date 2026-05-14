package agentrunner

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type Manager struct {
	logger        *slog.Logger
	store         *Store
	provider      runnerProvider
	jobTimeout    time.Duration
	cancelMu      sync.Mutex
	cancelers     map[string]context.CancelFunc
	onJobUpdate   JobCallback
	onJobProgress JobCallback
}

func New(cfg Config) (Runner, error) {
	store := cfg.store
	if store == nil {
		var err error
		store, err = openStore(cfg.Persistence)
		if err != nil {
			return nil, err
		}
	}
	provider := cfg.provider
	if provider == nil {
		var err error
		provider, err = newProvider(cfg.AgentRunner)
		if err != nil {
			return nil, err
		}
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	return &Manager{
		logger:        logger,
		store:         store,
		provider:      provider,
		jobTimeout:    cfg.AgentRunner.JobTimeout,
		cancelers:     make(map[string]context.CancelFunc),
		onJobUpdate:   cfg.OnJobUpdate,
		onJobProgress: cfg.OnJobProgress,
	}, nil
}

func (m *Manager) Provider() string {
	return m.provider.Provider()
}

func (m *Manager) DryRun() bool {
	return m.provider.DryRun()
}

func (m *Manager) StartTask(ctx context.Context, input StartInput) (Job, error) {
	normalized := normalizeStartInput(input)
	if m.provider.DryRun() {
		result, err := m.provider.Run(ctx, normalized)
		if err != nil {
			job, createErr := m.store.Create(ctx, m.Provider(), normalized, failedResult(result, err))
			m.notifyJobUpdate(ctx, job)
			return job, createErr
		}
		job, createErr := m.store.Create(ctx, m.Provider(), normalized, result)
		m.notifyJobUpdate(ctx, job)
		return job, createErr
	}

	job, err := m.store.Create(ctx, m.Provider(), normalized, RunResult{Status: StatusRunning})
	if err != nil {
		return Job{}, err
	}

	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.jobTimeout)
	m.setCanceler(job.ID, cancel)
	m.notifyJobProgress(runCtx, job)
	go m.finishJob(runCtx, job.ID, normalized)
	return job, nil
}

func (m *Manager) Cancel(ctx context.Context, id string) (Job, error) {
	cancel, ok := m.takeCanceler(id)
	if !ok {
		job, found, err := m.store.Get(ctx, id)
		if err != nil {
			return Job{}, err
		}
		if !found {
			return Job{}, fmt.Errorf("agent runner job %s not found", id)
		}
		return job, fmt.Errorf("agent runner job %s is not cancelable", id)
	}

	cancel()
	job, found, err := m.store.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if !found {
		return Job{}, fmt.Errorf("agent runner job %s not found", id)
	}
	return job, nil
}

func (m *Manager) GetJob(ctx context.Context, id string) (Job, bool, error) {
	return m.store.Get(ctx, id)
}

func (m *Manager) ListJobs(ctx context.Context) ([]Job, error) {
	return m.store.List(ctx)
}

func (m *Manager) finishJob(ctx context.Context, id string, input StartInput) {
	defer m.clearCanceler(id)

	result, err := m.provider.Run(ctx, input)
	if err != nil {
		result = failedResult(result, err)
	}

	updateCtx := context.WithoutCancel(ctx)
	updated, updateErr := m.store.Update(updateCtx, id, func(job *Job) {
		job.Status = result.Status
		job.Result = strings.TrimSpace(result.Result)
		job.Error = strings.TrimSpace(result.Error)
		job.Debug = strings.TrimSpace(result.Debug)
	})
	if updateErr != nil {
		m.logger.Error("agent runner job update failed", "job_id", id, "error", updateErr)
		return
	}
	m.notifyJobUpdate(updateCtx, updated)
}

func (m *Manager) notifyJobUpdate(ctx context.Context, job Job) {
	if job.ID == "" || m.onJobUpdate == nil {
		return
	}
	go m.onJobUpdate(context.WithoutCancel(ctx), job)
}

func (m *Manager) notifyJobProgress(ctx context.Context, job Job) {
	if job.ID == "" || m.onJobProgress == nil {
		return
	}
	go m.onJobProgress(context.WithoutCancel(ctx), job)
}

func (m *Manager) setCanceler(id string, cancel context.CancelFunc) {
	m.cancelMu.Lock()
	defer m.cancelMu.Unlock()
	m.cancelers[id] = cancel
}

func (m *Manager) takeCanceler(id string) (context.CancelFunc, bool) {
	m.cancelMu.Lock()
	defer m.cancelMu.Unlock()
	cancel, ok := m.cancelers[id]
	if ok {
		delete(m.cancelers, id)
	}
	return cancel, ok
}

func (m *Manager) clearCanceler(id string) {
	m.cancelMu.Lock()
	defer m.cancelMu.Unlock()
	delete(m.cancelers, id)
}

func newProvider(cfg appconfig.AgentRunnerConfig) (runnerProvider, error) {
	switch normalizeProvider(cfg.Provider) {
	case "", "dry-run":
		return dryRunProvider{}, nil
	case "codex":
		return newCodexProvider(cfg), nil
	case "claude", "claude-code":
		return newClaudeProvider(cfg), nil
	case "ollama", "ollama-http", "local-ollama":
		return newOllamaProvider(cfg), nil
	default:
		return nil, fmt.Errorf("unsupported agent runner provider %q", cfg.Provider)
	}
}

func normalizeStartInput(input StartInput) StartInput {
	return StartInput{
		Task:             strings.ToValidUTF8(strings.TrimSpace(input.Task), ""),
		Context:          cloneMap(input.Context),
		Mode:             defaultMode(input.Mode),
		AllowCodeChanges: input.AllowCodeChanges,
	}
}

func normalizeProvider(value string) string {
	return strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func failedResult(result RunResult, err error) RunResult {
	if result.Status == "" || result.Status == StatusCompleted {
		result.Status = StatusFailed
	}
	if strings.TrimSpace(result.Error) == "" {
		result.Error = err.Error()
	}
	return result
}

func cloneMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}
