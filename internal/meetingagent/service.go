package meetingagent

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/persistence"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type Config struct {
	Logger             *slog.Logger
	Persistence        appconfig.PersistenceConfig
	ArtifactsRootDir   string
	InternalAuthKey    string
	MeetRunnerDir      string
	MeetRunner         meetrunner.Runner
	AgentRunner        appconfig.AgentRunnerConfig
	Runner             agentrunner.Runner
	Pipeline           *postmeeting.Pipeline
	WebhookSender      *postmeeting.WebhookSender
	MeetdWebhook       MeetdWebhookSender
	MeetdWebhookURL    string
	MeetdWebhookSecret string
	MeetdWatchInterval time.Duration
	CaptionLanguage    string
	OpenAI             appconfig.OpenAIConfig
	Dialog             appconfig.DialogConfig
	HTTPClient         *http.Client
}

type Service struct {
	logger             *slog.Logger
	persistence        appconfig.PersistenceConfig
	internalAuthKey    string
	pipeline           *postmeeting.Pipeline
	webhookSender      *postmeeting.WebhookSender
	meetRunner         meetrunner.Runner
	runner             agentrunner.Runner
	runnerErr          error
	sessionMu          sync.Mutex
	sessionStore       *persistence.TypedCollection[SessionRecord]
	workerMu           sync.Mutex
	workerStore        *persistence.TypedCollection[WorkerReport]
	meetdMu            sync.Mutex
	meetdWriteMu       sync.Mutex
	meetdStore         *persistence.TypedCollection[MeetdMeetingRecord]
	meetdCaptionStore  *persistence.TypedCollection[MeetdCaptionRecord]
	meetdSummaryStore  *persistence.TypedCollection[MeetdMeetingSummaryRecord]
	meetdWebhook       MeetdWebhookSender
	meetdWebhookURL    string
	meetdWebhookSecret string
	meetdWatchInterval time.Duration
	captionLanguage    string
	openai             appconfig.OpenAIConfig
	dialog             appconfig.DialogConfig
	httpClient         *http.Client
	meetdWake          chan struct{}
	meetdRuntimeCancel context.CancelFunc
	meetdRuntimeDone   chan struct{}
}

type shutdownRunner interface {
	Shutdown(ctx context.Context) error
}

func NewService(cfg Config) *Service {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	pipeline := cfg.Pipeline
	if pipeline == nil {
		pipeline = postmeeting.NewPipeline(cfg.ArtifactsRootDir)
	}
	webhookSender := cfg.WebhookSender
	if webhookSender == nil {
		webhookSender = postmeeting.NewWebhookSender(nil)
	}
	meetRunner := cfg.MeetRunner
	if meetRunner == nil {
		meetRunner = meetrunner.New(meetrunner.Config{Dir: cfg.MeetRunnerDir})
	}

	watchInterval := cfg.MeetdWatchInterval
	if watchInterval <= 0 {
		watchInterval = time.Minute
	}
	service := &Service{
		logger:             logger,
		persistence:        cfg.Persistence,
		internalAuthKey:    strings.TrimSpace(cfg.InternalAuthKey),
		pipeline:           pipeline,
		webhookSender:      webhookSender,
		meetRunner:         meetRunner,
		meetdWebhook:       cfg.MeetdWebhook,
		meetdWebhookURL:    strings.TrimSpace(cfg.MeetdWebhookURL),
		meetdWebhookSecret: strings.TrimSpace(cfg.MeetdWebhookSecret),
		meetdWatchInterval: watchInterval,
		captionLanguage:    strings.TrimSpace(cfg.CaptionLanguage),
		openai:             cfg.OpenAI,
		dialog:             cfg.Dialog,
		httpClient:         cfg.HTTPClient,
		meetdWake:          make(chan struct{}, 1),
	}
	if service.httpClient == nil {
		service.httpClient = httputil.NewHTTPClient(10 * time.Second)
	}
	if service.meetdWebhook == nil && service.meetdWebhookURL != "" {
		service.meetdWebhook = func(ctx context.Context, meeting MeetdMeetingRecord, result MeetdMeetingResult) error {
			return service.SendMeetdWebhook(ctx, "meeting.result", meeting, result)
		}
	}
	runner := cfg.Runner
	var runnerErr error
	if runner == nil {
		runner, runnerErr = agentrunner.New(agentrunner.Config{
			Logger:      logger,
			Persistence: cfg.Persistence,
			AgentRunner: cfg.AgentRunner,
			OnJobUpdate: func(ctx context.Context, job agentrunner.Job) {
				service.ReportFinishedWorkerJob(ctx, job)
			},
		})
		if runnerErr != nil {
			logger.Warn("meeting agent runner init failed", "error", runnerErr)
		}
	}
	service.runner = runner
	service.runnerErr = runnerErr
	return service
}

func (s *Service) Shutdown(ctx context.Context) error {
	if s.meetdRuntimeCancel != nil {
		s.meetdRuntimeCancel()
	}
	if s.meetdRuntimeDone != nil {
		select {
		case <-s.meetdRuntimeDone:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if runner, ok := s.meetRunner.(shutdownRunner); ok {
		return runner.Shutdown(ctx)
	}
	return nil
}
