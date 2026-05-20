package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

var (
	errJoinSessionNotFound         = errors.New("join session not found")
	errJoinSessionNotRedeliverable = errors.New("join session not redeliverable")
)

func (s *Service) RedeliverJoinSessionBySyntheticMeetingID(ctx context.Context, meetingID int64) error {
	session, err := s.joinSessionBySyntheticMeetingID(ctx, meetingID)
	if err != nil {
		return err
	}
	if session == nil {
		return errJoinSessionNotFound
	}
	return s.redeliverJoinSessionRecord(ctx, *session, meetingID)
}

func (s *Service) RedeliverJoinSession(ctx context.Context, sessionID string) error {
	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if session == nil {
		return errJoinSessionNotFound
	}
	return s.redeliverJoinSessionRecord(ctx, *session, syntheticMeetingID(session.ID))
}

func (s *Service) redeliverJoinSessionRecord(ctx context.Context, session SessionRecord, meetingID int64) error {
	if !joinSessionCanRedeliver(session) {
		return fmt.Errorf("%w: session %s is in %q state", errJoinSessionNotRedeliverable, session.ID, session.Status)
	}

	slackChannel, slackThread := joinSlackRef(session)
	meeting := syntheticMeetdMeeting(session, slackChannel, slackThread)
	meeting.ID = meetingID
	meeting.Status = "processing"
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, "processing", "", ""); err == nil && updated != nil {
		meeting = *updated
	}
	if slackChannel != "" && slackThread != "" {
		s.NotifyMeetdWebhook(ctx, "meeting.processing", meeting, nil)
	}

	input, err := s.postProcessInputFromJoinSessionRedelivery(ctx, session, meeting)
	if err != nil {
		if updated, updateErr := s.upsertSyntheticMeetdMeeting(ctx, meeting, "failed", err.Error(), ""); updateErr == nil && updated != nil {
			meeting = *updated
		}
		_ = s.redeliverJoinSessionResult(ctx, meeting, MeetdMeetingResult{
			MeetingID:     meetingIDString(meeting.ID),
			Status:        "failed",
			Error:         err.Error(),
			ForceDelivery: true,
		})
		return err
	}
	result, err := s.PostProcessMeeting(ctx, input)
	if err != nil {
		if updated, updateErr := s.upsertSyntheticMeetdMeeting(ctx, meeting, "failed", err.Error(), ""); updateErr == nil && updated != nil {
			meeting = *updated
		}
		_ = s.redeliverJoinSessionResult(ctx, meeting, MeetdMeetingResult{
			MeetingID:     meetingIDString(meeting.ID),
			Status:        "failed",
			Error:         err.Error(),
			ForceDelivery: true,
		})
		return err
	}
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, "done", "", result.Artifact.Dir); err == nil && updated != nil {
		meeting = *updated
	}
	if summary := meetdSummaryFromPostMeeting(result.Summary); summary != nil {
		if err := s.SetMeetdMeetingSummary(ctx, meeting.ID, *summary); err != nil {
			s.logger.Warn("persist redelivered join summary failed", "meeting_id", meeting.ID, "session_id", session.ID, "error", err)
		}
	}
	if strings.EqualFold(strings.TrimSpace(session.Status), "stale") {
		s.markRedeliveredJoinSessionDone(ctx, session)
	}

	return s.redeliverJoinSessionResult(ctx, meeting, MeetdMeetingResult{
		MeetingID: meetingIDString(meeting.ID),
		Status:    "done",
		Summary:   meetdSummaryFromPostMeeting(result.Summary),
		Artifacts: MeetdMeetingArtifacts{
			CaptionsCount:  len(input.Captions),
			TranscriptPath: firstNonEmpty(result.Artifact.Files.TranscriptText, result.Artifact.Files.Transcript),
			AudioPath:      result.Artifact.Files.Audio,
		},
		ForceDelivery: true,
	})
}

func (s *Service) markRedeliveredJoinSessionDone(ctx context.Context, session SessionRecord) {
	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["stale_recovered_from_redelivery"] = true
	if _, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           "done",
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          firstNonEmpty(session.EndedAt, time.Now().UTC().Format(time.RFC3339Nano)),
		Metadata:         metadata,
	}); err != nil {
		s.logger.Warn("persist redelivered stale join session failed", "session_id", session.ID, "error", err)
	}
}

func (s *Service) redeliverJoinSessionResult(ctx context.Context, meeting MeetdMeetingRecord, result MeetdMeetingResult) error {
	if s.meetdWebhook == nil {
		return fmt.Errorf("webhook sender not configured")
	}
	return s.meetdWebhook(ctx, meeting, result)
}

func (s *Service) upsertSyntheticMeetdMeeting(ctx context.Context, meeting MeetdMeetingRecord, status, errorMessage, artifactsDir string) (*MeetdMeetingRecord, error) {
	if meeting.ID <= 0 {
		return nil, fmt.Errorf("synthetic meeting id is required")
	}
	store, err := s.meetdMeetingCollection()
	if err != nil {
		return nil, err
	}
	s.meetdWriteMu.Lock()
	defer s.meetdWriteMu.Unlock()

	now := time.Now().UTC()
	record := meeting
	if existing, ok, err := store.Get(ctx, meetdMeetingKey(meeting.ID)); err != nil {
		return nil, fmt.Errorf("load synthetic meeting: %w", err)
	} else if ok {
		record.CreatedAt = existing.CreatedAt
		if record.CalendarEventID == "" {
			record.CalendarEventID = existing.CalendarEventID
		}
		if artifactsDir == "" {
			record.ArtifactsDir = existing.ArtifactsDir
		}
	}
	if record.CalendarEventID == "" {
		record.CalendarEventID = "join:" + firstNonEmpty(record.SessionID, meetingIDString(record.ID))
	}
	if status != "" {
		record.Status = status
	}
	record.ErrorMessage = errorMessage
	if artifactsDir != "" {
		record.ArtifactsDir = artifactsDir
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = now
	}
	record.UpdatedAt = now
	if err := store.Set(ctx, meetdMeetingKey(record.ID), record); err != nil {
		return nil, fmt.Errorf("upsert synthetic meeting: %w", err)
	}
	return &record, nil
}

