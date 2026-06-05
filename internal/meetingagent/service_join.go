package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

type InvalidRealtimeRuntimePlacementError struct {
	Reason string
}

func (e InvalidRealtimeRuntimePlacementError) Error() string {
	return e.Reason
}

func (s *Service) JoinGoogleMeet(ctx context.Context, input JoinGoogleMeetRequest) (JoinGoogleMeetResponse, error) {
	if strings.TrimSpace(input.MeetingURL) == "" {
		return JoinGoogleMeetResponse{}, fmt.Errorf("meeting_url is required")
	}

	runner, err := s.meetRunner.Ping(ctx)
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}
	sessionID := strings.TrimSpace(firstNonEmpty(input.SessionID, input.MeetingID))
	artifactsDir, err := s.artifactsDirUnderRoot(input.ArtifactsDir)
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}
	if artifactsDir == "" && input.RecordMeeting && sessionID != "" {
		artifactsDir = defaultJoinArtifactsDir(s.pipeline.RootDir(), sessionID)
	}
	if !input.DryRun {
		if err := s.stopOverlappingJoinSessions(ctx, input.MeetingURL, sessionID); err != nil {
			return JoinGoogleMeetResponse{}, err
		}
	}
	captureCaptions := input.CaptureCaptions || input.InstallRealtimeBridge
	realtimeCurrentUser := s.realtimeCurrentUser()
	realtimeTools := s.realtimeServerToolSchemas()
	realtimeOptions := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: realtimeCurrentUser,
		Tools:       realtimeTools,
	}
	realtimeInstructions := buildRealtimeInstructions(realtimeOptions, s.openai)
	realtimeSession := buildRealtimeSessionConfig(realtimeOptions, s.openai)
	if input.RealtimeSession != nil {
		realtimeSession = deepMergeMap(realtimeSession, input.RealtimeSession)
	}
	realtimeToolSchemaHash, _ := RealtimeToolSchemaStableHash(s.realtimeDemoSurfaceToolsExposed())
	realtimeRuntimePlacement := firstNonEmpty(strings.TrimSpace(input.RealtimeRuntimePlacement), s.openai.RealtimeRuntimePlacement)
	if realtimeRuntimePlacement == "" {
		realtimeRuntimePlacement = "sidecar"
	}
	meetBrowserControlMode := effectiveJoinMeetBrowserControlMode(input)
	retryPolicy, err := normalizeJoinRetryPolicy(input.RetryPolicy)
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}
	if input.InstallRealtimeBridge {
		if err := validateJoinRealtimeRuntimePlacement(realtimeRuntimePlacement); err != nil {
			return JoinGoogleMeetResponse{}, err
		}
	}
	meetUIInteractionMode := effectiveJoinMeetUIInteractionMode(input)
	includeParticipantAudio, forwardMeetAudioToRealtime := effectiveJoinRealtimeAudio(input)
	s.prewarmAppControlForJoinID(
		sessionID,
		input,
		!input.DryRun && shouldKeepAppControlWarmForJoin(input),
		"meeting_join_pre_admission",
	)
	prepareInput := meetrunner.PrepareGoogleMeetInput{
		SessionID:                  sessionID,
		MeetingURL:                 strings.TrimSpace(input.MeetingURL),
		DisplayName:                firstNonEmpty(strings.TrimSpace(input.DisplayName), strings.TrimSpace(s.openai.BotName), "Onee Sama"),
		Title:                      strings.TrimSpace(input.Title),
		DryRun:                     input.DryRun,
		AllowNonGoogleMeet:         input.AllowNonGoogleMeet,
		CollectFixtureState:        input.CollectFixtureState,
		CaptureCaptions:            captureCaptions,
		CaptionLanguage:            strings.TrimSpace(input.CaptionLanguage),
		RecordMeeting:              input.RecordMeeting,
		ArtifactsDir:               artifactsDir,
		MeetAudioBackend:           strings.TrimSpace(input.MeetAudioBackend),
		BrowserUserDataDir:         strings.TrimSpace(input.BrowserUserDataDir),
		MeetProfileMode:            strings.TrimSpace(input.MeetProfileMode),
		MeetUIInteractionMode:      meetUIInteractionMode,
		MeetJoinLane:               strings.TrimSpace(input.MeetJoinLane),
		MeetBrowserControlMode:     meetBrowserControlMode,
		RetryPolicy:                retryPolicy,
		InstallRealtimeBridge:      input.InstallRealtimeBridge,
		RealtimeBridgeMode:         strings.TrimSpace(input.RealtimeBridgeMode),
		RealtimeAgentRuntime:       firstNonEmpty(strings.TrimSpace(input.RealtimeAgentRuntime), s.openai.RealtimeAgentRuntime),
		RealtimeRuntimePlacement:   realtimeRuntimePlacement,
		RealtimeToolCallbackToken:  s.internalAuthKey,
		RealtimeInstructions:       realtimeInstructions,
		RealtimeTools:              realtimeTools,
		RealtimeSession:            realtimeSession,
		AutoConnectRealtime:        input.AutoConnectRealtime,
		SendRealtimeSessionUpdate:  input.SendRealtimeSessionUpdate,
		DryRunLocalTools:           input.DryRunLocalTools,
		IncludeParticipantAudio:    includeParticipantAudio,
		ForwardMeetAudioToRealtime: forwardMeetAudioToRealtime,
		MeetAudioInputGain:         input.MeetAudioInputGain,
		InstallLocalDialogBridge:   input.InstallLocalDialogBridge,
		InstallWorkerResultBridge:  input.InstallWorkerResultBridge,
		InstallScreenShareBridge:   input.InstallScreenShareBridge,
		AutoStartScreenShare:       input.AutoStartScreenShare,
		WorkerPollURL:              strings.TrimSpace(input.WorkerPollURL),
		WorkerResultMinCreatedAt:   strings.TrimSpace(input.WorkerResultMinCreatedAt),
		WorkerDelegateURL:          strings.TrimSpace(input.WorkerDelegateURL),
		WorkerStatusURL:            strings.TrimSpace(input.WorkerStatusURL),
		LocalDialogTurnURL:         strings.TrimSpace(input.LocalDialogTurnURL),
		LocalDialogTTSURL:          strings.TrimSpace(input.LocalDialogTTSURL),
		LocalDialogTTSMode:         strings.TrimSpace(input.LocalDialogTTSMode),
		LocalDialogTTSProvider:     strings.TrimSpace(input.LocalDialogTTSProvider),
		LocalDialogTTSGain:         formatOptionalFloat(input.LocalDialogTTSGain),
		ScreenShareMode:            strings.TrimSpace(input.ScreenShareMode),
		ScreenShareTitle:           strings.TrimSpace(input.ScreenShareTitle),
		ScreenShareSubtitle:        strings.TrimSpace(input.ScreenShareSubtitle),
		ScreenShareWidth:           input.ScreenShareWidth,
		ScreenShareHeight:          input.ScreenShareHeight,
		ScreenShareFPS:             input.ScreenShareFPS,
		BrowserExtraArgs:           strings.TrimSpace(input.BrowserExtraArgs),
	}
	prepare, admissionRetries, err := s.prepareGoogleMeetWithAdmissionRetry(ctx, input, prepareInput)
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}

	joinMetadata := map[string]any{
		"bridge_mode":                    prepare.BridgeMode,
		"runner_name":                    runner.Name,
		"started":                        prepare.Started,
		"capture_captions":               captureCaptions,
		"caption_language":               strings.TrimSpace(input.CaptionLanguage),
		"record_meeting":                 input.RecordMeeting,
		"artifacts_dir":                  artifactsDir,
		"realtime_join":                  input.InstallRealtimeBridge,
		"realtime_bridge_mode":           strings.TrimSpace(input.RealtimeBridgeMode),
		"realtime_agent_runtime":         firstNonEmpty(strings.TrimSpace(input.RealtimeAgentRuntime), s.openai.RealtimeAgentRuntime),
		"realtime_runtime_placement":     realtimeRuntimePlacement,
		"realtime_tool_count":            len(realtimeTools),
		"realtime_tool_schema_hash":      realtimeToolSchemaHash,
		"auto_connect_realtime":          input.AutoConnectRealtime,
		"send_realtime_session_update":   input.SendRealtimeSessionUpdate,
		"include_participant_audio":      includeParticipantAudio,
		"forward_meet_audio_to_realtime": forwardMeetAudioToRealtime,
		"meet_audio_input_gain":          input.MeetAudioInputGain,
		"meet_ui_interaction_mode":       meetUIInteractionMode,
		"meet_browser_control_mode":      meetBrowserControlMode,
		"slack_channel_id":               strings.TrimSpace(input.SlackChannelID),
		"slack_thread_ts":                strings.TrimSpace(input.SlackThreadTS),
	}
	if retryPolicy != "" {
		joinMetadata["retry_policy"] = retryPolicy
	}
	if len(admissionRetries) > 0 {
		joinMetadata["admission_retry_count"] = len(admissionRetries)
		joinMetadata["admission_retries"] = admissionRetries
	}
	if strings.TrimSpace(prepare.Error) != "" {
		joinMetadata["join_error"] = strings.TrimSpace(prepare.Error)
	}
	if strings.TrimSpace(prepare.Reason) != "" {
		joinMetadata["join_reason"] = strings.TrimSpace(prepare.Reason)
	}
	if strings.TrimSpace(prepare.Message) != "" {
		joinMetadata["join_message"] = strings.TrimSpace(prepare.Message)
	}
	if strings.TrimSpace(prepare.DiagnosticsPath) != "" {
		joinMetadata["diagnostics_path"] = strings.TrimSpace(prepare.DiagnosticsPath)
	}
	if strings.TrimSpace(prepare.ScreenshotDir) != "" {
		joinMetadata["screenshot_dir"] = strings.TrimSpace(prepare.ScreenshotDir)
	}
	if prepare.WebDriver != nil {
		joinMetadata["web_driver"] = prepare.WebDriver
	}

	session, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:         prepare.Session.ID,
		MeetingID:  strings.TrimSpace(firstNonEmpty(input.MeetingID, prepare.Session.ID)),
		MeetingURL: prepare.Session.MeetingURL,
		Status:     strings.TrimSpace(prepare.Session.Status),
		Title:      strings.TrimSpace(firstNonEmpty(input.Title, prepare.Session.Title)),
		StartedAt:  timestampIfStarted(prepare.Started),
		Metadata:   joinMetadata,
	})
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}
	if prepare.Started && !input.DryRun {
		go s.monitorJoinSession(context.WithoutCancel(ctx), session.ID)
	}
	s.prewarmAppControlForJoin(session, input, prepare.Started && !input.DryRun)

	return JoinGoogleMeetResponse{
		OK:              prepare.OK,
		Accepted:        prepare.Accepted,
		Started:         prepare.Started,
		Note:            prepare.Note,
		Error:           strings.TrimSpace(prepare.Error),
		Reason:          strings.TrimSpace(prepare.Reason),
		Message:         strings.TrimSpace(prepare.Message),
		DiagnosticsPath: strings.TrimSpace(prepare.DiagnosticsPath),
		ScreenshotDir:   strings.TrimSpace(prepare.ScreenshotDir),
		WebDriver:       prepare.WebDriver,
		MeetPage:        prepare.MeetPage,
		Session:         session,
		Plan:            prepare.Plan,
		Runner:          runner,
	}, nil
}

