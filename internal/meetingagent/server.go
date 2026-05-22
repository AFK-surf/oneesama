package meetingagent

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/pkg/config"
)

func NewServer(cfg config.Config, logger *slog.Logger) *httpserver.ManagedServer {
	service := NewService(Config{
		Logger:             logger,
		Persistence:        cfg.Persistence,
		ArtifactsRootDir:   "./runtime/meeting-artifacts",
		InternalAuthKey:    cfg.Slack.InternalAuthKey,
		MeetRunnerDir:      cfg.Paths.MeetRunnerDir,
		AgentRunner:        cfg.AgentRunner,
		MeetdWebhookURL:    cfg.Meetd.WebhookURL,
		MeetdWebhookSecret: cfg.Meetd.WebhookSecret,
		MeetdWatchInterval: cfg.Meetd.WatchInterval,
		Meetd:              cfg.Meetd,
		DemoSurface:        cfg.DemoSurface,
		CaptionLanguage:    cfg.Meetd.CaptionLanguage,
		OpenAI:             cfg.OpenAI,
		SlackBotToken:      cfg.Slack.BotToken,
		Dialog:             cfg.Dialog,
	})
	service.StartMeetdRuntime(context.Background())
	service.GoBackground(func(ctx context.Context) {
		finalized, err := service.RecoverUnavailableJoinSessions(ctx)
		if err != nil {
			service.logger.Warn("recover unavailable join sessions failed", "error", err)
			return
		}
		if finalized > 0 {
			service.logger.Info("finalized unavailable join sessions", "count", finalized)
		}
	})
	handler := NewHandler(service)
	router := httpserver.New("meeting-agent", logger, cfg.MeetingAgent.AllowedOrigins, handler)

	server := &http.Server{
		Addr:              cfg.MeetingAgent.Listen,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return &httpserver.ManagedServer{
		Server: server,
		Shutdown: func(ctx context.Context) error {
			return service.Shutdown(ctx)
		},
	}
}
