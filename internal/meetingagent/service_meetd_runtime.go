package meetingagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const meetdStaleMeetingAge = 30 * time.Minute

type MeetdRuntimeTickOptions struct {
	Now          time.Time
	StaleAfter   time.Duration
	DryRunJoiner bool
}

type MeetdRuntimeTickResult struct {
	OK        bool                 `json:"ok"`
	Now       string               `json:"now"`
	Cleaned   []MeetdMeetingRecord `json:"cleaned"`
	Recovered []MeetdMeetingRecord `json:"recovered"`
	Ready     []MeetdRuntimeAction `json:"ready"`
}

type MeetdRuntimeAction struct {
	MeetingID int64  `json:"meeting_id"`
	Action    string `json:"action"`
	Status    string `json:"status,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *Service) StartMeetdRuntime(ctx context.Context) {
	if s.meetdRuntimeDone != nil {
		return
	}
	runtimeCtx, cancel := context.WithCancel(ctx)
	s.meetdRuntimeCancel = cancel
	s.meetdRuntimeDone = make(chan struct{})
	go func() {
		defer close(s.meetdRuntimeDone)
		s.runMeetdRuntime(runtimeCtx)
	}()
}

func (s *Service) runMeetdRuntime(ctx context.Context) {
	s.logger.Info("meetd runtime starting", "watch_interval", s.meetdWatchInterval)
	_, _ = s.TickMeetdRuntime(ctx, MeetdRuntimeTickOptions{Now: time.Now().UTC(), StaleAfter: meetdStaleMeetingAge})
	ticker := time.NewTicker(s.meetdWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.logger.Info("meetd runtime stopped")
			return
		case <-s.meetdWake:
		case <-ticker.C:
		}
		_, _ = s.TickMeetdRuntime(ctx, MeetdRuntimeTickOptions{Now: time.Now().UTC(), StaleAfter: meetdStaleMeetingAge})
	}
}

func (s *Service) wakeMeetdRuntime() {
	select {
	case s.meetdWake <- struct{}{}:
	default:
	}
}

func (s *Service) TickMeetdRuntime(ctx context.Context, opts MeetdRuntimeTickOptions) (MeetdRuntimeTickResult, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	staleAfter := opts.StaleAfter
	if staleAfter <= 0 {
		staleAfter = meetdStaleMeetingAge
	}
	cleaned, err := s.CleanupStaleMeetdMeetings(ctx, staleAfter, now)
	if err != nil {
		return MeetdRuntimeTickResult{}, fmt.Errorf("cleanup stale meetings: %w", err)
	}
	recovered, err := s.recoverMeetdProcessing(ctx)
	if err != nil {
		return MeetdRuntimeTickResult{}, fmt.Errorf("recover processing meetings: %w", err)
	}
	ready, err := s.processReadyMeetdMeetings(ctx, now, opts.DryRunJoiner)
	if err != nil {
		return MeetdRuntimeTickResult{}, err
	}
	return MeetdRuntimeTickResult{
		OK:        true,
		Now:       now.Format(time.RFC3339Nano),
		Cleaned:   cleaned,
		Recovered: recovered,
		Ready:     ready,
	}, nil
}

func (s *Service) recoverMeetdProcessing(ctx context.Context) ([]MeetdMeetingRecord, error) {
	processing, err := s.ListMeetdMeetings(ctx, "processing")
	if err != nil {
		return nil, err
	}
	for _, meeting := range processing {
		go s.ProcessMeetdMeetingEnd(context.WithoutCancel(ctx), meeting, false)
	}
	return processing, nil
}

func (s *Service) processReadyMeetdMeetings(ctx context.Context, now time.Time, dryRunJoiner bool) ([]MeetdRuntimeAction, error) {
	meetings, err := s.ListMeetdMeetings(ctx, "pending")
	if err != nil {
		return nil, fmt.Errorf("list pending meetings: %w", err)
	}
	actions := make([]MeetdRuntimeAction, 0, len(meetings))
	for _, meeting := range meetings {
		if now.Before(meeting.StartTime.Add(-1 * time.Minute)) {
			actions = append(actions, MeetdRuntimeAction{MeetingID: meeting.ID, Action: "not_ready", Status: meeting.Status})
			continue
		}
		if now.After(meeting.StartTime.Add(5 * time.Minute)) {
			cancelled, err := s.UpdateMeetdMeetingState(ctx, meeting.ID, "cancelled", "missed start window", now)
			if err != nil {
				return actions, err
			}
			actions = append(actions, MeetdRuntimeAction{MeetingID: meeting.ID, Action: "cancelled", Status: cancelled.Status})
			continue
		}
		claimed, err := s.ClaimMeetdMeetingForJoin(ctx, meeting.ID)
		if err != nil {
			actions = append(actions, MeetdRuntimeAction{MeetingID: meeting.ID, Action: "claim_failed", Error: err.Error()})
			continue
		}
		action := "join_claimed"
		if dryRunJoiner {
			action = "join_planned"
		}
		actions = append(actions, MeetdRuntimeAction{MeetingID: meeting.ID, Action: action, Status: claimed.Status, SessionID: claimed.SessionID})
		if !dryRunJoiner {
			go s.joinMeetdMeeting(context.WithoutCancel(ctx), *claimed)
		}
	}
	return actions, nil
}

func (s *Service) joinMeetdMeeting(ctx context.Context, meeting MeetdMeetingRecord) {
	artifactsDir := filepath.Join(s.pipeline.RootDir(), fmt.Sprintf("meeting-%d", meeting.ID))
	if err := os.MkdirAll(artifactsDir, 0o755); err != nil {
		_, _ = s.UpdateMeetdMeetingState(ctx, meeting.ID, "failed", fmt.Sprintf("create artifacts dir: %v", err), time.Now().UTC())
		return
	}
	updated, err := s.SetMeetdMeetingArtifactsDir(ctx, meeting.ID, artifactsDir)
	if err == nil && updated != nil {
		meeting = *updated
	}
	sessionID := fmt.Sprintf("meetd-%d", meeting.ID)
	response, err := s.JoinGoogleMeet(ctx, JoinGoogleMeetRequest{
		SessionID:          sessionID,
		MeetingID:          fmt.Sprintf("%d", meeting.ID),
		MeetingURL:         meeting.MeetURL,
		Title:              meeting.Title,
		DryRun:             false,
		AllowNonGoogleMeet: true,
		CaptureCaptions:    true,
		CaptionLanguage:    s.captionLanguage,
	})
	if err != nil {
		_, _ = s.UpdateMeetdMeetingState(ctx, meeting.ID, "failed", fmt.Sprintf("joiner: %v", err), time.Now().UTC())
		return
	}
	sessionID = response.Session.ID
	if _, err := s.SetMeetdMeetingSession(ctx, meeting.ID, sessionID); err == nil {
		meeting.SessionID = sessionID
	}
	if meetdPrepareLooksJoined(response) {
		updated, err := s.UpdateMeetdMeetingState(ctx, meeting.ID, "active", "", time.Now().UTC())
		if err == nil && updated != nil {
			meeting = *updated
		}
		s.NotifyMeetdWebhook(ctx, "meeting.joined", meeting, nil)
	}
}

func meetdPrepareLooksJoined(response JoinGoogleMeetResponse) bool {
	status := strings.TrimSpace(response.Session.Status)
	return response.Started && (status == "joined" || status == "active")
}

func (s *Service) ProcessMeetdMeetingEnd(ctx context.Context, meeting MeetdMeetingRecord, forceDelivery bool) {
	s.NotifyMeetdWebhook(ctx, "meeting.processing", meeting, nil)
	captions, err := s.ListMeetdCaptions(ctx, meeting.ID, "live_caption")
	if err != nil {
		s.finishMeetdFailed(ctx, meeting, fmt.Errorf("load captions: %w", err), forceDelivery)
		return
	}
	if len(captions) == 0 {
		s.finishMeetdFailed(ctx, meeting, fmt.Errorf("no transcript captured"), forceDelivery)
		return
	}
	summary := meetdSummaryFromCaptions(meeting, captions)
	if err := s.SetMeetdMeetingSummary(ctx, meeting.ID, summary); err != nil {
		s.finishMeetdFailed(ctx, meeting, fmt.Errorf("persist summary: %w", err), forceDelivery)
		return
	}
	transcriptPath := s.writeMeetdTranscriptArtifact(meeting, captions)
	updated, _ := s.UpdateMeetdMeetingState(ctx, meeting.ID, "done", "", time.Now().UTC())
	if updated != nil {
		meeting = *updated
	}
	result := &MeetdMeetingResult{
		MeetingID: fmt.Sprintf("%d", meeting.ID),
		Status:    "done",
		Summary:   &summary,
		Artifacts: MeetdMeetingArtifacts{
			CaptionsCount:  len(captions),
			TranscriptPath: transcriptPath,
		},
		ForceDelivery: forceDelivery,
	}
	populateMeetdResultArtifacts(result, meeting)
	s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, result)
}

func (s *Service) finishMeetdFailed(ctx context.Context, meeting MeetdMeetingRecord, err error, forceDelivery bool) {
	_, _ = s.UpdateMeetdMeetingState(ctx, meeting.ID, "failed", err.Error(), time.Now().UTC())
	result := &MeetdMeetingResult{
		MeetingID:     fmt.Sprintf("%d", meeting.ID),
		Status:        "failed",
		Error:         err.Error(),
		ForceDelivery: forceDelivery,
	}
	s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, result)
}

func (s *Service) writeMeetdTranscriptArtifact(meeting MeetdMeetingRecord, captions []MeetdCaptionRecord) string {
	if strings.TrimSpace(meeting.ArtifactsDir) == "" {
		return ""
	}
	if err := os.MkdirAll(meeting.ArtifactsDir, 0o755); err != nil {
		s.logger.Warn("create meetd artifacts dir failed", "meeting_id", meeting.ID, "error", err)
		return ""
	}
	path := filepath.Join(meeting.ArtifactsDir, "transcript.txt")
	transcript := meetdCaptionTranscript(captions, meeting.StartTime)
	if transcript != "" {
		transcript += "\n"
	}
	if err := os.WriteFile(path, []byte(transcript), 0o644); err != nil {
		s.logger.Warn("write meetd transcript failed", "meeting_id", meeting.ID, "error", err)
		return ""
	}
	return path
}

func meetdSummaryFromCaptions(meeting MeetdMeetingRecord, captions []MeetdCaptionRecord) MeetdSummaryData {
	captions = dedupeMeetdCaptionsForTranscript(captions)
	keyPoints := make([]string, 0, len(captions))
	for _, caption := range captions {
		if text := strings.TrimSpace(caption.Text); text != "" {
			keyPoints = append(keyPoints, text)
		}
		if len(keyPoints) >= 5 {
			break
		}
	}
	duration := int(meeting.EndTime.Sub(meeting.StartTime) / time.Minute)
	if duration < 0 {
		duration = 0
	}
	return MeetdSummaryData{
		Title:           firstNonEmpty(meeting.Title, "Meeting summary"),
		Attendees:       meetdCaptionSpeakers(captions),
		DurationMinutes: duration,
		KeyPoints:       keyPoints,
		ActionItems:     []MeetdActionItem{},
		Decisions:       []string{},
		OpenQuestions:   []string{},
		Blockers:        []string{},
	}
}