func effectiveJoinRealtimeAudio(input JoinGoogleMeetRequest) (includeParticipantAudio bool, forwardMeetAudioToRealtime bool) {
	forwardMeetAudioToRealtime = input.InstallRealtimeBridge
	if input.ForwardMeetAudioToRealtime != nil {
		forwardMeetAudioToRealtime = *input.ForwardMeetAudioToRealtime
	}
	if !input.InstallRealtimeBridge {
		forwardMeetAudioToRealtime = false
	}

	includeParticipantAudio = input.InstallRealtimeBridge && input.AutoConnectRealtime && forwardMeetAudioToRealtime
	if input.IncludeParticipantAudio != nil {
		includeParticipantAudio = *input.IncludeParticipantAudio
	}
	if !forwardMeetAudioToRealtime {
		includeParticipantAudio = false
	}
	return includeParticipantAudio, forwardMeetAudioToRealtime
}

func effectiveJoinMeetBrowserControlMode(input JoinGoogleMeetRequest) string {
	explicit := strings.TrimSpace(input.MeetBrowserControlMode)
	if explicit != "" {
		return explicit
	}
	if !googleMeetURL(input.MeetingURL) || strings.TrimSpace(input.BrowserUserDataDir) != "" {
		return ""
	}
	if strings.EqualFold(strings.TrimSpace(input.MeetProfileMode), "persistent") {
		return ""
	}
	if input.InstallRealtimeBridge ||
		input.AutoConnectRealtime ||
		input.InstallLocalDialogBridge ||
		input.InstallWorkerResultBridge ||
		input.InstallScreenShareBridge {
		return "playwright"
	}
	return ""
}

