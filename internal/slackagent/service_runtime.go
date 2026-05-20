package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

type StatusResponse struct {
	OK          bool              `json:"ok"`
	Service     string            `json:"service"`
	Mode        string            `json:"mode"`
	Persistence map[string]string `json:"persistence"`
	Slack       SlackStatus       `json:"slack"`
	AgentRunner AgentRunnerStatus `json:"agent_runner"`
	Persona     PersonaStatus     `json:"persona_runtime"`
}

type SlackStatus struct {
	SigningSecretConfigured bool                       `json:"signing_secret_configured"`
	BotTokenConfigured      bool                       `json:"bot_token_configured"`
	AppTokenConfigured      bool                       `json:"app_token_configured"`
	BotUserID               string                     `json:"bot_user_id,omitempty"`
	PosterMode              string                     `json:"poster_mode"`
	CanvasProvider          string                     `json:"canvas_provider"`
	ScheduleManagerReady    bool                       `json:"schedule_manager_ready"`
	WorkspaceDir            string                     `json:"workspace_dir"`
	InternalAuthConfigured  bool                       `json:"internal_auth_configured"`
	SocketMode              SlackSocketModeStatus      `json:"socket_mode"`
	HeartbeatTicker         SlackHeartbeatTickerStatus `json:"heartbeat_ticker"`
	MeetingScanner          SlackMeetingScannerStatus  `json:"meeting_scanner"`
	ScannerCursors          SlackScannerCursorStats    `json:"scanner_cursors"`
	WorkspaceState          SlackWorkspaceStateStats   `json:"workspace_state"`
	ThreadCases             SlackThreadCaseStats       `json:"thread_cases"`
	CustomEmoji             SlackCustomEmojiStatus     `json:"custom_emoji"`
}

type AgentRunnerStatus struct {
	Provider      string `json:"provider"`
	Ready         bool   `json:"ready"`
	DryRun        bool   `json:"dry_run"`
	Model         string `json:"model,omitempty"`
	ModelProvider string `json:"model_provider,omitempty"`
	BaseURL       string `json:"base_url,omitempty"`
	Jobs          int    `json:"jobs"`
	Error         string `json:"error,omitempty"`
}

type PersonaStatus struct {
	Provider      string         `json:"provider"`
	Mode          string         `json:"mode"`
	Ready         bool           `json:"ready"`
	Healthy       bool           `json:"healthy"`
	ShadowOnly    bool           `json:"shadow_only"`
	Version       string         `json:"version,omitempty"`
	BaseURL       string         `json:"base_url,omitempty"`
	LastRequestAt string         `json:"last_request_at,omitempty"`
	LastLatencyMS int64          `json:"last_latency_ms,omitempty"`
	LastError     string         `json:"last_error,omitempty"`
	StateSummary  map[string]any `json:"state_summary,omitempty"`
	Error         string         `json:"error,omitempty"`
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
	ctx := context.Background()
	runnerStatus := s.agentRunnerStatus(ctx)
	scannerCursorStats := SlackScannerCursorStats{}
	if s.scannerCursors != nil {
		scannerCursorStats = s.scannerCursors.Stats(ctx)
	}
	workspaceStats := SlackWorkspaceStateStats{}
	if s.workspaceState != nil {
		workspaceStats = s.workspaceState.Stats(ctx)
	}
	threadCaseStats := SlackThreadCaseStats{}
	if s.threadCases != nil {
		threadCaseStats = s.threadCases.Stats(ctx)
	}
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
			BotUserID:               s.botUserID,
			PosterMode:              s.posterMode(),
			CanvasProvider:          s.canvasConfig.Provider,
			ScheduleManagerReady:    s.scheduleManager != nil,
			WorkspaceDir:            s.workspaceDir,
			InternalAuthConfigured:  s.internalAuthKey != "",
			SocketMode:              s.socketModeStatus(),
			HeartbeatTicker:         s.heartbeatTickerStatus(),
			MeetingScanner:          s.meetingScannerStatus(),
			ScannerCursors:          scannerCursorStats,
			WorkspaceState:          workspaceStats,
			ThreadCases:             threadCaseStats,
			CustomEmoji:             s.customEmojiStatus(),
		},
		AgentRunner: runnerStatus,
		Persona:     s.personaStatus(ctx),
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
		Provider:      strings.TrimSpace(s.agentRunner.Provider),
		Ready:         s.runner != nil && s.runnerErr == nil,
		DryRun:        s.agentRunner.DryRun,
		Model:         strings.TrimSpace(s.agentRunner.Codex.Model),
		ModelProvider: strings.TrimSpace(s.agentRunner.Codex.ModelProvider),
		BaseURL:       strings.TrimSpace(s.agentRunner.Codex.BaseURL),
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

func (s *Service) personaStatus(ctx context.Context) PersonaStatus {
	status := PersonaStatus{
		Provider:   strings.TrimSpace(s.personaRuntimeConfig.Provider),
		Mode:       strings.TrimSpace(s.personaRuntimeConfig.Mode),
		ShadowOnly: s.personaRuntimeConfig.ShadowOnly,
		BaseURL:    strings.TrimSpace(s.personaRuntimeConfig.BaseURL),
	}
	if status.Provider == "" {
		status.Provider = "legacy"
	}
	if status.Mode == "" {
		status.Mode = "shadow"
	}
	if s.personaRuntimeErr != nil {
		status.Error = s.personaRuntimeErr.Error()
		status.LastError = status.Error
		return status
	}
	if s.personaRuntime == nil {
		status.Error = "persona runtime unavailable"
		status.LastError = status.Error
		return status
	}
	remote := s.personaRuntime.Status(ctx)
	return personaStatusFromRuntime(remote, status)
}

func personaStatusFromRuntime(remote persona.Status, fallback PersonaStatus) PersonaStatus {
	status := fallback
	if strings.TrimSpace(remote.Provider) != "" {
		status.Provider = remote.Provider
	}
	if strings.TrimSpace(remote.Mode) != "" {
		status.Mode = remote.Mode
	}
	status.Ready = remote.Ready
	status.Healthy = remote.Healthy
	status.ShadowOnly = remote.ShadowOnly || fallback.ShadowOnly
	status.Version = remote.Version
	status.LastRequestAt = remote.LastRequestAt
	status.LastLatencyMS = remote.LastLatencyMS
	status.LastError = remote.LastError
	status.StateSummary = remote.StateSummary
	return status
}
