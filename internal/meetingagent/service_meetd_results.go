package meetingagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const processingResummarizeMinAge = 5 * time.Minute

type MeetdWebhookSender func(context.Context, MeetdMeetingRecord, MeetdMeetingResult) error

func (s *Service) LoadStoredMeetdMeetingResult(ctx context.Context, meeting MeetdMeetingRecord) (*MeetdMeetingResult, error) {
	switch meeting.Status {
	case "done":
		result := &MeetdMeetingResult{
			MeetingID: strconv.FormatInt(meeting.ID, 10),
			Status:    meeting.Status,
		}
		summary, err := s.meetdMeetingSummary(ctx, meeting.ID)
		if err != nil {
			return nil, err
		}
		if summary != nil {
			result.Summary = &summary.Summary
		}
		return result, nil
	case "failed":
		return &MeetdMeetingResult{
			MeetingID: strconv.FormatInt(meeting.ID, 10),
			Status:    meeting.Status,
			Error:     meeting.ErrorMessage,
		}, nil
	default:
		return nil, nil
	}
}

func populateMeetdResultArtifacts(result *MeetdMeetingResult, meeting MeetdMeetingRecord) {
	if result == nil || strings.TrimSpace(meeting.ArtifactsDir) == "" {
		return
	}
	transcriptPath := filepath.Join(meeting.ArtifactsDir, meetingTranscriptFilename)
	if fileExists(transcriptPath) {
		result.Artifacts.TranscriptPath = transcriptPath
	}
	for _, name := range []string{finalMeetingAudioFilename, rawMeetingAudioFilename} {
		audioPath := filepath.Join(meeting.ArtifactsDir, name)
		if fileExists(audioPath) {
			result.Artifacts.AudioPath = audioPath
			return
		}
	}
}

func resolveMeetdArtifactPath(meeting MeetdMeetingRecord, name string) (string, string, string, error) {
	name = strings.Trim(strings.TrimSpace(strings.ToLower(name)), "/")
	if meeting.ArtifactsDir == "" {
		return "", "", "", fmt.Errorf("meeting %d has no artifacts", meeting.ID)
	}
	switch name {
	case "transcript":
		path := filepath.Join(meeting.ArtifactsDir, meetingTranscriptFilename)
		if _, err := os.Stat(path); err != nil {
			if !os.IsNotExist(err) {
				return "", "", "", fmt.Errorf("stat artifact: %w", err)
			}
			return "", "", "", fmt.Errorf("meeting %d transcript artifact not found", meeting.ID)
		}
		return path, "text/plain; charset=utf-8", fmt.Sprintf("meeting-%d-transcript.txt", meeting.ID), nil
	case "audio":
		for _, artifact := range []struct {
			name        string
			contentType string
		}{
			{name: finalMeetingAudioFilename, contentType: "audio/mpeg"},
			{name: rawMeetingAudioFilename, contentType: "audio/wav"},
		} {
			path := filepath.Join(meeting.ArtifactsDir, artifact.name)
			if fileExists(path) {
				return path, artifact.contentType, fmt.Sprintf("meeting-%d-recording%s", meeting.ID, filepath.Ext(artifact.name)), nil
			}
		}
		return "", "", "", fmt.Errorf("meeting %d audio artifact not found", meeting.ID)
	default:
		return "", "", "", fmt.Errorf("unsupported artifact %q", name)
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