func effectiveJoinMeetUIInteractionMode(input JoinGoogleMeetRequest) string {
	explicit := strings.TrimSpace(input.MeetUIInteractionMode)
	if explicit != "" {
		return explicit
	}
	if !googleMeetURL(input.MeetingURL) || strings.TrimSpace(input.BrowserUserDataDir) != "" {
		return ""
	}
	if strings.EqualFold(strings.TrimSpace(input.MeetProfileMode), "persistent") {
		return ""
	}
	if input.InstallRealtimeBridge ||
		input.AutoConnectRealtime ||
		input.InstallLocalDialogBridge ||
		input.InstallWorkerResultBridge ||
		input.InstallScreenShareBridge {
		return "humanized"
	}
	return ""
}

func (s *Service) prepareGoogleMeetWithAdmissionRetry(ctx context.Context, input JoinGoogleMeetRequest, prepareInput meetrunner.PrepareGoogleMeetInput) (meetrunner.PrepareGoogleMeetResult, []map[string]any, error) {
	maxRetries := boundedJoinEnvInt("MAB_MEET_ADMISSION_RETRIES", "ONEESAMA_MEET_ADMISSION_RETRIES", 2, 0, 3)
	if strings.EqualFold(strings.TrimSpace(prepareInput.RetryPolicy), "none") {
		maxRetries = 0
	}
	retryDelayMs := boundedJoinEnvInt("MAB_MEET_ADMISSION_RETRY_DELAY_MS", "ONEESAMA_MEET_ADMISSION_RETRY_DELAY_MS", 1500, 0, 15_000)
	maxAttempts := 1 + maxRetries
	var admissionRetries []map[string]any
	var prepare meetrunner.PrepareGoogleMeetResult
	var err error

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		prepare, err = s.meetRunner.PrepareGoogleMeet(ctx, prepareInput)
		if err != nil {
			return prepare, admissionRetries, err
		}
		if attempt >= maxAttempts || !shouldRetryGoogleMeetAdmission(input, prepare) {
			break
		}

		retry := map[string]any{
			"attempt":          attempt,
			"next_attempt":     attempt + 1,
			"max_attempts":     maxAttempts,
			"error":            strings.TrimSpace(prepare.Error),
			"reason":           strings.TrimSpace(prepare.Reason),
			"message":          strings.TrimSpace(prepare.Message),
			"diagnostics_path": strings.TrimSpace(prepare.DiagnosticsPath),
			"delay_ms":         retryDelayMs,
		}
		if snapshotPath := snapshotJoinDiagnostics(prepare.DiagnosticsPath, attempt); snapshotPath != "" {
			retry["diagnostics_snapshot_path"] = snapshotPath
		}
		stopSessionID := strings.TrimSpace(firstNonEmpty(prepare.Session.ID, prepareInput.SessionID))
		if stopSessionID != "" {
			retry["session_id"] = stopSessionID
		}
		if stopSessionID != "" {
			stop, stopErr := s.meetRunner.StopSession(ctx, meetrunner.StopSessionInput{
				SessionID: stopSessionID,
				Reason:    "admission_retry",
			})
			if stopErr != nil {
				retry["stop_error"] = stopErr.Error()
			} else {
				retry["stop"] = map[string]any{
					"ok":      stop.OK,
					"status":  stop.Session.Status,
					"reason":  stop.Reason,
					"session": stop.Session.ID,
				}
			}
		}
		admissionRetries = append(admissionRetries, retry)
		s.logger.Warn("retrying transient google meet admission failure",
			"session_id", stopSessionID,
			"attempt", attempt,
			"next_attempt", attempt+1,
			"max_attempts", maxAttempts,
			"error", prepare.Error,
			"reason", prepare.Reason,
			"delay_ms", retryDelayMs,
		)
		if retryDelayMs > 0 {
			timer := time.NewTimer(time.Duration(retryDelayMs) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return prepare, admissionRetries, ctx.Err()
			case <-timer.C:
			}
		}
	}

	return prepare, admissionRetries, nil
}

