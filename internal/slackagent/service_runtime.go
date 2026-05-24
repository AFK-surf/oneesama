package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

type StatusResponse struct {
	OK          bool              `json:"ok"`
	Service     string            `json:"service"`
	Mode        string            `json:"mode"`
	Persistence PersistenceStatus `json:"persistence"`
	Slack       SlackStatus       `json:"slack"`
	AgentRunner AgentRunnerStatus `json:"agent_runner"`
	Persona     PersonaStatus     `json:"persona_runtime"`
}

type PersistenceStatus struct {
	Provider   string `json:"provider"`
	DataDir    string `json:"data_dir"`
	SQLitePath string `json:"sqlite_path"`
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
	DailyReport             SlackDailyReportStatus     `json:"daily_report"`
	MeetingScanner          SlackMeetingScannerStatus  `json:"meeting_scanner"`
	ScannerCursors          SlackScannerCursorStats    `json:"scanner_cursors"`
	WorkspaceState          SlackWorkspaceStateStats   `json:"workspace_state"`
	ThreadCases             SlackThreadCaseStats       `json:"thread_cases"`
	WorkspacePolicy         SlackWorkspacePolicyStatus `json:"workspace_policy"`
	CustomEmoji             SlackCustomEmojiStatus     `json:"custom_emoji"`
}

type AgentRunnerStatus struct {
	Provider      string         `json:"provider"`
	Ready         bool           `json:"ready"`
	DryRun        bool           `json:"dry_run"`
	Model         string         `json:"model,omitempty"`
	ModelProvider string         `json:"model_provider,omitempty"`
	BaseURL       string         `json:"base_url,omitempty"`
	Jobs          int            `json:"jobs"`
	FailureCodes  map[string]int `json:"failure_codes,omitempty"`
	Error         string         `json:"error,omitempty"`
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
		OK:          true,
		Service:     "slack-agent",
		Mode:        "go-rewrite-r8",
		Persistence: s.persistenceStatus(),
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
			DailyReport:             s.dailyReportStatus(),
			MeetingScanner:          s.meetingScannerStatus(),
			ScannerCursors:          scannerCursorStats,
			WorkspaceState:          workspaceStats,
			ThreadCases:             threadCaseStats,
			WorkspacePolicy:         s.slackWorkspacePolicyStatus(),
			CustomEmoji:             s.customEmojiStatus(),
		},
		AgentRunner: runnerStatus,
		Persona:     s.personaStatus(ctx),
	}
}

