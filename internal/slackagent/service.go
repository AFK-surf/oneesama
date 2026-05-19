package slackagent

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persistence"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type PosterService interface {
	PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult
}

type CanvasPublisherService interface {
	Publish(ctx context.Context, input CanvasPublishInput) (PublishedCanvasManifest, error)
	ListPublished() ([]PublishedCanvasManifest, error)
}

type AssistantService interface {
	SetStatus(ctx context.Context, input AssistantStatusInput) AssistantAPIResult
	SetSuggestedPrompts(ctx context.Context, input AssistantSuggestedPromptsInput) AssistantAPIResult
}

type ReactionService interface {
	AddReaction(ctx context.Context, input SlackReactionInput) SlackReactionResult
	RemoveReaction(ctx context.Context, input SlackReactionInput) SlackReactionResult
}

type Config struct {
	Logger                 *slog.Logger
	Persistence            appconfig.PersistenceConfig
	Slack                  appconfig.SlackConfig
	AgentRunner            appconfig.AgentRunnerConfig
	PersonaRuntime         appconfig.PersonaRuntimeConfig
	DefaultCaptionLanguage string
	MeetingAgentURL        string
	MeetWebhookSecret      string
	ConfigFilePath         string
	SecretsFilePath        string
	OAuthExchanger         OAuthExchanger
	Poster                 PosterService
	Assistant              AssistantService
	Reactions              ReactionService
	CanvasPublisher        CanvasPublisherService
	CanvasPublisherConfig  CanvasPublisherConfig
	ScheduleManager        ScheduleManager
	Runner                 agentrunner.Runner
}

type Service struct {
	logger                  *slog.Logger
	startedAt               time.Time
	persistence             appconfig.PersistenceConfig
	signingSecret           string
	botToken                string
	appToken                string
	botUserID               string
	clientID                string
	clientSecret            string
	redirectURI             string
	workspaceDir            string
	internalAuthKey         string
	configFilePath          string
	secretsFilePath         string
	meetingAgentURL         string
	meetWebhookSecret       string
	publicBaseURL           string
	meetingScanner          meetingScannerConfig
	defaultCaptionLanguage  string
	oauthExchanger          OAuthExchanger
	poster                  PosterService
	assistant               AssistantService
	reactions               ReactionService
	scheduleManager         ScheduleManager
	slackContext            *slackContextStore
	meetingWebhooks         *meetingWebhookStore
	inbound                 *slackInboundBuffer
	triage                  *slackTriageStore
	cognition               *slackCognitionStore
	scannerCursors          *slackScannerCursorStore
	workspaceState          *slackWorkspaceStore
	threadCases             *slackThreadCaseStore
	mentionQueue            *slackMentionQueue
	operatorFallback        *SlackOperatorFallback
	localMemory             *localSlackMemory
	followups               *slackHeartbeatStore
	improvements            *slackImprovementStore
	feedback                *slackFeedbackStore
	agentRunner             appconfig.AgentRunnerConfig
	runner                  agentrunner.Runner
	runnerErr               error
	personaRuntime          persona.Runtime
	personaRuntimeErr       error
	personaRuntimeConfig    appconfig.PersonaRuntimeConfig
	triagePostActions       bool
	triageHeuristicFallback bool

	canvasMu        sync.Mutex
	canvasConfig    CanvasPublisherConfig
	canvasPublisher CanvasPublisherService

	installationMu    sync.Mutex
	installationStore *persistence.TypedCollection[SlackInstallation]

	socketModeMu sync.Mutex
	socketMode   *SocketModeRunner

	scannerMu      sync.Mutex
	scannerCancel  context.CancelFunc
	scannerBackoff map[string]time.Time
	scannerSweeps  []time.Time
	scanner429s    []time.Time

	meetingScannerMu          sync.Mutex
	meetingScannerCancel      context.CancelFunc
	meetingScannerTicks       []time.Time
	meetingScannerLastTickAt  time.Time
	meetingScannerLastError   string
	meetingScannerLastScanned int
	meetingScannerLastPosted  int
	meetingScannerLastSkipped int

	heartbeatMu          sync.Mutex
	heartbeatCancel      context.CancelFunc
	heartbeatTicks       []time.Time
	heartbeatLastTickAt  time.Time
	heartbeatLastPosted  int
	heartbeatLastSkipped int
	heartbeatLastError   string

	eventMu    sync.Mutex
	seenEvents map[string]time.Time

	assistantMu             sync.Mutex
	assistantStatusByThread map[string]*assistantThreadStatusState

	workerReportMu        sync.Mutex
	finalizedWorkerJobIDs map[string]struct{}

	triageMu               sync.Mutex
	finalizedTriageJobIDs  map[string]struct{}
	finalizedTriageResults map[string]*SlackTriageFinalization

	compactMu                 sync.Mutex
	lastScannerCompactionHash string
}