func shouldRetryGoogleMeetAdmission(input JoinGoogleMeetRequest, prepare meetrunner.PrepareGoogleMeetResult) bool {
	if input.DryRun || !googleMeetURL(input.MeetingURL) {
		return false
	}
	if retryPolicy, err := normalizeJoinRetryPolicy(input.RetryPolicy); err != nil || retryPolicy == "none" {
		return false
	}
	if strings.TrimSpace(input.BrowserUserDataDir) != "" ||
		strings.EqualFold(strings.TrimSpace(input.MeetProfileMode), "persistent") {
		return false
	}
	if strings.TrimSpace(prepare.Error) != "cannot_join_meeting" {
		return false
	}
	// WebDriver has its own hard-block retry lane. Retrying here is for the anonymous Playwright
	// path where Meet sometimes flips from a short-lived admission block to joinable on a fresh tab,
	// including host-policy-looking "cannot join" pages that may clear after a fresh browser attempt.
	return prepare.WebDriver == nil
}

func normalizeJoinRetryPolicy(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "_", "-")
	if normalized == "" || normalized == "default" || normalized == "auto" {
		return "", nil
	}
	if normalized == "none" || normalized == "no-retry" || normalized == "no-retries" {
		return "none", nil
	}
	return "", fmt.Errorf("unsupported retry_policy %q", value)
}

func googleMeetURL(value string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(value))
	return strings.HasPrefix(trimmed, "https://meet.google.com/") ||
		strings.HasPrefix(trimmed, "http://meet.google.com/")
}

func boundedJoinEnvInt(primary string, secondary string, fallback int, minValue int, maxValue int) int {
	value := fallback
	for _, key := range []string{primary, secondary} {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		parsed, err := strconv.Atoi(raw)
		if err == nil {
			value = parsed
			break
		}
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func snapshotJoinDiagnostics(sourcePath string, attempt int) string {
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" || attempt <= 0 {
		return ""
	}
	ext := filepath.Ext(sourcePath)
	stem := strings.TrimSuffix(sourcePath, ext)
	stem = strings.TrimSuffix(stem, "-diagnostics")
	targetPath := fmt.Sprintf("%s-admission-attempt-%d-diagnostics%s", stem, attempt, ext)
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return ""
	}
	if err := os.WriteFile(targetPath, data, 0o644); err != nil {
		return ""
	}
	return targetPath
}

