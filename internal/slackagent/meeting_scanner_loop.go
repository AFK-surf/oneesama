package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	meetingScannerDefaultEventWindow = time.Hour
	meetingScannerRequestTimeout     = 10 * time.Second
	meetingScannerMaxResponseBytes   = 1 << 20
	meetingScannerDedupePrefix       = "meeting_calendar:"
)

type meetingScannerConfig struct {
	Enabled         bool
	Interval        time.Duration
	ApprovalChannel string
	CalendarID      string
	AccessToken     string
	RefreshToken    string
	ClientID        string
	ClientSecret    string
	APIBaseURL      string
	TokenURL        string
}

type SlackMeetingScannerStatus struct {
	Enabled             bool   `json:"enabled"`
	Running             bool   `json:"running"`
	Configured          bool   `json:"configured"`
	IntervalSeconds     int64  `json:"interval_seconds"`
	ApprovalChannel     string `json:"approval_channel,omitempty"`
	CalendarID          string `json:"calendar_id,omitempty"`
	LastTickAt          string `json:"last_tick_at,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	LastScanned         int    `json:"last_scanned"`
	LastPosted          int    `json:"last_posted"`
	LastSkipped         int    `json:"last_skipped"`
	TicksLastWindow     int    `json:"ticks_last_window"`
	DisabledReason      string `json:"disabled_reason,omitempty"`
	CredentialMode      string `json:"credential_mode,omitempty"`
	LookaheadSeconds    int64  `json:"lookahead_seconds"`
	ExternalToolExposed bool   `json:"external_tool_exposed"`
}

type meetingScannerEvent struct {
	ID        string
	Title     string
	StartAt   time.Time
	EndAt     time.Time
	EventURL  string
	MeetURL   string
	Attendees []string
}

type meetingScannerTickResult struct {
	Scanned int
	Posted  int
	Skipped int
}

func newMeetingScannerConfig(cfg appconfig.SlackMeetingScannerConfig) meetingScannerConfig {
	interval := cfg.Interval
	if interval <= 0 {
		interval = time.Minute
	}
	return meetingScannerConfig{
		Enabled:         cfg.Enabled,
		Interval:        interval,
		ApprovalChannel: strings.TrimSpace(cfg.ApprovalChannel),
		CalendarID:      firstNonEmpty(strings.TrimSpace(cfg.CalendarID), "primary"),
		AccessToken:     strings.TrimSpace(cfg.AccessToken),
		RefreshToken:    strings.TrimSpace(cfg.RefreshToken),
		ClientID:        strings.TrimSpace(cfg.ClientID),
		ClientSecret:    strings.TrimSpace(cfg.ClientSecret),
		APIBaseURL:      strings.TrimRight(firstNonEmpty(strings.TrimSpace(cfg.APIBaseURL), "https://www.googleapis.com/calendar/v3"), "/"),
		TokenURL:        firstNonEmpty(strings.TrimSpace(cfg.TokenURL), "https://oauth2.googleapis.com/token"),
	}
}

func (c meetingScannerConfig) configured() bool {
	return c.Enabled &&
		strings.TrimSpace(c.ApprovalChannel) != "" &&
		strings.TrimSpace(c.CalendarID) != "" &&
		(strings.TrimSpace(c.AccessToken) != "" ||
			(strings.TrimSpace(c.RefreshToken) != "" && strings.TrimSpace(c.ClientID) != "" && strings.TrimSpace(c.ClientSecret) != ""))
}

func (c meetingScannerConfig) disabledReason() string {
	if !c.Enabled {
		return "disabled"
	}
	if strings.TrimSpace(c.ApprovalChannel) == "" {
		return "missing_approval_channel"
	}
	if strings.TrimSpace(c.CalendarID) == "" {
		return "missing_calendar_id"
	}
	if strings.TrimSpace(c.AccessToken) == "" &&
		(strings.TrimSpace(c.RefreshToken) == "" || strings.TrimSpace(c.ClientID) == "" || strings.TrimSpace(c.ClientSecret) == "") {
		return "missing_google_calendar_credentials"
	}
	return ""
}

func (c meetingScannerConfig) credentialMode() string {
	if strings.TrimSpace(c.AccessToken) != "" {
		return "access_token"
	}
	if strings.TrimSpace(c.RefreshToken) != "" && strings.TrimSpace(c.ClientID) != "" && strings.TrimSpace(c.ClientSecret) != "" {
		return "refresh_token"
	}
	return ""
}

func (s *Service) startMeetingApprovalScanner() {
	if s == nil || !s.meetingScanner.configured() {
		return
	}
	s.meetingScannerMu.Lock()
	defer s.meetingScannerMu.Unlock()
	if s.meetingScannerCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.meetingScannerCancel = cancel
	go s.runMeetingApprovalScanner(ctx, s.meetingScanner.Interval)
}

func (s *Service) stopMeetingApprovalScanner() {
	if s == nil {
		return
	}
	s.meetingScannerMu.Lock()
	cancel := s.meetingScannerCancel
	s.meetingScannerCancel = nil
	s.meetingScannerMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) runMeetingApprovalScanner(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			result, err := s.runMeetingApprovalScannerOnce(ctx)
			s.recordMeetingScannerTick(timeNow().UTC(), result, err)
			if err != nil {
				s.logger.Warn("slack meeting approval scanner failed", "error", err)
			} else if result.Posted > 0 || result.Skipped > 0 {
				s.logger.Info("slack meeting approval scanner complete", "scanned", result.Scanned, "posted", result.Posted, "skipped", result.Skipped)
			}
			timer.Reset(interval)
		}
	}
}

func (s *Service) runMeetingApprovalScannerOnce(ctx context.Context) (meetingScannerTickResult, error) {
	result := meetingScannerTickResult{}
	if s == nil {
		return result, nil
	}
	if !s.meetingScanner.configured() {
		return result, errors.New(s.meetingScanner.disabledReason())
	}
	now := timeNow().UTC()
	events, err := s.fetchMeetingScannerEvents(ctx, now, now.Add(meetingScannerLookahead(s.meetingScanner.Interval)))
	if err != nil {
		return result, err
	}
	result.Scanned = len(events)
	for _, event := range events {
		if !shouldSuggestMeetingApprovalAt(now, event.StartAt, s.meetingScanner.Interval) {
			result.Skipped++
			continue
		}
		posted, err := s.suggestCalendarMeetingApproval(ctx, event)
		if err != nil {
			return result, err
		}
		if posted {
			result.Posted++
		} else {
			result.Skipped++
		}
	}
	return result, nil
}

func (s *Service) fetchMeetingScannerEvents(ctx context.Context, min, max time.Time) ([]meetingScannerEvent, error) {
	token, err := s.meetingScannerAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	escapedID := url.PathEscape(firstNonEmpty(s.meetingScanner.CalendarID, "primary"))
	endpoint := strings.TrimRight(s.meetingScanner.APIBaseURL, "/") + "/calendars/" + escapedID + "/events"
	query := url.Values{}
	query.Set("singleEvents", "true")
	query.Set("orderBy", "startTime")
	query.Set("timeMin", min.UTC().Format(time.RFC3339))
	query.Set("timeMax", max.UTC().Format(time.RFC3339))
	query.Set("maxResults", "20")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := httputil.NewHTTPClient(meetingScannerRequestTimeout).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, meetingScannerMaxResponseBytes))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("google calendar events returned %d: %s", response.StatusCode, truncateSlackContextText(string(body), 200))
	}
	var payload googleCalendarEventsResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	events := make([]meetingScannerEvent, 0, len(payload.Items))
	for _, item := range payload.Items {
		event := meetingScannerEventFromGoogle(item)
		if event.ID == "" || event.MeetURL == "" || event.StartAt.IsZero() {
			continue
		}
		events = append(events, event)
	}
	sort.Slice(events, func(i, j int) bool { return events[i].StartAt.Before(events[j].StartAt) })
	return events, nil
}

func (s *Service) meetingScannerAccessToken(ctx context.Context) (string, error) {
	if token := strings.TrimSpace(s.meetingScanner.AccessToken); token != "" {
		return token, nil
	}
	if strings.TrimSpace(s.meetingScanner.RefreshToken) == "" ||
		strings.TrimSpace(s.meetingScanner.ClientID) == "" ||
		strings.TrimSpace(s.meetingScanner.ClientSecret) == "" {
		return "", errors.New("missing_google_calendar_credentials")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", s.meetingScanner.RefreshToken)
	form.Set("client_id", s.meetingScanner.ClientID)
	form.Set("client_secret", s.meetingScanner.ClientSecret)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.meetingScanner.TokenURL, bytes.NewBufferString(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := httputil.NewHTTPClient(meetingScannerRequestTimeout).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, meetingScannerMaxResponseBytes))
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("google oauth refresh returned %d: %s", response.StatusCode, truncateSlackContextText(string(body), 200))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.AccessToken) == "" {
		return "", errors.New("google oauth refresh returned empty access_token")
	}
	return strings.TrimSpace(payload.AccessToken), nil
}

func (s *Service) suggestCalendarMeetingApproval(ctx context.Context, event meetingScannerEvent) (bool, error) {
	channelID, err := s.resolveMeetingApprovalChannel(ctx)
	if err != nil {
		return false, err
	}
	brief := meetingApprovalBrief{
		Title:    event.Title,
		StartAt:  event.StartAt.Format(time.RFC3339),
		EventURL: event.EventURL,
		MeetURL:  event.MeetURL,
	}
	dedupeThreadTS := meetingScannerDedupeThreadTS(event.ID)
	if s.threadCases != nil && s.threadCases.IsActive(ctx, channelID, dedupeThreadTS) {
		return false, nil
	}
	anchor := s.PostMessage(ctx, PostMessageInput{
		Channel:  channelID,
		Text:     formatMeetingApprovalAnchorText(brief),
		DedupKey: "slack-meeting-approval-anchor:" + strings.TrimSpace(event.ID),
	})
	if !anchor.OK {
		return false, fmt.Errorf("post meeting approval anchor: %s", firstNonEmpty(anchor.Error, anchor.Detail, "unknown_error"))
	}
	threadTS := firstNonEmpty(anchor.TS, anchor.ThreadTS, formatSlackTimestamp(timeNow().UTC()))
	params := map[string]any{
		"meet_url":   event.MeetURL,
		"event_id":   event.ID,
		"event_url":  event.EventURL,
		"title":      event.Title,
		"start_at":   event.StartAt.Format(time.RFC3339),
		"end_at":     event.EndAt.Format(time.RFC3339),
		"attendees":  event.Attendees,
		"source":     "calendar_meeting_scanner",
		"summary":    formatMeetingApprovalSummary(brief),
		"anchorText": formatMeetingApprovalAnchorText(brief),
	}
	response := s.executeSuggestActionTool(ctx, slackSuggestRoleAssistant, map[string]any{
		"channel":     channelID,
		"thread_ts":   threadTS,
		"action_type": slackActionTypeJoinMeeting,
		"title":       "Join meeting: " + event.Title,
		"summary":     formatMeetingApprovalSummary(brief),
		"params":      params,
		"reason":      "Upcoming Google Calendar meeting is inside the approval window.",
		"confidence":  1,
	})
	if !response.OK {
		return false, fmt.Errorf("suggest meeting approval: %s", firstNonEmpty(response.Error, response.Text, "unknown_error"))
	}
	if s.threadCases != nil {
		_, _ = s.threadCases.UpsertThreadCase(ctx, SlackThreadCase{
			ChannelID: channelID,
			ThreadTS:  dedupeThreadTS,
			Owner:     SlackThreadCaseOwnerMeeting,
			Status:    SlackThreadCaseStatusActive,
			Source:    "calendar_meeting_scanner",
		})
		if strings.TrimSpace(threadTS) != "" && threadTS != dedupeThreadTS {
			_, _ = s.threadCases.UpsertThreadCase(ctx, SlackThreadCase{
				ChannelID: channelID,
				ThreadTS:  threadTS,
				Owner:     SlackThreadCaseOwnerMeeting,
				Status:    SlackThreadCaseStatusActive,
				Source:    "calendar_meeting_scanner",
			})
		}
	}
	return true, nil
}

func (s *Service) resolveMeetingApprovalChannel(ctx context.Context) (string, error) {
	configured := strings.TrimSpace(s.meetingScanner.ApprovalChannel)
	if strings.HasPrefix(configured, "C") || strings.HasPrefix(configured, "G") || strings.HasPrefix(configured, "D") {
		return configured, nil
	}
	if s.workspaceState == nil {
		return "", fmt.Errorf("meeting approval channel %q requires workspace state", configured)
	}
	channels, err := s.workspaceState.ListChannels(ctx)
	if err != nil {
		return "", err
	}
	approvalChannels := make([]meetingApprovalChannel, 0, len(channels))
	for _, channel := range channels {
		approvalChannels = append(approvalChannels, meetingApprovalChannel{ID: channel.ID, Name: channel.Name})
	}
	return resolveMeetingApprovalChannelID(configured, approvalChannels)
}

func (s *Service) recordMeetingScannerTick(now time.Time, result meetingScannerTickResult, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	cutoff := now.Add(-6 * time.Hour)
	errorText := ""
	if err != nil {
		errorText = err.Error()
	}
	s.meetingScannerMu.Lock()
	defer s.meetingScannerMu.Unlock()
	s.meetingScannerLastTickAt = now.UTC()
	s.meetingScannerLastError = errorText
	s.meetingScannerLastScanned = result.Scanned
	s.meetingScannerLastPosted = result.Posted
	s.meetingScannerLastSkipped = result.Skipped
	s.meetingScannerTicks = append(s.meetingScannerTicks, now.UTC())
	kept := s.meetingScannerTicks[:0]
	for _, tick := range s.meetingScannerTicks {
		if tick.After(cutoff) || tick.Equal(cutoff) {
			kept = append(kept, tick)
		}
	}
	s.meetingScannerTicks = kept
}

func (s *Service) meetingScannerStatus() SlackMeetingScannerStatus {
	status := SlackMeetingScannerStatus{
		Enabled:             s != nil && s.meetingScanner.Enabled,
		Configured:          s != nil && s.meetingScanner.configured(),
		ExternalToolExposed: false,
	}
	if s == nil {
		return status
	}
	status.IntervalSeconds = int64(s.meetingScanner.Interval.Seconds())
	status.ApprovalChannel = s.meetingScanner.ApprovalChannel
	status.CalendarID = s.meetingScanner.CalendarID
	status.DisabledReason = s.meetingScanner.disabledReason()
	status.CredentialMode = s.meetingScanner.credentialMode()
	status.LookaheadSeconds = int64(meetingScannerLookahead(s.meetingScanner.Interval).Seconds())
	s.meetingScannerMu.Lock()
	defer s.meetingScannerMu.Unlock()
	status.Running = s.meetingScannerCancel != nil
	if !s.meetingScannerLastTickAt.IsZero() {
		status.LastTickAt = s.meetingScannerLastTickAt.UTC().Format(time.RFC3339Nano)
	}
	status.LastError = s.meetingScannerLastError
	status.LastScanned = s.meetingScannerLastScanned
	status.LastPosted = s.meetingScannerLastPosted
	status.LastSkipped = s.meetingScannerLastSkipped
	status.TicksLastWindow = len(s.meetingScannerTicks)
	return status
}

func meetingScannerDedupeThreadTS(eventID string) string {
	return meetingScannerDedupePrefix + strings.TrimSpace(eventID)
}

type googleCalendarEventsResponse struct {
	Items []googleCalendarEvent `json:"items"`
}

type googleCalendarEvent struct {
	ID             string                   `json:"id"`
	Summary        string                   `json:"summary"`
	HTMLLink       string                   `json:"htmlLink"`
	HangoutLink    string                   `json:"hangoutLink"`
	Location       string                   `json:"location"`
	Description    string                   `json:"description"`
	Start          googleCalendarEventTime  `json:"start"`
	End            googleCalendarEventTime  `json:"end"`
	Attendees      []googleCalendarAttendee `json:"attendees"`
	ConferenceData struct {
		EntryPoints []struct {
			EntryPointType string `json:"entryPointType"`
			URI            string `json:"uri"`
		} `json:"entryPoints"`
	} `json:"conferenceData"`
}

type googleCalendarEventTime struct {
	DateTime string `json:"dateTime"`
	Date     string `json:"date"`
}

type googleCalendarAttendee struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Self        bool   `json:"self"`
	Optional    bool   `json:"optional"`
	Response    string `json:"responseStatus"`
}

func meetingScannerEventFromGoogle(item googleCalendarEvent) meetingScannerEvent {
	startAt := parseGoogleCalendarTime(item.Start)
	endAt := parseGoogleCalendarTime(item.End)
	meetURL := firstNonEmpty(
		findSlackMeetURL(item.HangoutLink),
		findSlackMeetURL(item.Location),
		findSlackMeetURL(item.Description),
	)
	for _, entry := range item.ConferenceData.EntryPoints {
		if meetURL != "" {
			break
		}
		if strings.EqualFold(entry.EntryPointType, "video") {
			meetURL = findSlackMeetURL(entry.URI)
		}
	}
	attendees := make([]string, 0, len(item.Attendees))
	for _, attendee := range item.Attendees {
		name := firstNonEmpty(attendee.DisplayName, attendee.Email)
		if name == "" {
			continue
		}
		if attendee.Email != "" && attendee.DisplayName != "" {
			name = attendee.DisplayName + " <" + attendee.Email + ">"
		}
		attendees = append(attendees, name)
	}
	return meetingScannerEvent{
		ID:        strings.TrimSpace(item.ID),
		Title:     firstNonEmpty(strings.TrimSpace(item.Summary), "Untitled meeting"),
		StartAt:   startAt,
		EndAt:     endAt,
		EventURL:  strings.TrimSpace(item.HTMLLink),
		MeetURL:   meetURL,
		Attendees: attendees,
	}
}

func parseGoogleCalendarTime(value googleCalendarEventTime) time.Time {
	if strings.TrimSpace(value.DateTime) != "" {
		if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value.DateTime)); err == nil {
			return parsed.UTC()
		}
	}
	if strings.TrimSpace(value.Date) != "" {
		if parsed, err := time.Parse("2006-01-02", strings.TrimSpace(value.Date)); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}
