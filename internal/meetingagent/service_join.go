package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

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
	prepare, err := s.meetRunner.PrepareGoogleMeet(ctx, meetrunner.PrepareGoogleMeetInput{
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
		InstallRealtimeBridge:      input.InstallRealtimeBridge,
		RealtimeBridgeMode:         strings.TrimSpace(input.RealtimeBridgeMode),
		RealtimeAgentRuntime:       firstNonEmpty(strings.TrimSpace(input.RealtimeAgentRuntime), s.openai.RealtimeAgentRuntime),
		RealtimeToolCallbackToken:  s.internalAuthKey,
		AutoConnectRealtime:        input.AutoConnectRealtime,
		SendRealtimeSessionUpdate:  input.SendRealtimeSessionUpdate,
		IncludeParticipantAudio:    input.IncludeParticipantAudio,
		ForwardMeetAudioToRealtime: input.ForwardMeetAudioToRealtime,
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
	})
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}

	session, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:         prepare.Session.ID,
		MeetingID:  strings.TrimSpace(firstNonEmpty(input.MeetingID, prepare.Session.ID)),
		MeetingURL: prepare.Session.MeetingURL,
		Status:     strings.TrimSpace(prepare.Session.Status),
		Title:      strings.TrimSpace(firstNonEmpty(input.Title, prepare.Session.Title)),
		StartedAt:  timestampIfStarted(prepare.Started),
		Metadata: map[string]any{
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
			"auto_connect_realtime":          input.AutoConnectRealtime,
			"send_realtime_session_update":   input.SendRealtimeSessionUpdate,
			"include_participant_audio":      input.IncludeParticipantAudio,
			"forward_meet_audio_to_realtime": input.ForwardMeetAudioToRealtime,
			"slack_channel_id":               strings.TrimSpace(input.SlackChannelID),
			"slack_thread_ts":                strings.TrimSpace(input.SlackThreadTS),
		},
	})
	if err != nil {
		return JoinGoogleMeetResponse{}, err
	}
	if prepare.Started && !input.DryRun {
		go s.monitorJoinSession(context.WithoutCancel(ctx), session.ID)
	}

	return JoinGoogleMeetResponse{
		OK:       prepare.OK,
		Accepted: prepare.Accepted,
		Started:  prepare.Started,
		Note:     prepare.Note,
		Session:  session,
		Plan:     prepare.Plan,
		Runner:   runner,
	}, nil
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