func deepMergeMap(base map[string]any, override map[string]any) map[string]any {
	merged := cloneMap(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range override {
		if baseChild, ok := merged[key].(map[string]any); ok {
			if overrideChild, ok := value.(map[string]any); ok {
				merged[key] = deepMergeMap(baseChild, overrideChild)
				continue
			}
		}
		merged[key] = value
	}
	return merged
}

func (s *Service) prewarmAppControlForJoin(session SessionRecord, input JoinGoogleMeetRequest, shouldPrewarm bool) {
	if s == nil || !shouldPrewarm {
		return
	}
	started := s.prewarmAppControlForJoinID(session.ID, input, true, "meeting_join")
	if started {
		s.keepAppControlWarmForJoin(session, input)
	}
}

func (s *Service) prewarmAppControlForJoinID(sessionID string, input JoinGoogleMeetRequest, shouldPrewarm bool, reason string) bool {
	if s == nil || !shouldPrewarm {
		return false
	}
	prewarmer, ok := s.appControlBackend.(AppControlPrewarmBackend)
	if !ok || prewarmer == nil {
		return false
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false
	}
	reason = strings.TrimSpace(firstNonEmpty(reason, "meeting_join"))
	target := appControlPrewarmTargetFromJoin(input)
	s.GoBackground(func(ctx context.Context) {
		prewarmCtx, cancel := context.WithTimeout(ctx, defaultKWWKAppControlPrewarmTimeout)
		defer cancel()
		result := prewarmer.PrewarmAppControl(prewarmCtx, AppControlPrewarmRequest{
			SessionID: sessionID,
			Reason:    reason,
			Target:    target,
			Timeout:   defaultKWWKAppControlPrewarmTimeout,
		})
		s.recordAppControlPrewarmResult(ctx, sessionID, result)
	})
	return true
}

func (s *Service) keepAppControlWarmForJoin(session SessionRecord, input JoinGoogleMeetRequest) {
	if s == nil {
		return
	}
	prewarmer, ok := s.appControlBackend.(AppControlPrewarmBackend)
	if !ok || prewarmer == nil {
		return
	}
	sessionID := strings.TrimSpace(session.ID)
	if sessionID == "" {
		return
	}
	target := appControlPrewarmTargetFromJoin(input)
	if shouldKeepAppControlWarmForJoin(input) {
		s.startAppControlPrewarmKeepalive(sessionID, prewarmer, target)
	}
}

func (s *Service) recordAppControlPrewarmResult(ctx context.Context, sessionID string, result AppControlPrewarmResult) {
	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		s.logger.Warn("load session for app-control prewarm metadata failed", "session_id", sessionID, "error", err)
		return
	}
	if session == nil {
		return
	}
	metadata := cloneMap(session.Metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["kwwk_cu_prewarm"] = result.Map()
	if _, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           session.Status,
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          session.EndedAt,
		Metadata:         metadata,
	}); err != nil {
		s.logger.Warn("persist app-control prewarm metadata failed", "session_id", sessionID, "error", err)
	}
}

const defaultAppControlPrewarmKeepaliveInterval = 30 * time.Second

func appControlPrewarmTargetFromJoin(input JoinGoogleMeetRequest) AppControlTarget {
	screenShareTitle := strings.TrimSpace(input.ScreenShareTitle)
	return AppControlTarget{
		ApplicationName: screenShareTitle,
		WindowTitle:     screenShareTitle,
	}
}

func shouldKeepAppControlWarmForJoin(input JoinGoogleMeetRequest) bool {
	return input.InstallRealtimeBridge || input.AutoConnectRealtime
}

func (s *Service) startAppControlPrewarmKeepalive(sessionID string, prewarmer AppControlPrewarmBackend, target AppControlTarget) {
	if s == nil || prewarmer == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || !s.registerAppControlPrewarmKeepalive(sessionID) {
		return
	}
	interval := s.appControlPrewarmKeepaliveInterval
	if interval <= 0 {
		interval = defaultAppControlPrewarmKeepaliveInterval
	}
	s.GoBackground(func(ctx context.Context) {
		defer s.unregisterAppControlPrewarmKeepalive(sessionID)
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			if !s.appControlPrewarmKeepaliveSessionActive(ctx, sessionID) {
				return
			}
			prewarmCtx, cancel := context.WithTimeout(ctx, defaultKWWKAppControlPrewarmTimeout)
			result := prewarmer.PrewarmAppControl(prewarmCtx, AppControlPrewarmRequest{
				SessionID: sessionID,
				Reason:    "meeting_keepalive",
				Target:    target,
				Timeout:   defaultKWWKAppControlPrewarmTimeout,
			})
			cancel()
			s.recordAppControlKeepaliveResult(ctx, sessionID, result)
			timer.Reset(interval)
		}
	})
}