func (s *Service) joinSessionBySyntheticMeetingID(ctx context.Context, meetingID int64) (*SessionRecord, error) {
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	for _, session := range sessions {
		if syntheticMeetingID(session.ID) == meetingID {
			return &session, nil
		}
	}
	return nil, nil
}

func joinSessionCanRedeliver(session SessionRecord) bool {
	switch strings.TrimSpace(strings.ToLower(session.Status)) {
	case "stopped", "done", "failed", "stale":
		return true
	default:
		return false
	}
}

func (s *Service) postProcessInputFromJoinSessionRedelivery(ctx context.Context, session SessionRecord, meeting MeetdMeetingRecord) (postmeeting.PostProcessInput, error) {
	artifactID := "join-" + session.ID
	manifest, _ := s.pipeline.GetArtifact(artifactID)
	captions := joinRedeliveryCaptions(manifest)
	if len(captions) == 0 {
		captions = joinRedeliveryRawCaptions(session)
	}
	if len(captions) == 0 {
		return postmeeting.PostProcessInput{}, fmt.Errorf("no transcript captured")
	}
	audioPath := joinRedeliveryAudioPath(ctx, manifest, session)
	return postmeeting.PostProcessInput{
		ArtifactID: artifactID,
		MeetingID:  meetingIDString(meeting.ID),
		SessionID:  session.ID,
		Title:      firstNonEmpty(session.Title, "Meeting summary"),
		MeetURL:    session.MeetingURL,
		Captions:   captions,
		AudioPath:  audioPath,
		SkipASR:    true,
		Source:     "join-redeliver",
	}, nil
}

func joinRedeliveryCaptions(manifest *postmeeting.ArtifactManifest) []postmeeting.TranscriptSegmentInput {
	if manifest == nil {
		return nil
	}
	return transcriptSegmentsFromPostMeetingArtifact(manifest.Files.Transcript)
}

func transcriptSegmentsFromPostMeetingArtifact(path string) []postmeeting.TranscriptSegmentInput {
	path = resolveRuntimeFile(path)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var artifact postmeeting.TranscriptArtifact
	if err := json.Unmarshal(raw, &artifact); err != nil {
		return nil
	}
	segments := make([]postmeeting.TranscriptSegmentInput, 0, len(artifact.Segments))
	for _, segment := range artifact.Segments {
		segments = append(segments, postmeeting.TranscriptSegmentInput{
			Speaker:   segment.Speaker,
			Text:      segment.Text,
			Timestamp: segment.Timestamp,
			Source:    firstNonEmpty(segment.Source, artifact.Provider, "caption"),
			StreamID:  segment.StreamID,
		})
	}
	return normalizedTranscriptSegments(segments)
}

func joinRedeliveryRawCaptions(session SessionRecord) []postmeeting.TranscriptSegmentInput {
	for _, path := range []string{
		stringFromMap(session.Metadata, "captions_path"),
		filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", session.ID, "captions.json"),
		filepath.Join("runtime/meeting-artifacts", "runner-"+session.ID, "captions.json"),
	} {
		if segments := captionSegmentsFromFile(path); len(segments) > 0 {
			return segments
		}
	}
	return nil
}

func joinRedeliveryAudioPath(ctx context.Context, manifest *postmeeting.ArtifactManifest, session SessionRecord) string {
	if manifest != nil {
		if path := usableMeetingAudioArtifactPath(ctx, manifest.Files.Audio); path != "" {
			return finalizedJoinRedeliveryAudioPath(ctx, path)
		}
		for _, chunk := range manifest.Files.AudioChunks {
			if path := usableMeetingAudioArtifactPath(ctx, chunk); path != "" {
				return path
			}
		}
	}
	for _, path := range []string{
		stringFromMap(session.Metadata, "audio_path"),
		filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", session.ID, "audio.mp3"),
		filepath.Join("/tmp/meeting-avatar-bot-data/meeting-artifacts", session.ID, "audio.wav"),
		filepath.Join("runtime/meeting-artifacts", "runner-"+session.ID, "audio.mp3"),
		filepath.Join("runtime/meeting-artifacts", "runner-"+session.ID, "audio.wav"),
	} {
		if audio := usableMeetingAudioArtifactPath(ctx, path); audio != "" {
			return finalizedJoinRedeliveryAudioPath(ctx, audio)
		}
	}
	return ""
}

func finalizedJoinRedeliveryAudioPath(ctx context.Context, path string) string {
	if !strings.EqualFold(filepath.Base(path), rawMeetingAudioFilename) {
		return path
	}
	if finalPath := finalizeMeetingAudioArtifact(ctx, filepath.Dir(path), 0); finalPath != "" {
		if audio := usableMeetingAudioArtifactPath(ctx, finalPath); audio != "" {
			return audio
		}
	}
	return path
}
