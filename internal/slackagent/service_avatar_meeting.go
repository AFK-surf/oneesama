package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/AFK-surf/oneesama/internal/internalauth"
)

const (
	meetingAgentResponseLimit  = 1 << 20
	meetingAgentDefaultTimeout = 10 * time.Second
	meetingAgentJoinTimeout    = 5 * time.Minute
)

type meetingAgentJoinRequest struct {
	SessionID                  string `json:"session_id,omitempty"`
	MeetingURL                 string `json:"meeting_url"`
	DisplayName                string `json:"display_name,omitempty"`
	Title                      string `json:"title,omitempty"`
	DryRun                     bool   `json:"dry_run"`
	CaptureCaptions            bool   `json:"capture_captions,omitempty"`
	CaptionLanguage            string `json:"caption_language,omitempty"`
	RecordMeeting              bool   `json:"record_meeting,omitempty"`
	InstallRealtimeBridge      bool   `json:"install_realtime_bridge,omitempty"`
	InstallWorkerResultBridge  bool   `json:"install_worker_result_bridge,omitempty"`
	RealtimeBridgeMode         string `json:"realtime_bridge_mode,omitempty"`
	AutoConnectRealtime        bool   `json:"auto_connect_realtime,omitempty"`
	SendRealtimeSessionUpdate  bool   `json:"send_realtime_session_update,omitempty"`
	IncludeParticipantAudio    bool   `json:"include_participant_audio,omitempty"`
	ForwardMeetAudioToRealtime bool   `json:"forward_meet_audio_to_realtime,omitempty"`
	RealtimeFallbackToLocalMic bool   `json:"realtime_fallback_to_local_mic,omitempty"`
	SlackChannelID             string `json:"slack_channel_id,omitempty"`
	SlackThreadTS              string `json:"slack_thread_ts,omitempty"`
}