func (s *Service) registerAppControlPrewarmKeepalive(sessionID string) bool {
	s.appControlPrewarmMu.Lock()
	defer s.appControlPrewarmMu.Unlock()
	if s.appControlPrewarmKeepalives == nil {
		s.appControlPrewarmKeepalives = map[string]struct{}{}
	}
	if _, exists := s.appControlPrewarmKeepalives[sessionID]; exists {
		return false
	}
	s.appControlPrewarmKeepalives[sessionID] = struct{}{}
	return true
}

func (s *Service) unregisterAppControlPrewarmKeepalive(sessionID string) {
	s.appControlPrewarmMu.Lock()
	defer s.appControlPrewarmMu.Unlock()
	delete(s.appControlPrewarmKeepalives, sessionID)
}

func (s *Service) appControlPrewarmKeepaliveSessionActive(ctx context.Context, sessionID string) bool {
	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		s.logger.Warn("load session for app-control keepalive failed", "session_id", sessionID, "error", err)
		return false
	}
	return session != nil && !isTerminalSessionStatus(session.Status)
}

func (s *Service) recordAppControlKeepaliveResult(ctx context.Context, sessionID string, result AppControlPrewarmResult) {
	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		s.logger.Warn("load session for app-control keepalive metadata failed", "session_id", sessionID, "error", err)
		return
	}
	if session == nil || isTerminalSessionStatus(session.Status) {
		return
	}
	metadata := cloneMap(session.Metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	resultMap := result.Map()
	resultMap["reason"] = "meeting_keepalive"
	count := 1
	if previous, ok := metadata["kwwk_cu_keepalive"].(map[string]any); ok {
		count = intFromAny(previous["count"]) + 1
	}
	resultMap["count"] = count
	metadata["kwwk_cu_keepalive"] = resultMap
	if _, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           session.Status,
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          session.EndedAt,
		Metadata:         metadata,
	}); err != nil {
		s.logger.Warn("persist app-control keepalive metadata failed", "session_id", sessionID, "error", err)
	}
}

const replaceExistingJoinReason = "replace_existing_meeting_url"

func (s *Service) stopOverlappingJoinSessions(ctx context.Context, meetingURL string, nextSessionID string) error {
	normalizedURL := normalizeJoinMeetingURL(meetingURL)
	if normalizedURL == "" {
		return nil
	}
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		if isTerminalSessionStatus(session.Status) || normalizeJoinMeetingURL(session.MeetingURL) != normalizedURL {
			continue
		}
		if err := s.stopOverlappingJoinSession(ctx, session, nextSessionID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) stopOverlappingJoinSession(ctx context.Context, session SessionRecord, nextSessionID string) error {
	stop, err := s.meetRunner.StopSession(ctx, meetrunner.StopSessionInput{
		SessionID: session.ID,
		Reason:    replaceExistingJoinReason,
	})
	if err != nil && !runnerSessionUnavailable(err) {
		return fmt.Errorf("stop overlapping meeting session %s: %w", session.ID, err)
	}

	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["stop_reason"] = replaceExistingJoinReason
	if strings.TrimSpace(nextSessionID) != "" {
		metadata["replaced_by_session_id"] = strings.TrimSpace(nextSessionID)
	}
	if err != nil {
		metadata["stop_error"] = err.Error()
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	status := joinSessionStatusString(joinSessionStatusStopped)
	endedAt := now
	if err != nil {
		status = joinSessionStatusString(joinSessionStatusStale)
	} else {
		status = strings.TrimSpace(firstNonEmpty(stop.Session.Status, status))
		endedAt = strings.TrimSpace(firstNonEmpty(stop.StoppedAt, endedAt))
	}
	_, updateErr := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           status,
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          endedAt,
		Metadata:         metadata,
	})
	if updateErr != nil {
		return updateErr
	}
	return nil
}

func normalizeJoinMeetingURL(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	beforeQuery, _, _ := strings.Cut(trimmed, "?")
	return strings.TrimRight(beforeQuery, "/")
}

func normalizeRealtimeRuntimePlacementForJoin(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "_", "-")
}

func validateJoinRealtimeRuntimePlacement(value string) error {
	switch normalizeRealtimeRuntimePlacementForJoin(value) {
	case "", "sidecar":
		return nil
	case "inline":
		return InvalidRealtimeRuntimePlacementError{
			Reason: "inline Realtime SDK on Meet has been removed; use realtime_runtime_placement=sidecar",
		}
	default:
		return InvalidRealtimeRuntimePlacementError{
			Reason: fmt.Sprintf("realtime_runtime_placement must be sidecar; got %q", value),
		}
	}
}