func NewService(cfg Config) *Service {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	poster := cfg.Poster
	if poster == nil {
		poster = NewPoster(PosterConfig{
			BotToken: cfg.Slack.BotToken,
		})
	}
	oauthExchanger := cfg.OAuthExchanger
	if oauthExchanger == nil {
		oauthExchanger = NewSlackOAuthExchanger(nil)
	}
	assistant := cfg.Assistant
	if assistant == nil {
		assistant = NewSlackAssistantClient(AssistantClientConfig{
			BotToken: cfg.Slack.BotToken,
		})
	}
	reactions := cfg.Reactions
	if reactions == nil {
		reactions = NewSlackReactionClient(SlackReactionClientConfig{
			BotToken: cfg.Slack.BotToken,
		})
	}
	runner := cfg.Runner
	var runnerErr error
	var service *Service
	if runner == nil {
		runner, runnerErr = agentrunner.New(agentrunner.Config{
			Logger:      logger,
			Persistence: cfg.Persistence,
			AgentRunner: cfg.AgentRunner,
			OnJobUpdate: func(ctx context.Context, job agentrunner.Job) {
				if service != nil {
					service.handleAgentRunnerUpdate(ctx, job)
				}
			},
			OnJobProgress: func(ctx context.Context, job agentrunner.Job) {
				if service != nil {
					service.handleAgentRunnerProgress(ctx, job)
				}
			},
		})
		if runnerErr != nil {
			logger.Warn("agent runner init failed", "error", runnerErr)
		}
	}
	personaRuntime, personaRuntimeErr := persona.NewRuntime(persona.Config{
		Provider:   cfg.PersonaRuntime.Provider,
		Mode:       cfg.PersonaRuntime.Mode,
		BaseURL:    cfg.PersonaRuntime.BaseURL,
		Timeout:    cfg.PersonaRuntime.Timeout,
		ShadowOnly: cfg.PersonaRuntime.ShadowOnly,
	})
	if personaRuntimeErr != nil {
		logger.Warn("persona runtime init failed", "error", personaRuntimeErr)
	}

	canvasConfig := cfg.CanvasPublisherConfig
	if strings.TrimSpace(canvasConfig.Provider) == "" {
		canvasConfig.Provider = "file"
	}
	if strings.TrimSpace(canvasConfig.BotToken) == "" {
		canvasConfig.BotToken = cfg.Slack.BotToken
	}
	if canvasConfig.Poster == nil {
		if typedPoster, ok := poster.(*Poster); ok {
			canvasConfig.Poster = typedPoster
		}
	}

	service = &Service{
		logger:                 logger,
		startedAt:              timeNow().UTC(),
		persistence:            cfg.Persistence,
		signingSecret:          strings.TrimSpace(cfg.Slack.SigningSecret),
		botToken:               strings.TrimSpace(cfg.Slack.BotToken),
		appToken:               strings.TrimSpace(cfg.Slack.AppToken),
		botUserID:              strings.TrimSpace(cfg.Slack.BotUserID),
		clientID:               strings.TrimSpace(cfg.Slack.ClientID),
		clientSecret:           strings.TrimSpace(cfg.Slack.ClientSecret),
		redirectURI:            strings.TrimSpace(cfg.Slack.RedirectURI),
		workspaceDir:           strings.TrimSpace(cfg.Slack.WorkspaceDir),
		internalAuthKey:        strings.TrimSpace(cfg.Slack.InternalAuthKey),
		configFilePath:         strings.TrimSpace(cfg.ConfigFilePath),
		secretsFilePath:        strings.TrimSpace(cfg.SecretsFilePath),
		meetingAgentURL:        strings.TrimSpace(cfg.MeetingAgentURL),
		meetWebhookSecret:      strings.TrimSpace(cfg.MeetWebhookSecret),
		publicBaseURL:          strings.TrimSpace(cfg.Slack.PublicBaseURL),
		meetingScanner:         newMeetingScannerConfig(cfg.Slack.MeetingScanner),
		defaultCaptionLanguage: strings.TrimSpace(cfg.DefaultCaptionLanguage),
		oauthExchanger:         oauthExchanger,
		poster:                 poster,
		assistant:              assistant,
		reactions:              reactions,
		scheduleManager:        cfg.ScheduleManager,
		slackContext:           newSlackContextStore(cfg.Persistence, logger),
		meetingWebhooks:        newMeetingWebhookStore(cfg.Persistence, logger),
		inbound:                newSlackInboundBuffer(cfg.Slack.EventBuffer, nil),
		triage:                 newSlackTriageStore(cfg.Persistence, logger),
		cognition:              newSlackCognitionStore(cfg.Persistence, logger),
		scannerCursors:         newSlackScannerCursorStore(cfg.Persistence, logger),
		workspaceState:         newSlackWorkspaceStore(cfg.Persistence, logger),
		threadCases:            newSlackThreadCaseStore(cfg.Persistence, logger),
		mentionQueue:           newSlackMentionQueue(),
		operatorFallback: &SlackOperatorFallback{
			BotToken:       strings.TrimSpace(cfg.Slack.BotToken),
			APIBaseURL:     defaultSlackAPIBaseURL,
			Client:         nil,
			PilotUserID:    strings.TrimSpace(cfg.Slack.PilotUserID),
			DebugChannelID: strings.TrimSpace(cfg.Slack.DebugChannelID),
			Poster:         poster,
			DM:             newSlackDMPoster(),
		},
		localMemory:             newLocalSlackMemory(cfg.Slack.Memory),
		followups:               newSlackHeartbeatStore(cfg.Persistence, logger),
		improvements:            newSlackImprovementStore(cfg.Persistence, logger),
		feedback:                newSlackFeedbackStore(cfg.Persistence, logger),
		agentRunner:             cfg.AgentRunner,
		runner:                  runner,
		runnerErr:               runnerErr,
		personaRuntime:          personaRuntime,
		personaRuntimeErr:       personaRuntimeErr,
		personaRuntimeConfig:    cfg.PersonaRuntime,
		triagePostActions:       cfg.Slack.Triage.PostActions,
		triageHeuristicFallback: cfg.Slack.Triage.HeuristicFallback,
		canvasConfig:            canvasConfig,
		canvasPublisher:         cfg.CanvasPublisher,
		seenEvents:              make(map[string]time.Time),
		assistantStatusByThread: make(map[string]*assistantThreadStatusState),
		finalizedWorkerJobIDs:   make(map[string]struct{}),
		finalizedTriageJobIDs:   make(map[string]struct{}),
		finalizedTriageResults:  make(map[string]*SlackTriageFinalization),
		scannerBackoff:          make(map[string]time.Time),
	}
	service.inbound.onFlush = func(channelID string) {
		_, err := service.FlushSlackInbound(context.Background(), channelID)
		if err != nil {
			service.logger.Warn("slack inbound buffer flush failed", "channel", channelID, "error", err)
		}
	}
	service.loadScannerCursors(context.Background())
	if service.workspaceDir != "" {
		result := EnsureWorkspaceFiles(EnsureWorkspaceFilesOptions{WorkspaceDir: service.workspaceDir})
		if !result.OK {
			service.logger.Warn("slack workspace bootstrap failed", "workspace_dir", service.workspaceDir, "error", result.Error)
		}
	}
	service.recoverOrphanedAgentRunnerJobs(context.Background())
	return service
}

func (s *Service) recoverOrphanedAgentRunnerJobs(ctx context.Context) {
	if s == nil || s.runner == nil {
		return
	}
	recoverer, ok := s.runner.(agentrunner.OrphanedRunningRecoverer)
	if !ok {
		return
	}
	recovered, err := recoverer.RecoverOrphanedRunning(ctx, "agent runner job orphaned after service restart")
	if err != nil {
		s.logger.Warn("agent runner orphan recovery failed", "error", err)
		return
	}
	if len(recovered) > 0 {
		s.logger.Warn("agent runner orphaned running jobs recovered", "count", len(recovered))
	}
}
