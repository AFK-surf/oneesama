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
	Meetd              appconfig.MeetdConfig
	DemoSurface        appconfig.DemoSurfaceConfig
	CaptionLanguage    string
	OpenAI             appconfig.OpenAIConfig
	SlackBotToken      string
	SlackAPIBaseURL    string
	Dialog             appconfig.DialogConfig
	HTTPClient         *http.Client
	DemoBridge         *RealtimeDemoBridge
}

type Service struct {
	logger              *slog.Logger
	persistence         appconfig.PersistenceConfig
	internalAuthKey     string
	pipeline            *postmeeting.Pipeline
	webhookSender       *postmeeting.WebhookSender
	meetRunner          meetrunner.Runner
	runner              agentrunner.Runner
	runnerErr           error
	sessionMu           sync.Mutex
	sessionStore        *persistence.TypedCollection[SessionRecord]
	workerMu            sync.Mutex
	workerStore         *persistence.TypedCollection[WorkerReport]
	meetdMu             sync.Mutex
	meetdWriteMu        sync.Mutex
	meetdStore          *persistence.TypedCollection[MeetdMeetingRecord]
	meetdCaptionStore   *persistence.TypedCollection[MeetdCaptionRecord]
	meetdSummaryStore   *persistence.TypedCollection[MeetdMeetingSummaryRecord]
	identityMu          sync.Mutex
	identityStore       *persistence.TypedCollection[IdentityUserRecord]
	slackUsersMu        sync.Mutex
	slackUsersCache     []IdentityUserRecord
	slackUsersFetchedAt time.Time
	meetdWebhook        MeetdWebhookSender
	meetdWebhookURL     string
	meetdWebhookSecret  string
	meetdWatchInterval  time.Duration
	demoSurface         appconfig.DemoSurfaceConfig
	captionLanguage     string
	openai              appconfig.OpenAIConfig
	slackBotToken       string
	slackAPIBaseURL     string
	dialog              appconfig.DialogConfig
	httpClient          *http.Client
	demoBridge          *RealtimeDemoBridge
	meetdWake           chan struct{}
	meetdRuntimeMu      sync.Mutex
	meetdRuntimeCancel  context.CancelFunc
	meetdRuntimeDone    chan struct{}
	backgroundMu        sync.Mutex
	backgroundCtx       context.Context
	backgroundCancel    context.CancelFunc
	backgroundWG        sync.WaitGroup
	backgroundStopping  bool
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
		pipeline = newPostMeetingPipeline(cfg.ArtifactsRootDir, cfg.Meetd, cfg.OpenAI, cfg.HTTPClient)
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
	backgroundCtx, backgroundCancel := context.WithCancel(context.Background())
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
		demoSurface:        normalizeDemoSurfaceConfig(cfg.DemoSurface),
		captionLanguage:    strings.TrimSpace(cfg.CaptionLanguage),
		openai:             cfg.OpenAI,
		slackBotToken:      strings.TrimSpace(cfg.SlackBotToken),
		slackAPIBaseURL:    strings.TrimRight(strings.TrimSpace(cfg.SlackAPIBaseURL), "/"),
		dialog:             cfg.Dialog,
		httpClient:         cfg.HTTPClient,
		demoBridge:         cfg.DemoBridge,
		meetdWake:          make(chan struct{}, 1),
		backgroundCtx:      backgroundCtx,
		backgroundCancel:   backgroundCancel,
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
	if service.demoBridge == nil && service.demoSurface.Enabled {
		service.demoBridge = service.newRealtimeDemoBridgeFromConfig()
	}
	return service
}

func (s *Service) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.StopMeetdRuntime(ctx); err != nil {
		return err
	}
	if stopped := s.stopActiveJoinSessionsForShutdown(ctx); stopped > 0 {
		s.logger.Info("stopped active join sessions before shutdown", "count", stopped)
	}
	s.cancelBackground()
	if err := s.waitBackground(ctx); err != nil {
		return err
	}
	if runner, ok := s.meetRunner.(shutdownRunner); ok {
		return runner.Shutdown(ctx)
	}
	return nil
}