func defaultJoinArtifactsDir(rootDir string, sessionID string) string {
	dir := filepath.Join(strings.TrimSpace(rootDir), "runner-"+strings.TrimSpace(sessionID))
	if absolute, err := filepath.Abs(dir); err == nil {
		return absolute
	}
	return dir
}

func (s *Service) JoinStatus(ctx context.Context, sessionID string) (JoinStatusResponse, error) {
	runner, err := s.meetRunner.Ping(ctx)
	if err != nil {
		return JoinStatusResponse{}, err
	}
	summary, err := s.SessionSummary(ctx)
	if err != nil {
		return JoinStatusResponse{}, err
	}

	active, err := s.resolveJoinSession(ctx, sessionID)
	if err != nil {
		return JoinStatusResponse{}, err
	}
	var runtime *meetrunner.StatusSessionResult
	if active != nil && !isTerminalSessionStatus(active.Status) {
		status, err := s.meetRunner.StatusSession(ctx, meetrunner.StatusSessionInput{SessionID: active.ID})
		if err == nil {
			runtime = &status
			if refreshed := s.sessionFromRuntimeStatus(ctx, *active, status); refreshed != nil {
				active = refreshed
			}
		} else if runnerSessionUnavailable(err) {
			if stale := s.finalizeStaleJoin(ctx, *active, err); stale != nil {
				active = stale
			}
		} else {
			s.logger.Warn("meet-runner status failed", "session_id", active.ID, "error", err)
		}
	}

	return JoinStatusResponse{
		OK:        true,
		Runner:    runner,
		Active:    active,
		Sessions:  summary,
		Available: runner.OK,
		Runtime:   runtime,
	}, nil
}

func (s *Service) StopJoin(ctx context.Context, input StopJoinRequest) (StopJoinResponse, error) {
	session, err := s.resolveJoinSession(ctx, input.SessionID)
	if err != nil {
		return StopJoinResponse{}, err
	}
	if session == nil {
		return StopJoinResponse{}, fmt.Errorf("meeting session not found")
	}

	stop, err := s.meetRunner.StopSession(ctx, meetrunner.StopSessionInput{
		SessionID: session.ID,
		Reason:    strings.TrimSpace(input.Reason),
	})
	if err != nil {
		return StopJoinResponse{}, err
	}

	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["stop_reason"] = strings.TrimSpace(input.Reason)
	saved, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:         session.ID,
		Status:     strings.TrimSpace(firstNonEmpty(stop.Session.Status, joinSessionStatusString(joinSessionStatusStopped))),
		EndedAt:    strings.TrimSpace(firstNonEmpty(stop.StoppedAt, time.Now().UTC().Format(time.RFC3339Nano))),
		Title:      session.Title,
		MeetingID:  session.MeetingID,
		MeetingURL: session.MeetingURL,
		Metadata:   metadata,
	})
	if err != nil {
		return StopJoinResponse{}, err
	}

	postMeeting, postMeetingWarning := s.finalizeStoppedJoin(context.WithoutCancel(ctx), saved, stop, fixtureCaptionsFromStopRequest(input))
	return StopJoinResponse{
		OK:                 stop.OK,
		Stopped:            true,
		Session:            saved,
		Runner:             stop,
		PostMeeting:        postMeeting,
		PostMeetingWarning: postMeetingWarning,
	}, nil
}

func (s *Service) sessionFromRuntimeStatus(ctx context.Context, session SessionRecord, status meetrunner.StatusSessionResult) *SessionRecord {
	runtimeStatus := runtimeMeetPageStatus(status.Active)
	if runtimeStatus == "" {
		return nil
	}
	if runtimeStatus == joinSessionStatusString(joinSessionStatusStale) {
		return s.finalizeStaleJoin(ctx, session, errMeetRunnerPageClosed)
	}
	if runtimeStatus == session.Status {
		metadata := cloneMap(session.Metadata)
		if len(metadata) == 0 {
			metadata = map[string]any{}
		}
		metadata["runtime_status"] = status
		session.Metadata = metadata
		return &session
	}
	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["runtime_status"] = status
	updated, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           runtimeStatus,
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          session.EndedAt,
		Metadata:         metadata,
	})
	if err != nil {
		s.logger.Warn("persist runtime join status failed", "session_id", session.ID, "error", err)
		return nil
	}
	if isTerminalSessionStatus(runtimeStatus) {
		s.stopRuntimeTerminalJoin(ctx, session.ID, runtimeStatus)
	}
	return &updated
}

