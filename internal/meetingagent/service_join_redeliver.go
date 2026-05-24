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
	ctx = context.WithoutCancel(ctx)

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
		s.failRedeliveredJoinSession(ctx, meeting, err)
		return err
	}
	result, err := s.PostProcessMeeting(ctx, input)
	if err != nil {
		s.failRedeliveredJoinSession(ctx, meeting, err)
		return err
	}
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusDone), "", result.Artifact.Dir); err == nil && updated != nil {
		meeting = *updated
	}
	if summary := meetdSummaryFromPostMeeting(result.Summary); summary != nil {
		if err := s.SetMeetdMeetingSummary(ctx, meeting.ID, *summary); err != nil {
			s.logger.Warn("persist redelivered join summary failed", "meeting_id", meeting.ID, "session_id", session.ID, "error", err)
		}
	}
	if normalizeJoinSessionStatus(session.Status) == joinSessionStatusStale {
		s.markRedeliveredJoinSessionDone(ctx, session)
	}

	return s.redeliverJoinSessionResult(ctx, meeting, MeetdMeetingResult{
		MeetingID: meetingIDString(meeting.ID),
		Status:    joinSessionStatusString(joinSessionStatusDone),
		Summary:   meetdSummaryFromPostMeeting(result.Summary),
		Artifacts: MeetdMeetingArtifacts{
			CaptionsCount:  len(input.Captions),
			TranscriptPath: firstNonEmpty(result.Artifact.Files.TranscriptText, result.Artifact.Files.Transcript),
			AudioPath:      result.Artifact.Files.Audio,
		},
		ForceDelivery: true,
	})
}

func (s *Service) failRedeliveredJoinSession(ctx context.Context, meeting MeetdMeetingRecord, cause error) {
	reason := cause.Error()
	status := joinSessionStatusString(joinSessionStatusFailed)
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, status, reason, ""); err == nil && updated != nil {
		meeting = *updated
	}
	_ = s.redeliverJoinSessionResult(ctx, meeting, MeetdMeetingResult{
		MeetingID:     meetingIDString(meeting.ID),
		Status:        status,
		Error:         reason,
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
		Status:           joinSessionStatusString(joinSessionStatusDone),
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
	return isRedeliverableJoinSessionStatus(session.Status)
}

func (s *Service) postProcessInputFromJoinSessionRedelivery(ctx context.Context, session SessionRecord, meeting MeetdMeetingRecord) (postmeeting.PostProcessInput, error) {
	artifactID := "join-" + session.ID
	manifest, err := s.pipeline.GetArtifact(artifactID)
	if err != nil {
		return postmeeting.PostProcessInput{}, fmt.Errorf("load join artifact manifest: %w", err)
	}
	captions, err := s.joinRedeliveryCaptions(artifactID, manifest)
	if err != nil {
		return postmeeting.PostProcessInput{}, err
	}
	if len(captions) == 0 {
		captions, err = s.joinRedeliveryRawCaptions(session)
		if err != nil {
			return postmeeting.PostProcessInput{}, err
		}
	}
	if len(captions) == 0 {
		return postmeeting.PostProcessInput{}, fmt.Errorf("no transcript captured")
	}
	audioPath, err := s.joinRedeliveryAudioPath(ctx, artifactID, manifest, session)
	if err != nil {
		return postmeeting.PostProcessInput{}, err
	}
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

func (s *Service) joinRedeliveryCaptions(artifactID string, manifest *postmeeting.ArtifactManifest) ([]postmeeting.TranscriptSegmentInput, error) {
	if manifest == nil {
		return nil, nil
	}
	transcriptPath, err := s.artifactFileUnderArtifactDir(artifactID, manifest.Files.Transcript)
	if err != nil {
		return nil, fmt.Errorf("resolve join transcript artifact: %w", err)
	}
	if transcriptPath == "" {
		return nil, nil
	}
	return transcriptSegmentsFromPostMeetingArtifact(transcriptPath)
}

func transcriptSegmentsFromPostMeetingArtifact(path string) ([]postmeeting.TranscriptSegmentInput, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read transcript artifact: %w", err)
	}
	var artifact postmeeting.TranscriptArtifact
	if err := json.Unmarshal(raw, &artifact); err != nil {
		return nil, fmt.Errorf("decode transcript artifact: %w", err)
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
	return normalizedTranscriptSegments(segments), nil
}

func (s *Service) joinRedeliveryRawCaptions(session SessionRecord) ([]postmeeting.TranscriptSegmentInput, error) {
	if metadataPath := stringFromMap(session.Metadata, "captions_path"); metadataPath != "" {
		path, err := s.artifactFileUnderRoot(metadataPath)
		if err != nil {
			return nil, fmt.Errorf("resolve redelivery captions path: %w", err)
		}
		if segments := captionSegmentsFromFile(path); len(segments) > 0 {
			return segments, nil
		}
	}
	candidates := meetingArtifactCandidatePaths(session.ID, meetingCaptionsFilename)
	for _, path := range candidates {
		if segments := captionSegmentsFromFile(path); len(segments) > 0 {
			return segments, nil
		}
	}
	return nil, nil
}

func (s *Service) joinRedeliveryAudioPath(ctx context.Context, artifactID string, manifest *postmeeting.ArtifactManifest, session SessionRecord) (string, error) {
	if manifest != nil {
		if path, err := s.usableRedeliveryManifestAudioPath(ctx, artifactID, manifest.Files.Audio); err != nil {
			return "", err
		} else if path != "" {
			return finalizedJoinRedeliveryAudioPath(ctx, path), nil
		}
		for _, chunk := range manifest.Files.AudioChunks {
			if path, err := s.usableRedeliveryManifestAudioPath(ctx, artifactID, chunk); err != nil {
				return "", err
			} else if path != "" {
				return path, nil
			}
		}
	}
	if metadataPath := stringFromMap(session.Metadata, "audio_path"); metadataPath != "" {
		path, err := s.artifactFileUnderRoot(metadataPath)
		if err != nil {
			return "", fmt.Errorf("resolve redelivery audio path: %w", err)
		}
		if audio := usableMeetingAudioArtifactPath(ctx, path); audio != "" {
			return finalizedJoinRedeliveryAudioPath(ctx, audio), nil
		}
	}
	candidates := meetingArtifactCandidatePaths(session.ID, finalMeetingAudioFilename)
	candidates = append(candidates, meetingArtifactCandidatePaths(session.ID, rawMeetingAudioFilename)...)
	for _, path := range candidates {
		if audio := usableMeetingAudioArtifactPath(ctx, path); audio != "" {
			return finalizedJoinRedeliveryAudioPath(ctx, audio), nil
		}
	}
	return "", nil
}

func (s *Service) usableRedeliveryManifestAudioPath(ctx context.Context, artifactID string, path string) (string, error) {
	path, err := s.artifactFileUnderArtifactDir(artifactID, path)
	if err != nil {
		return "", fmt.Errorf("resolve join audio artifact: %w", err)
	}
	if path == "" {
		return "", nil
	}
	return usableMeetingAudioArtifactPath(ctx, path), nil
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
