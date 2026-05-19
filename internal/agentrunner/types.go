package agentrunner

import (
	"context"
	"log/slog"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type JobStatus string

const (
	StatusQueued    JobStatus = "queued"
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusFailed    JobStatus = "failed"
	StatusTimeout   JobStatus = "timeout"
)

type Job struct {
	ID               string         `json:"id"`
	Provider         string         `json:"provider"`
	Status           JobStatus      `json:"status"`
	Mode             string         `json:"mode"`
	Task             string         `json:"task"`
	Context          map[string]any `json:"context,omitempty"`
	AllowCodeChanges bool           `json:"allow_code_changes"`
	CreatedAt        string         `json:"created_at"`
	UpdatedAt        string         `json:"updated_at"`
	Result           string         `json:"result,omitempty"`
	Error            string         `json:"error,omitempty"`
	Debug            string         `json:"debug,omitempty"`
}

type StartInput struct {
	Task             string
	Context          map[string]any
	Mode             string
	AllowCodeChanges bool
}

type Runner interface {
	Provider() string
	DryRun() bool
	StartTask(ctx context.Context, input StartInput) (Job, error)
	Cancel(ctx context.Context, id string) (Job, error)
	GetJob(ctx context.Context, id string) (Job, bool, error)
	ListJobs(ctx context.Context) ([]Job, error)
}

type OrphanedRunningRecoverer interface {
	RecoverOrphanedRunning(ctx context.Context, reason string) ([]Job, error)
}

type Config struct {
	Logger        *slog.Logger
	Persistence   appconfig.PersistenceConfig
	AgentRunner   appconfig.AgentRunnerConfig
	provider      runnerProvider
	store         *Store
	OnJobUpdate   JobCallback
	OnJobProgress JobCallback
}

type JobCallback func(ctx context.Context, job Job)

type RunResult struct {
	Status JobStatus
	Result string
	Error  string
	Debug  string
}

type runnerProvider interface {
	Provider() string
	DryRun() bool
	Run(ctx context.Context, input StartInput) (RunResult, error)
}