func (s *Service) stopRuntimeTerminalJoin(ctx context.Context, sessionID string, runtimeStatus string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	reason := "runtime_" + strings.TrimSpace(runtimeStatus)
	if strings.TrimSpace(runtimeStatus) == "" {
		reason = "runtime_terminal"
	}
	if _, err := s.meetRunner.StopSession(context.WithoutCancel(ctx), meetrunner.StopSessionInput{
		SessionID: sessionID,
		Reason:    reason,
	}); err != nil && !runnerSessionUnavailable(err) {
		s.logger.Warn("stop terminal runtime join failed", "session_id", sessionID, "status", runtimeStatus, "error", err)
	}
}

func (s *Service) markJoinSessionStale(ctx context.Context, session SessionRecord, cause error) *SessionRecord {
	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["stale_reason"] = runnerUnavailableReason(cause)
	if cause != nil {
		metadata["runtime_status_error"] = cause.Error()
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	metadata["stale_at"] = now
	updated, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           joinSessionStatusString(joinSessionStatusStale),
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          firstNonEmpty(session.EndedAt, now),
		Metadata:         metadata,
	})
	if err != nil {
		s.logger.Warn("persist stale join status failed", "session_id", session.ID, "error", err)
		return nil
	}
	return &updated
}

func runnerSessionMissing(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "meet-runner session") && strings.Contains(msg, "not found")
}

func runnerSessionUnavailable(err error) bool {
	if err == nil {
		return false
	}
	if runnerSessionMissing(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, marker := range []string{
		"file already closed",
		"broken pipe",
		"use of closed network connection",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

var errMeetRunnerPageClosed = errors.New("meet-runner page closed")

func runnerRuntimePageClosed(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, marker := range []string{
		"target page, context or browser has been closed",
		"target page has been closed",
		"context has been closed",
		"browser has been closed",
		"meet-runner page closed",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func runnerUnavailableReason(err error) string {
	if runnerSessionMissing(err) {
		return "meet_runner_session_missing"
	}
	if runnerRuntimePageClosed(err) {
		return "meet_runner_page_closed"
	}
	return "meet_runner_session_unavailable"
}

func runtimeMeetPageStatus(active any) string {
	fields := map[string]any{}
	raw, err := json.Marshal(active)
	if err != nil || len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return ""
	}
	meetPage, _ := fields["meetPage"].(map[string]any)
	if runtimeMeetPageUnavailable(meetPage) {
		return joinSessionStatusString(joinSessionStatusStale)
	}
	if runtimeRemovedFromMeeting(meetPage) {
		return joinSessionStatusString(joinSessionStatusRemoved)
	}
	if runtimeJoinedEvidence(fields, meetPage, runtimeParticipantCount(meetPage)) {
		return joinSessionStatusString(joinSessionStatusJoined)
	}
	if boolField(meetPage, "waitingForAdmit") {
		return joinSessionStatusString(joinSessionStatusWaiting)
	}
	if boolField(meetPage, "cannotJoin") {
		return joinSessionStatusString(joinSessionStatusFailed)
	}
	return ""
}

func runtimeMeetPageUnavailable(meetPage map[string]any) bool {
	if len(meetPage) == 0 {
		return false
	}
	okValue, hasOK := meetPage["ok"].(bool)
	if !hasOK || okValue {
		return false
	}
	return runnerRuntimePageClosed(errors.New(stringFromMap(meetPage, "error")))
}

func runtimeRemovedFromMeeting(meetPage map[string]any) bool {
	if len(meetPage) == 0 {
		return false
	}
	if boolField(meetPage, "inMeeting") ||
		boolField(meetPage, "waitingForAdmit") ||
		boolField(meetPage, "preJoin") ||
		boolField(meetPage, "signIn") ||
		boolField(meetPage, "cannotJoin") {
		return false
	}
	url := strings.ToLower(stringFromMap(meetPage, "url"))
	if url != "" && !strings.Contains(url, "meet.google.com/") {
		return true
	}
	text := strings.ToLower(stringFromMap(meetPage, "textHead"))
	return strings.Contains(text, "left the meeting") ||
		strings.Contains(text, "return to home screen") ||
		strings.Contains(text, "you've been removed") ||
		strings.Contains(text, "you have been removed")
}

func boolField(values map[string]any, key string) bool {
	if len(values) == 0 {
		return false
	}
	value, _ := values[key].(bool)
	return value
}

func (s *Service) resolveJoinSession(ctx context.Context, sessionID string) (*SessionRecord, error) {
	trimmedID := strings.TrimSpace(sessionID)
	if trimmedID != "" {
		return s.GetSession(ctx, trimmedID)
	}

	sessions, err := s.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	for _, session := range sessions {
		if !isTerminalSessionStatus(session.Status) {
			return &session, nil
		}
	}
	return nil, nil
}

func isTerminalSessionStatus(status string) bool {
	return isTerminalJoinSessionStatus(status)
}

func timestampIfStarted(started bool) string {
	if !started {
		return ""
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func formatOptionalFloat(value float64) string {
	if value == 0 {
		return ""
	}
	return fmt.Sprintf("%g", value)
}