func (s *Service) persistenceStatus() PersistenceStatus {
	return PersistenceStatus{
		Provider:   s.persistence.Provider,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
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
	if delivery := s.canvasPublicNotificationPreflight(ctx, input); delivery.Blocked {
		return PublishedCanvasManifest{
			ID:          firstNonEmpty(input.ID, input.ArtifactID, input.Artifact.ID),
			Provider:    normalizeCanvasProvider(s.canvasConfig.Provider),
			Surface:     slackPublicReplySurfaceCanvasNotification,
			ArtifactID:  firstNonEmpty(input.ArtifactID, input.Artifact.ID),
			OK:          false,
			Destination: strings.TrimSpace(input.Destination),
			Blocked:     true,
			BlockReason: delivery.BlockReason,
			BlockedTS:   delivery.BlockedTS,
		}, nil
	}
	publisher, err := s.getCanvasPublisher()
	if err != nil {
		return PublishedCanvasManifest{}, err
	}
	publishInput := input
	if s.canvasPublishNeedsControlledSlackPost(input) {
		publishInput.SuppressSlackPost = true
	}
	manifest, err := publisher.Publish(ctx, publishInput)
	if err != nil {
		return PublishedCanvasManifest{}, err
	}
	if publishInput.SuppressSlackPost {
		manifest = s.deliverCanvasPublicSlackPost(ctx, input, manifest)
		if err := persistPublishedCanvasManifest(manifest); err != nil {
			return PublishedCanvasManifest{}, err
		}
	}
	return manifest, nil
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

func (s *Service) canvasPublicNotificationPreflight(ctx context.Context, input CanvasPublishInput) slackPublicThreadReplyDeliveryResult {
	if strings.TrimSpace(input.Channel) == "" || strings.TrimSpace(input.ThreadTS) == "" || strings.TrimSpace(input.SnapshotTS) == "" {
		return slackPublicThreadReplyDeliveryResult{}
	}
	message := firstNonEmpty(input.NotificationText, input.SummaryMarkdown, input.Title, "canvas publication")
	return s.deliverSlackPublicThreadReply(ctx, s.canvasPublicNotificationDelivery(input, message, input.DedupKey, true))
}

func (s *Service) canvasPublishNeedsControlledSlackPost(input CanvasPublishInput) bool {
	channel := strings.TrimSpace(input.Channel)
	if channel == "" {
		return false
	}
	provider := normalizeCanvasProvider(s.canvasConfig.Provider)
	if provider == "slack-thread" {
		return true
	}
	if provider == "slack-canvas" || input.ForceSlackCanvas {
		return strings.TrimSpace(input.NotificationText) != ""
	}
	return false
}

func (s *Service) deliverCanvasPublicSlackPost(ctx context.Context, input CanvasPublishInput, manifest PublishedCanvasManifest) PublishedCanvasManifest {
	if manifest.Blocked || !manifest.OK {
		return manifest
	}
	channel := strings.TrimSpace(input.Channel)
	if channel == "" {
		return manifest
	}
	artifactID := firstNonEmpty(input.ArtifactID, input.Artifact.ID, manifest.ArtifactID, manifest.ID)
	dedupKey := firstNonEmpty(input.DedupKey, defaultCanvasDedupKey(artifactID, channel, input.ThreadTS))
	message := strings.TrimSpace(input.NotificationText)
	if message != "" && manifest.Canvas != nil {
		message = strings.ReplaceAll(message, "{{canvas_link}}", slackCanvasMarkdownLink(*manifest.Canvas))
	}
	if message == "" {
		markdown, err := renderCanvasMarkdown(input)
		if err != nil {
			manifest.OK = false
			manifest.Slack = &PostMessageResult{OK: false, Error: "render_canvas_notification_failed", Detail: err.Error()}
			return manifest
		}
		message = truncateSlackText(markdown)
	}
	delivery := s.deliverSlackPublicThreadReply(ctx, s.canvasPublicNotificationDelivery(input, message, dedupKey, false))
	if delivery.Blocked {
		manifest.OK = false
		manifest.Blocked = true
		manifest.BlockReason = delivery.BlockReason
		manifest.BlockedTS = delivery.BlockedTS
		manifest.Slack = &delivery.Post
		return manifest
	}
	manifest.Slack = &delivery.Post
	manifest.OK = manifest.OK && delivery.Post.OK
	if delivery.Post.Mock {
		manifest.Surface = "mock-slack-thread"
	} else if strings.TrimSpace(input.NotificationText) == "" {
		manifest.Surface = "slack-thread"
	}
	return manifest
}

func (s *Service) canvasPublicNotificationDelivery(input CanvasPublishInput, message string, dedupKey string, freshnessOnly bool) slackPublicThreadReplyDelivery {
	delivery := slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceCanvasNotification,
		SurfaceKind:   slackPublicReplySurfaceCanvasNotification,
		WorkspaceID:   input.WorkspaceID,
		ChannelID:     input.Channel,
		ThreadTS:      input.ThreadTS,
		Message:       message,
		FallbackText:  message,
		DedupKey:      dedupKey,
		SnapshotTS:    input.SnapshotTS,
		FreshnessOnly: freshnessOnly,
	}
	if s.canvasConfig.Poster != nil {
		delivery.Poster = s.canvasConfig.Poster
	}
	return delivery
}

func persistPublishedCanvasManifest(manifest PublishedCanvasManifest) error {
	if strings.TrimSpace(manifest.ManifestPath) == "" {
		return nil
	}
	return writeJSONFile(manifest.ManifestPath, manifest)
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
		status.FailureCodes = agentRunnerFailureCodeCounts(jobs)
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

func agentRunnerFailureCodeCounts(jobs []agentrunner.Job) map[string]int {
	counts := make(map[string]int)
	for _, job := range jobs {
		code := strings.TrimSpace(string(job.FailureCode))
		if code == "" {
			continue
		}
		counts[code]++
	}
	if len(counts) == 0 {
		return nil
	}
	return counts
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
