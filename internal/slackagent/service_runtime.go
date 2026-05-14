package slackagent

import (
	"context"
	"fmt"
	"strings"
)

type StatusResponse struct {
	OK          bool              `json:"ok"`
	Service     string            `json:"service"`
	Mode        string            `json:"mode"`
	Persistence map[string]string `json:"persistence"`
	Slack       SlackStatus       `json:"slack"`
	AgentRunner AgentRunnerStatus `json:"agent_runner"`
}

type SlackStatus struct {
	SigningSecretConfigured bool                  `json:"signing_secret_configured"`
	BotTokenConfigured      bool                  `json:"bot_token_configured"`
	AppTokenConfigured      bool                  `json:"app_token_configured"`
	PosterMode              string                `json:"poster_mode"`
	CanvasProvider          string                `json:"canvas_provider"`
	ScheduleManagerReady    bool                  `json:"schedule_manager_ready"`
	WorkspaceDir            string                `json:"workspace_dir"`
	InternalAuthConfigured  bool                  `json:"internal_auth_configured"`
	SocketMode              SlackSocketModeStatus `json:"socket_mode"`
}

type AgentRunnerStatus struct {
	Provider string `json:"provider"`
	Ready    bool   `json:"ready"`
	DryRun   bool   `json:"dry_run"`
	Jobs     int    `json:"jobs"`
	Error    string `json:"error,omitempty"`
}

type AvatarCommandInput struct {
	Text              string
	TeamID            string
	TeamDomain        string
	ChannelID         string
	ChannelName       string
	ThreadTS          string
	ReactionTS        string
	UserID            string
	UserName          string
	Command           string
	RichThreadContext *SlackAppMentionContext
}

type AvatarCommandResponse struct {
	OK              bool             `json:"ok"`
	ResponseType    string           `json:"response_type,omitempty"`
	Text            string           `json:"text"`
	Blocks          []map[string]any `json:"blocks,omitempty"`
	ReplaceOriginal bool             `json:"replace_original,omitempty"`
	Metadata        map[string]any   `json:"metadata,omitempty"`
}

func (s *Service) Status() StatusResponse {
	runnerStatus := s.agentRunnerStatus(context.Background())
	return StatusResponse{
		OK:      true,
		Service: "slack-agent",
		Mode:    "go-rewrite-r8",
		Persistence: map[string]string{
			"provider":    s.persistence.Provider,
			"data_dir":    s.persistence.DataDir,
			"sqlite_path": s.persistence.SQLitePath,
		},
		Slack: SlackStatus{
			SigningSecretConfigured: s.signingSecret != "",
			BotTokenConfigured:      s.botToken != "",
			AppTokenConfigured:      s.appToken != "",
			PosterMode:              s.posterMode(),
			CanvasProvider:          s.canvasConfig.Provider,
			ScheduleManagerReady:    s.scheduleManager != nil,
			WorkspaceDir:            s.workspaceDir,
			InternalAuthConfigured:  s.internalAuthKey != "",
			SocketMode:              s.socketModeStatus(),
		},
		AgentRunner: runnerStatus,
	}
}

func (s *Service) VerifyRequest(rawBody string, timestamp string, signature string) SlackRequestVerification {
	return VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: s.signingSecret,
		Timestamp:     timestamp,
		Signature:     signature,
		RawBody:       rawBody,
	})
}

func (s *Service) PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult {
	return s.poster.PostMessage(ctx, input)
}

func (s *Service) PublishCanvas(ctx context.Context, input CanvasPublishInput) (PublishedCanvasManifest, error) {
	publisher, err := s.getCanvasPublisher()
	if err != nil {
		return PublishedCanvasManifest{}, err
	}
	return publisher.Publish(ctx, input)
}

func (s *Service) ListPublishedCanvas() ([]PublishedCanvasManifest, error) {
	publisher, err := s.getCanvasPublisher()
	if err != nil {
		return nil, err
	}
	return publisher.ListPublished()
}

func (s *Service) getCanvasPublisher() (CanvasPublisherService, error) {
	s.canvasMu.Lock()
	defer s.canvasMu.Unlock()

	if s.canvasPublisher != nil {
		return s.canvasPublisher, nil
	}

	publisher, err := NewCanvasPublisher(s.canvasConfig)
	if err != nil {
		s.logger.Warn("canvas publisher init failed", "error", err)
		return nil, fmt.Errorf("init canvas publisher: %w", err)
	}
	s.canvasPublisher = publisher
	return s.canvasPublisher, nil
}

func (s *Service) posterMode() string {
	if s.botToken == "" {
		return "mock"
	}
	return "slack-api"
}

func cloneMetadata(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func (s *Service) agentRunnerStatus(ctx context.Context) AgentRunnerStatus {
	status := AgentRunnerStatus{
		Provider: strings.TrimSpace(s.agentRunner.Provider),
		Ready:    s.runner != nil && s.runnerErr == nil,
		DryRun:   s.agentRunner.DryRun,
	}
	if s.runner != nil {
		status.Provider = s.runner.Provider()
		status.DryRun = s.runner.DryRun()
		jobs, err := s.runner.ListJobs(ctx)
		if err != nil {
			status.Ready = false
			status.Error = err.Error()
			return status
		}
		status.Jobs = len(jobs)
		return status
	}
	if s.runnerErr != nil {
		status.Error = s.runnerErr.Error()
	}
	if status.Provider == "" {
		status.Provider = "dry-run"
	}
	return status
}
