package slackagent

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/pkg/config"
)

func NewServer(cfg config.Config, logger *slog.Logger) *httpserver.ManagedServer {
	slackConfig := cfg.Slack
	if strings.TrimSpace(slackConfig.PublicBaseURL) == "" {
		slackConfig.PublicBaseURL = localServiceURL(cfg.SlackAgent.Listen)
	}
	service := NewService(Config{
		Logger:                 logger,
		Persistence:            cfg.Persistence,
		Slack:                  slackConfig,
		AgentRunner:            cfg.AgentRunner,
		PersonaRuntime:         cfg.PersonaRuntime,
		DefaultCaptionLanguage: cfg.Meetd.CaptionLanguage,
		MeetingAgentURL:        localServiceURL(cfg.MeetingAgent.Listen),
		MeetWebhookSecret:      cfg.Meetd.WebhookSecret,
		ConfigFilePath:         cfg.ConfigFilePath,
	})
	handler := NewHandler(service)
	router := httpserver.New("slack-agent", logger, cfg.SlackAgent.AllowedOrigins, handler)

	server := &http.Server{
		Addr:              cfg.SlackAgent.Listen,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := service.Start(); err != nil {
		logger.Warn("slack-agent background start failed", "error", err)
	}
	return &httpserver.ManagedServer{
		Server: server,
		Shutdown: func(ctx context.Context) error {
			return service.Shutdown(ctx)
		},
	}
}

func localServiceURL(listen string) string {
	address := strings.TrimSpace(listen)
	switch {
	case address == "":
		return ""
	case strings.HasPrefix(address, ":"):
		return fmt.Sprintf("http://127.0.0.1%s", address)
	case strings.HasPrefix(address, "0.0.0.0:"):
		return "http://127.0.0.1:" + strings.TrimPrefix(address, "0.0.0.0:")
	case strings.HasPrefix(address, "http://") || strings.HasPrefix(address, "https://"):
		return strings.TrimRight(address, "/")
	default:
		return "http://" + address
	}
}