type meetingAgentStopRequest struct {
	SessionID string `json:"session_id,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type meetingAgentSession struct {
	ID         string `json:"id"`
	MeetingID  string `json:"meeting_id,omitempty"`
	MeetingURL string `json:"meeting_url,omitempty"`
	Status     string `json:"status"`
	Title      string `json:"title,omitempty"`
}

type meetingAgentSessionSummary struct {
	Total    int            `json:"total"`
	ByStatus map[string]int `json:"by_status,omitempty"`
}

type meetingAgentJoinResponse struct {
	OK       bool                `json:"ok"`
	Accepted bool                `json:"accepted"`
	Started  bool                `json:"started"`
	Note     string              `json:"note,omitempty"`
	Session  meetingAgentSession `json:"session"`
}

type meetingAgentJoinStatusResponse struct {
	OK        bool                       `json:"ok"`
	Active    *meetingAgentSession       `json:"active,omitempty"`
	Sessions  meetingAgentSessionSummary `json:"sessions"`
	Available bool                       `json:"available"`
}

type meetingAgentStopResponse struct {
	OK                 bool                `json:"ok"`
	Stopped            bool                `json:"stopped"`
	Session            meetingAgentSession `json:"session"`
	PostMeetingWarning string              `json:"post_meeting_warning,omitempty"`
}

func (s *Service) runJoinCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	if !parsed.ValidMeetURL {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Usage error: expected a Google Meet URL.\n\n" + avatarCommandUsage(),
		}
	}
	if s.shouldShowJoinSetupCard(input, parsed) {
		return s.joinSetupResponse(input, parsed)
	}

	result, err := s.postMeetingAgentJoin(ctx, input, parsed)
	if err != nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Join failed: " + err.Error(),
		}
	}

	mode := "dry-run joiner"
	if !parsed.DryRunJoiner {
		mode = "real joiner"
	}
	sessionID := firstNonEmpty(result.Session.ID, parsed.SessionID, "meeting session")
	slackContext := s.rememberSlackCommand(ctx, input, parsed, &result.Session)
	text, blocks := buildMeetingJoinedPost(NormalizedMeetingWebhookPayload{
		Title: firstNonEmpty(result.Session.Title, joinMeetingDisplayTitle(parsed.MeetURL)),
	})
	assistantStatus := s.scheduleAssistantThreadStatus(ctx, AssistantThreadRef{
		ChannelID: input.ChannelID,
		ThreadTS:  input.ThreadTS,
	}, "Recording meeting...", true)
	return AvatarCommandResponse{
		OK:           result.OK,
		ResponseType: "ephemeral",
		Text:         text,
		Blocks:       blocks,
		Metadata: metadataWithSlackContext(slackContext, map[string]any{
			"assistant_status": assistantStatus,
			"join_result": map[string]any{
				"mode":       mode,
				"session_id": sessionID,
			},
			"meeting_agent": result,
		}),
	}
}

func (s *Service) runStatusCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	status := s.Status()
	joinStatus, err := s.getMeetingAgentJoinStatus(ctx, parsed.SessionID)
	slackContext := s.rememberSlackCommand(ctx, input, parsed, nil)
	metadata := metadataWithSlackContext(slackContext, map[string]any{
		"status": status,
	})
	if err != nil {
		metadata["join_status_error"] = err.Error()
		return AvatarCommandResponse{
			OK:           true,
			ResponseType: "ephemeral",
			Text:         fmt.Sprintf("Status: no active session\nActive background tasks: %d", status.AgentRunner.Jobs),
			Metadata:     metadata,
		}
	}
	metadata["join_status"] = joinStatus
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Status: %s\nActive background tasks: %d", summarizeMeetingSession(joinStatus.Active), status.AgentRunner.Jobs),
		Metadata:     metadata,
	}
}

func (s *Service) runStopCommand(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	reason := firstNonEmpty(parsed.Reason, "slack_stop:"+firstNonEmpty(input.UserID, input.UserName, "unknown"))
	result, err := s.postMeetingAgentStop(ctx, meetingAgentStopRequest{
		SessionID: parsed.SessionID,
		Reason:    reason,
	})
	if err != nil {
		return AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Stop failed: " + err.Error(),
		}
	}

	target := firstNonEmpty(result.Session.ID, parsed.SessionID, "current meeting joiner")
	slackContext := s.rememberSlackCommand(ctx, input, parsed, &result.Session)
	return AvatarCommandResponse{
		OK:           result.OK,
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Stop requested for %s.", target),
		Metadata: metadataWithSlackContext(slackContext, map[string]any{
			"stop_result": result,
		}),
	}
}

func (s *Service) postMeetingAgentJoin(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand) (meetingAgentJoinResponse, error) {
	request := meetingAgentJoinRequest{
		SessionID:                 parsed.SessionID,
		MeetingURL:                parsed.MeetURL,
		DisplayName:               firstNonEmpty(parsed.BotName, "Onee Sama"),
		Title:                     joinMeetingDisplayTitle(parsed.MeetURL),
		DryRun:                    parsed.DryRunJoiner,
		CaptureCaptions:           !parsed.RealtimeJoin,
		CaptionLanguage:           s.effectiveCaptionLanguage(parsed.CaptionLanguage),
		RecordMeeting:             true,
		InstallRealtimeBridge:     parsed.RealtimeJoin,
		InstallWorkerResultBridge: parsed.RealtimeJoin,
		SlackChannelID:            strings.TrimSpace(input.ChannelID),
		SlackThreadTS:             strings.TrimSpace(input.ThreadTS),
	}
	if parsed.RealtimeJoin {
		request.RealtimeBridgeMode = "webrtc"
		request.AutoConnectRealtime = true
		request.SendRealtimeSessionUpdate = true
		request.IncludeParticipantAudio = true
		request.ForwardMeetAudioToRealtime = true
		request.RealtimeFallbackToLocalMic = true
	}
	var result meetingAgentJoinResponse
	if err := s.postMeetingAgentJSONWithTimeout(ctx, "/join/google-meet", request, &result, meetingAgentJoinTimeout); err != nil {
		return meetingAgentJoinResponse{}, err
	}
	return result, nil
}

func joinMeetingDisplayTitle(meetURL string) string {
	if strings.Contains(strings.ToLower(meetURL), "meet.google.com") {
		return "Google Meet"
	}
	return "Meeting"
}

func (s *Service) getMeetingAgentJoinStatus(ctx context.Context, sessionID string) (meetingAgentJoinStatusResponse, error) {
	path := "/join/status"
	if strings.TrimSpace(sessionID) != "" {
		path += "?session_id=" + url.QueryEscape(strings.TrimSpace(sessionID))
	}
	var result meetingAgentJoinStatusResponse
	if err := s.getMeetingAgentJSON(ctx, path, &result); err != nil {
		return meetingAgentJoinStatusResponse{}, err
	}
	return result, nil
}

func (s *Service) postMeetingAgentStop(ctx context.Context, request meetingAgentStopRequest) (meetingAgentStopResponse, error) {
	var result meetingAgentStopResponse
	if err := s.postMeetingAgentJSON(ctx, "/join/stop", request, &result); err != nil {
		return meetingAgentStopResponse{}, err
	}
	return result, nil
}

func (s *Service) getMeetingAgentJSON(ctx context.Context, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.meetingAgentEndpoint(path), nil)
	if err != nil {
		return fmt.Errorf("build meeting-agent request: %w", err)
	}
	return s.doMeetingAgentJSON(request, target, meetingAgentDefaultTimeout)
}

func (s *Service) postMeetingAgentJSON(ctx context.Context, path string, payload any, target any) error {
	return s.postMeetingAgentJSONWithTimeout(ctx, path, payload, target, meetingAgentDefaultTimeout)
}

func (s *Service) postMeetingAgentJSONWithTimeout(ctx context.Context, path string, payload any, target any, timeout time.Duration) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode meeting-agent payload: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.meetingAgentEndpoint(path), bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build meeting-agent request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	return s.doMeetingAgentJSON(request, target, timeout)
}

func (s *Service) doMeetingAgentJSON(request *http.Request, target any, timeout time.Duration) error {
	if strings.TrimSpace(s.meetingAgentURL) == "" {
		return fmt.Errorf("meeting agent url is not configured")
	}
	if s.internalAuthKey != "" {
		request.Header.Set(internalauth.HeaderName, s.internalAuthKey)
	}

	response, err := httputil.NewHTTPClient(timeoutOrDefault(timeout, meetingAgentDefaultTimeout)).Do(request)
	if err != nil {
		return fmt.Errorf("call meeting-agent %s: %w", request.URL.Path, err)
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, meetingAgentResponseLimit))
	if err != nil {
		return fmt.Errorf("read meeting-agent response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("meeting-agent %s returned %d: %s", request.URL.Path, response.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode meeting-agent response: %w", err)
	}
	return nil
}

func timeoutOrDefault(timeout time.Duration, fallback time.Duration) time.Duration {
	if timeout > 0 {
		return timeout
	}
	return fallback
}

func (s *Service) meetingAgentEndpoint(path string) string {
	baseURL := strings.TrimRight(strings.TrimSpace(s.meetingAgentURL), "/")
	if strings.HasPrefix(path, "/") {
		return baseURL + path
	}
	return baseURL + "/" + path
}

func summarizeMeetingSession(session *meetingAgentSession) string {
	if session == nil {
		return "no active session"
	}
	return strings.TrimSpace(fmt.Sprintf("%s %s %s", session.ID, session.Status, firstNonEmpty(session.MeetingURL, "(no meet url)")))
}
