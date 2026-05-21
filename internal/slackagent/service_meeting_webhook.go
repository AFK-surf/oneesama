package slackagent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const meetingAudioUploadMaxBytes = 64 << 20

var compressSlackMeetingAudioArtifact = func(ctx context.Context, audioPath string) string {
	if !strings.EqualFold(filepath.Ext(audioPath), ".wav") {
		return audioPath
	}
	mp3Path := strings.TrimSuffix(audioPath, filepath.Ext(audioPath)) + ".mp3"
	if shouldUploadMeetingArtifact(mp3Path) {
		return mp3Path
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-i", audioPath, "-codec:a", "libmp3lame", "-b:a", "64k", mp3Path)
	if _, err := cmd.CombinedOutput(); err != nil {
		return ""
	}
	if shouldUploadMeetingArtifact(mp3Path) {
		return mp3Path
	}
	return ""
}

func (s *Service) HandleMeetingWebhook(ctx context.Context, payload MeetingWebhookPayload) MeetingWebhookResponse {
	normalized := normalizeMeetingWebhookPayload(payload)
	if normalized.Event == "" {
		return MeetingWebhookResponse{OK: false, Error: "missing_webhook_event"}
	}
	switch normalized.Event {
	case "meeting.joined":
		return s.handleMeetingWebhookJoined(ctx, normalized)
	case "meeting.processing":
		return s.handleMeetingWebhookProcessing(ctx, normalized)
	case "meeting.result":
		return s.handleMeetingWebhookResult(ctx, normalized)
	case "meeting.digest":
		return s.handleMeetingWebhookDigest(ctx, normalized)
	default:
		return MeetingWebhookResponse{OK: true, Skipped: true, Event: normalized.Event, MeetingID: normalized.MeetingID, Reason: "unknown_meeting_webhook_event"}
	}
}

func (s *Service) handleMeetingWebhookJoined(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingWebhookResponse {
	ref := s.resolveMeetingWebhookRef(ctx, payload)
	if ref.ChannelID == "" {
		return MeetingWebhookResponse{OK: true, Skipped: true, Event: payload.Event, MeetingID: payload.MeetingID, Reason: "missing_slack_ref_no_dm_opener", SlackRef: ref}
	}

	text, blocks := buildMeetingJoinedPost(payload)
	post := s.poster.PostMessage(ctx, PostMessageInput{
		Channel:  ref.ChannelID,
		ThreadTS: ref.ThreadTS,
		Text:     text,
		Blocks:   blocks,
		DedupKey: meetingWebhookDedupKey(payload.MeetingID, "joined", ref),
	})
	status := s.scheduleAssistantThreadStatus(ctx, AssistantThreadRef{
		ChannelID: ref.ChannelID,
		ThreadTS:  firstNonEmpty(ref.ThreadTS, post.ThreadTS, post.TS),
	}, "Recording meeting...", true)
	thread, err := s.meetingWebhooks.InsertThread(ctx, payload, ref, firstNonEmpty(post.ThreadTS, post.TS))
	if err != nil {
		s.logger.Warn("meeting webhook joined thread persist failed", "meeting_id", payload.MeetingID, "error", err)
	}
	return MeetingWebhookResponse{
		OK:              post.OK,
		Event:           payload.Event,
		MeetingID:       payload.MeetingID,
		SlackRef:        ref,
		Post:            &post,
		AssistantStatus: &status,
		MeetingThread:   thread,
	}
}

func (s *Service) handleMeetingWebhookProcessing(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingWebhookResponse {
	ref := s.resolveMeetingWebhookRef(ctx, payload)
	if ref.ChannelID == "" {
		return MeetingWebhookResponse{OK: true, Skipped: true, Event: payload.Event, MeetingID: payload.MeetingID, Reason: "missing_slack_ref", SlackRef: ref}
	}
	status := s.scheduleAssistantThreadStatus(ctx, AssistantThreadRef{
		ChannelID: ref.ChannelID,
		ThreadTS:  ref.ThreadTS,
	}, "Generating meeting summary...", true)
	return MeetingWebhookResponse{
		OK:              status.OK,
		Event:           payload.Event,
		MeetingID:       payload.MeetingID,
		SlackRef:        ref,
		AssistantStatus: &status,
	}
}

func (s *Service) handleMeetingWebhookResult(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingWebhookResponse {
	if payload.ForceDelivery {
		if err := s.meetingWebhooks.ResetResult(ctx, payload.MeetingID); err != nil {
			return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_result_delivery_failed", Detail: err.Error()}
		}
	}
	reserved, delivery, err := s.meetingWebhooks.ReserveResult(ctx, payload.MeetingID)
	if err != nil {
		return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_result_delivery_failed", Detail: err.Error()}
	}
	if !reserved {
		return MeetingWebhookResponse{OK: true, Skipped: true, Duplicate: true, Event: payload.Event, MeetingID: payload.MeetingID, Reason: "delivery_already_reserved", Delivery: delivery}
	}

	ref := s.resolveMeetingWebhookRef(ctx, payload)
	if payload.Status == "failed" {
		return s.postMeetingFailureResult(ctx, payload, ref)
	}
	if payload.Summary == nil {
		_ = s.meetingWebhooks.FailResult(ctx, payload.MeetingID)
		return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "summary_required"}
	}
	return s.postMeetingSummaryResult(ctx, payload, ref)
}

func (s *Service) postMeetingFailureResult(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef) MeetingWebhookResponse {
	var post *PostMessageResult
	if ref.ChannelID != "" {
		result := s.poster.PostMessage(ctx, PostMessageInput{
			Channel:  ref.ChannelID,
			ThreadTS: ref.ThreadTS,
			Text:     buildMeetingFailurePost(payload),
			DedupKey: meetingWebhookDedupKey(payload.MeetingID, "failed", ref),
		})
		post = &result
	}
	delivery, err := s.meetingWebhooks.ConfirmResult(ctx, payload.MeetingID)
	if err != nil {
		return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_result_delivery_failed", Detail: err.Error(), Post: post}
	}
	return MeetingWebhookResponse{OK: post == nil || post.OK, Event: payload.Event, MeetingID: payload.MeetingID, Status: "failed", SlackRef: ref, Post: post, Delivery: delivery}
}

func (s *Service) postMeetingSummaryResult(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef) MeetingWebhookResponse {
	var published *PublishedCanvasManifest
	var post *PostMessageResult
	if ref.ChannelID != "" {
		manifest, err := s.publishMeetingSummary(ctx, payload, ref)
		if err != nil {
			_ = s.meetingWebhooks.FailResult(ctx, payload.MeetingID)
			return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_result_delivery_failed", Detail: err.Error(), SlackRef: ref}
		}
		published = &manifest
		post = manifest.Slack
	}
	delivery, err := s.meetingWebhooks.ConfirmResult(ctx, payload.MeetingID)
	if err != nil {
		return MeetingWebhookResponse{OK: false, Event: payload.Event, MeetingID: payload.MeetingID, Error: "meeting_result_delivery_failed", Detail: err.Error(), Post: post, Published: published}
	}
	s.projectMeetingResultToTeamMemory(ctx, payload, ref)
	s.enqueueMeetingActionFollowups(ctx, payload, ref)
	status := s.scheduleAssistantThreadStatus(ctx, AssistantThreadRef{ChannelID: ref.ChannelID, ThreadTS: ref.ThreadTS}, "", true)
	return MeetingWebhookResponse{OK: post == nil || post.OK, Event: payload.Event, MeetingID: payload.MeetingID, Status: firstNonEmpty(payload.Status, "done"), SlackRef: ref, Post: post, Published: published, AssistantStatus: &status, Delivery: delivery}
}

func (s *Service) publishMeetingSummary(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef) (PublishedCanvasManifest, error) {
	publisher, err := s.getCanvasPublisher()
	if err != nil {
		return PublishedCanvasManifest{}, err
	}
	artifacts, err := s.uploadMeetingArtifactFiles(ctx, payload.Artifacts, ref)
	if err != nil {
		return PublishedCanvasManifest{}, err
	}
	payload.Artifacts = artifacts
	title := firstNonEmpty(normalizeMeetingSummary(payload.Summary, payload.Title).Title, payload.Title, "Meeting summary")
	return publisher.Publish(ctx, CanvasPublishInput{
		Artifact:         meetingCanvasArtifact(payload),
		ArtifactID:       fmt.Sprintf("meeting-%d", payload.MeetingID),
		Title:            title,
		SummaryMarkdown:  buildMeetingCanvasMarkdown(payload),
		NotificationText: buildMeetingResultNotification(payload),
		Channel:          ref.ChannelID,
		ThreadTS:         ref.ThreadTS,
		Destination:      "meeting-webhook",
		DedupKey:         meetingWebhookDedupKey(payload.MeetingID, "summary", ref),
		ForceSlackCanvas: true,
	})
}

func (s *Service) uploadMeetingArtifactFiles(ctx context.Context, artifacts MeetingWebhookArtifacts, ref MeetingSlackRef) (MeetingWebhookArtifacts, error) {
	if strings.TrimSpace(ref.ChannelID) == "" || strings.TrimSpace(s.botToken) == "" {
		return artifacts, nil
	}
	uploaded := artifacts
	if transcript := firstNonEmpty(artifacts.TranscriptPath, artifacts.TranscriptPathAlt, artifacts.Transcript); shouldUploadMeetingArtifact(transcript) {
		file, err := s.uploadMeetingArtifactFile(ctx, transcript, "transcript.txt", ref)
		if err != nil {
			s.logger.Warn("meeting transcript upload failed", "path", transcript, "error", err)
		} else {
			uploaded.TranscriptPath = file.Permalink
			uploaded.TranscriptPathAlt = ""
			uploaded.Transcript = ""
		}
	}
	if audio := firstNonEmpty(artifacts.AudioPath, artifacts.AudioPathAlt, artifacts.Audio); shouldUploadMeetingArtifact(audio) {
		sourceAudio := audio
		audio = compressSlackMeetingAudioArtifact(ctx, audio)
		if strings.TrimSpace(audio) == "" {
			s.logger.Warn("skip meeting audio upload; wav compression unavailable", "path", sourceAudio)
			return withoutMeetingAudioArtifact(uploaded), nil
		}
		if !shouldUploadMeetingAudioArtifact(audio) {
			s.logger.Warn("skip meeting audio upload; compressed mp3 required", "path", audio)
			return withoutMeetingAudioArtifact(uploaded), nil
		}
		file, err := s.uploadMeetingArtifactFile(ctx, audio, meetingAudioUploadName(audio), ref)
		if err != nil {
			s.logger.Warn("meeting audio upload failed", "path", audio, "error", err)
			return withoutMeetingAudioArtifact(uploaded), nil
		}
		uploaded.AudioPath = file.Permalink
		uploaded.AudioPathAlt = ""
		uploaded.Audio = ""
	}
	return uploaded, nil
}

func withoutMeetingAudioArtifact(artifacts MeetingWebhookArtifacts) MeetingWebhookArtifacts {
	artifacts.AudioPath = ""
	artifacts.AudioPathAlt = ""
	artifacts.Audio = ""
	return artifacts
}

func (s *Service) uploadMeetingArtifactFile(ctx context.Context, path string, title string, _ MeetingSlackRef) (SlackUploadedFile, error) {
	file := UploadSlackFile(ctx, s.canvasConfig.Client, s.botToken, s.canvasConfig.APIBaseURL, SlackFileUploadInput{
		Path:     path,
		Filename: title,
		Title:    title,
	})
	if !file.OK {
		return file, fmt.Errorf("upload meeting artifact %s: %s %s", title, file.Error, file.Detail)
	}
	if strings.TrimSpace(file.Permalink) == "" {
		return file, fmt.Errorf("upload meeting artifact %s: missing permalink", title)
	}
	return file, nil
}

func shouldUploadMeetingArtifact(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "slack://") {
		return false
	}
	info, err := os.Stat(value)
	return err == nil && !info.IsDir()
}

func shouldUploadMeetingAudioArtifact(value string) bool {
	value = strings.TrimSpace(value)
	if !shouldUploadMeetingArtifact(value) {
		return false
	}
	// Recording webhooks should never upload raw WAV to Slack. If the
	// compressor cannot produce a bounded MP3, omit the audio artifact.
	if strings.EqualFold(filepath.Ext(value), ".wav") {
		return false
	}
	info, err := os.Stat(value)
	return err == nil && !info.IsDir() && info.Size() <= meetingAudioUploadMaxBytes
}

func meetingAudioUploadName(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".wav" {
		return "audio.wav"
	}
	return "audio.mp3"
}

func (s *Service) resolveMeetingWebhookRef(ctx context.Context, payload NormalizedMeetingWebhookPayload) MeetingSlackRef {
	return s.meetingWebhooks.ResolveRef(ctx, payload)
}

func meetingWebhookDedupKey(meetingID int64, kind string, ref MeetingSlackRef) string {
	return fmt.Sprintf("meeting:%d:%s:%s:%s", meetingID, kind, ref.ChannelID, firstNonEmpty(ref.ThreadTS, "root"))
}

func meetingWebhookRequestContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 5*time.Minute)
}
