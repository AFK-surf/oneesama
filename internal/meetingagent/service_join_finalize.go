package meetingagent

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

const staleJoinFailureMessage = "meet-runner session became unavailable before the meeting result was finalized"

func (s *Service) finalizeStoppedJoin(ctx context.Context, session SessionRecord, stop meetrunner.StopSessionResult, fixtureCaptions []postmeeting.TranscriptSegmentInput) (*postmeeting.PostProcessResult, string) {
	ctx = context.WithoutCancel(ctx)
	slackChannel, slackThread := joinSlackRef(session)
	captions := captionsFromStopRuntime(stop.Runtime)
	if len(captions) == 0 {
		captions = normalizeFixtureCaptions(fixtureCaptions)
	}
	meeting := syntheticMeetdMeeting(session, slackChannel, slackThread)
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, "processing", "", ""); err == nil && updated != nil {
		meeting = *updated
	}
	if slackChannel != "" && slackThread != "" {
		s.NotifyMeetdWebhook(ctx, "meeting.processing", meeting, nil)
	}
	if len(captions) == 0 {
		warning := "no transcript captured"
		if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusFailed), warning, ""); err == nil && updated != nil {
			meeting = *updated
		}
		if slackChannel != "" && slackThread != "" {
			s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, &MeetdMeetingResult{
				MeetingID:     meetingIDString(meeting.ID),
				Status:        joinSessionStatusString(joinSessionStatusFailed),
				Error:         warning,
				ForceDelivery: true,
			})
		}
		return nil, warning
	}
	audioPath := audioPathFromStopRuntime(ctx, stop.Runtime)
	result, err := s.PostProcessMeeting(ctx, postmeeting.PostProcessInput{
		ArtifactID: "join-" + session.ID,
		MeetingID:  meetingIDString(meeting.ID),
		SessionID:  session.ID,
		Title:      firstNonEmpty(session.Title, "Meeting summary"),
		MeetURL:    session.MeetingURL,
		Captions:   captions,
		AudioPath:  audioPath,
		Source:     "join-stop",
	})
	if err != nil {
		if updated, updateErr := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusFailed), err.Error(), ""); updateErr == nil && updated != nil {
			meeting = *updated
		}
		if slackChannel != "" && slackThread != "" {
			s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, &MeetdMeetingResult{
				MeetingID:     meetingIDString(meeting.ID),
				Status:        joinSessionStatusString(joinSessionStatusFailed),
				Error:         err.Error(),
				ForceDelivery: true,
			})
		}
		return nil, err.Error()
	}
	if updated, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusDone), "", result.Artifact.Dir); err == nil && updated != nil {
		meeting = *updated
	}
	if slackChannel != "" && slackThread != "" {
		s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, &MeetdMeetingResult{
			MeetingID: meetingIDString(meeting.ID),
			Status:    joinSessionStatusString(joinSessionStatusDone),
			Summary:   meetdSummaryFromPostMeeting(result.Summary),
			Artifacts: MeetdMeetingArtifacts{
				CaptionsCount:  len(captions),
				TranscriptPath: firstNonEmpty(result.Artifact.Files.TranscriptText, result.Artifact.Files.Transcript),
				AudioPath:      result.Artifact.Files.Audio,
			},
			ForceDelivery: true,
		})
	}
	return &result, ""
}

func (s *Service) finalizeStaleJoin(ctx context.Context, session SessionRecord, cause error) *SessionRecord {
	ctx = context.WithoutCancel(ctx)
	updated := s.markJoinSessionStale(ctx, session, cause)
	if updated == nil {
		updated = &session
	}
	slackChannel, slackThread := joinSlackRef(*updated)
	if slackChannel == "" || slackThread == "" {
		return updated
	}
	meeting := syntheticMeetdMeeting(*updated, slackChannel, slackThread)
	if recovered, recoveredSession := s.finalizeStaleJoinFromArtifacts(ctx, *updated, meeting, slackChannel, slackThread); recovered {
		return recoveredSession
	}
	if persisted, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusFailed), staleJoinFailureMessage, ""); err == nil && persisted != nil {
		meeting = *persisted
	} else if err != nil {
		s.logger.Warn("persist stale join meeting failed", "session_id", session.ID, "error", err)
	}
	s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, &MeetdMeetingResult{
		MeetingID:     meetingIDString(meeting.ID),
		Status:        joinSessionStatusString(joinSessionStatusFailed),
		Error:         staleJoinFailureMessage,
		ForceDelivery: true,
	})
	return updated
}

func (s *Service) finalizeStaleJoinFromArtifacts(ctx context.Context, session SessionRecord, meeting MeetdMeetingRecord, slackChannel string, slackThread string) (bool, *SessionRecord) {
	input, err := s.postProcessInputFromJoinSessionRedelivery(ctx, session, meeting)
	if err != nil {
		return false, nil
	}
	if persisted, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, "processing", "", ""); err == nil && persisted != nil {
		meeting = *persisted
	} else if err != nil {
		s.logger.Warn("persist stale join recovery meeting failed", "session_id", session.ID, "error", err)
		return false, nil
	}
	s.NotifyMeetdWebhook(ctx, "meeting.processing", meeting, nil)
	result, err := s.PostProcessMeeting(ctx, input)
	if err != nil {
		s.logger.Warn("post-process stale join artifacts failed", "session_id", session.ID, "error", err)
		return false, nil
	}
	if persisted, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, joinSessionStatusString(joinSessionStatusDone), "", result.Artifact.Dir); err == nil && persisted != nil {
		meeting = *persisted
	} else if err != nil {
		s.logger.Warn("persist recovered stale join meeting failed", "session_id", session.ID, "error", err)
		return false, nil
	}
	metadata := cloneMap(session.Metadata)
	if len(metadata) == 0 {
		metadata = map[string]any{}
	}
	metadata["stale_recovered_from_artifacts"] = true
	recoveredSession, err := s.UpsertSession(ctx, SessionUpsertInput{
		ID:               session.ID,
		MeetingID:        session.MeetingID,
		MeetingURL:       session.MeetingURL,
		Status:           joinSessionStatusString(joinSessionStatusDone),
		Title:            session.Title,
		ParticipantCount: session.ParticipantCount,
		StartedAt:        session.StartedAt,
		EndedAt:          firstNonEmpty(session.EndedAt, time.Now().UTC().Format(time.RFC3339Nano)),
		Metadata:         metadata,
	})
	if err != nil {
		s.logger.Warn("persist recovered stale join session failed", "session_id", session.ID, "error", err)
		recoveredSession = session
		recoveredSession.Status = joinSessionStatusString(joinSessionStatusDone)
		recoveredSession.Metadata = metadata
	}
	s.NotifyMeetdWebhook(ctx, "meeting.result", meeting, &MeetdMeetingResult{
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
	return true, &recoveredSession
}

func audioPathFromStopRuntime(ctx context.Context, runtime any) string {
	fields := map[string]any{}
	if !decodeAny(runtime, &fields) {
		return ""
	}
	beforeStop := mapFromAny(fields["beforeStop"])
	active := mapFromAny(beforeStop["active"])
	if recorderPath := existingRuntimePath(stringFromMap(mapFromAny(active["recorder"]), "audioPath")); recorderPath != "" {
		if artifactsDir := stringFromMap(active, "artifactsDir"); artifactsDir != "" {
			if finalPath := finalizeMeetingAudioArtifact(ctx, resolveRuntimeDir(artifactsDir), 0); finalPath != "" {
				return usableMeetingAudioArtifactPath(ctx, finalPath)
			}
		}
		return usableMeetingAudioArtifactPath(ctx, recorderPath)
	}
	if artifactsDir := stringFromMap(active, "artifactsDir"); artifactsDir != "" {
		artifactsDir = resolveRuntimeDir(artifactsDir)
		if finalPath := finalizeMeetingAudioArtifact(ctx, artifactsDir, 0); finalPath != "" {
			return usableMeetingAudioArtifactPath(ctx, finalPath)
		}
		if preferred := preferredMeetingAudioArtifactPath(artifactsDir); preferred != "" {
			return usableMeetingAudioArtifactPath(ctx, preferred)
		}
	}
	return ""
}

func fixtureCaptionsFromStopRequest(input StopJoinRequest) []postmeeting.TranscriptSegmentInput {
	if len(input.FixtureCaptions) > 0 {
		return input.FixtureCaptions
	}
	if len(input.SyntheticCaptions) > 0 {
		return input.SyntheticCaptions
	}
	if text := firstNonEmpty(input.FixtureTranscript, input.SyntheticTranscript); text != "" {
		return fixtureCaptionsFromTranscriptText(text)
	}
	return nil
}

func fixtureCaptionsFromTranscriptText(text string) []postmeeting.TranscriptSegmentInput {
	lines := strings.Split(text, "\n")
	segments := make([]postmeeting.TranscriptSegmentInput, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		speaker := "Fixture"
		if before, after, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(after) != "" {
			speaker = firstNonEmpty(before, speaker)
			line = strings.TrimSpace(after)
		}
		segments = append(segments, postmeeting.TranscriptSegmentInput{
			Speaker: speaker,
			Text:    line,
			Source:  "fixture_caption",
		})
	}
	return segments
}

func normalizeFixtureCaptions(captions []postmeeting.TranscriptSegmentInput) []postmeeting.TranscriptSegmentInput {
	if len(captions) == 0 {
		return nil
	}
	normalized := make([]postmeeting.TranscriptSegmentInput, 0, len(captions))
	for _, caption := range captions {
		text := strings.TrimSpace(caption.Text)
		if text == "" {
			continue
		}
		if strings.TrimSpace(caption.Source) == "" {
			caption.Source = "fixture_caption"
		}
		if strings.TrimSpace(caption.Speaker) == "" && strings.TrimSpace(caption.User) == "" && strings.TrimSpace(caption.Name) == "" {
			caption.Speaker = "Fixture"
		}
		caption.Text = text
		normalized = append(normalized, caption)
	}
	return normalized
}

func joinSlackRef(session SessionRecord) (string, string) {
	return stringFromMap(session.Metadata, "slack_channel_id"), stringFromMap(session.Metadata, "slack_thread_ts")
}

func syntheticMeetdMeeting(session SessionRecord, channelID string, threadTS string) MeetdMeetingRecord {
	now := time.Now().UTC()
	return MeetdMeetingRecord{
		ID:             syntheticMeetingID(session.ID),
		MeetURL:        session.MeetingURL,
		Title:          firstNonEmpty(session.Title, "Meeting summary"),
		StartTime:      parseSessionTime(session.StartedAt, now),
		EndTime:        parseSessionTime(session.EndedAt, now),
		Status:         "processing",
		SessionID:      session.ID,
		SlackChannelID: channelID,
		SlackThreadTS:  threadTS,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func syntheticMeetingID(value string) int64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(strings.TrimSpace(value)))
	id := int64(hash.Sum64() & 0x7fffffffffffffff)
	if id == 0 {
		return time.Now().UnixNano()
	}
	return id
}

func captionsFromStopRuntime(runtime any) []postmeeting.TranscriptSegmentInput {
	fields := map[string]any{}
	if !decodeAny(runtime, &fields) {
		return nil
	}
	beforeStop := mapFromAny(fields["beforeStop"])
	active := mapFromAny(beforeStop["active"])
	captions := mapFromAny(active["captions"])
	paths := mapFromAny(captions["paths"])
	if path := stringFromMap(paths, "json"); path != "" {
		if segments := captionSegmentsFromFile(path); len(segments) > 0 {
			return segments
		}
	}
	if segments := captionSegmentsFromAny(captions["tail"]); len(segments) > 0 {
		return segments
	}
	if segments := captionSegmentsFromAny(captions["latest"]); len(segments) > 0 {
		return segments
	}
	if segments := captionSegmentsFromMeetPageTextHead(stringFromMap(mapFromAny(active["meetPage"]), "textHead")); len(segments) > 0 {
		return segments
	}
	return nil
}

func captionSegmentsFromFile(path string) []postmeeting.TranscriptSegmentInput {
	path = resolveRuntimeFile(path)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	return captionSegmentsFromAny(body["captions"])
}

func captionSegmentsFromAny(value any) []postmeeting.TranscriptSegmentInput {
	var segments []postmeeting.TranscriptSegmentInput
	if decodeAny(value, &segments) {
		return normalizedTranscriptSegments(segments)
	}
	var segment postmeeting.TranscriptSegmentInput
	if decodeAny(value, &segment) {
		return normalizedTranscriptSegments([]postmeeting.TranscriptSegmentInput{segment})
	}
	return nil
}

func normalizedTranscriptSegments(segments []postmeeting.TranscriptSegmentInput) []postmeeting.TranscriptSegmentInput {
	if len(segments) == 0 {
		return nil
	}
	normalized := make([]postmeeting.TranscriptSegmentInput, 0, len(segments))
	for _, segment := range segments {
		segment.Text = strings.TrimSpace(segment.Text)
		if segment.Text == "" {
			continue
		}
		if isLocalMeetCaptionSpeaker(firstNonEmpty(segment.Speaker, segment.User, segment.Name)) {
			continue
		}
		if strings.TrimSpace(segment.Source) == "" {
			segment.Source = "google_meet_caption"
		}
		if strings.TrimSpace(segment.Speaker) == "" && strings.TrimSpace(segment.User) == "" && strings.TrimSpace(segment.Name) == "" {
			segment.Speaker = "unknown"
		}
		normalized = append(normalized, segment)
	}
	return normalized
}

func isLocalMeetCaptionSpeaker(value string) bool {
	normalized := strings.TrimSpace(value)
	normalized = strings.TrimSuffix(strings.TrimSuffix(normalized, ":"), "：")
	normalized = strings.TrimSpace(strings.ToLower(normalized))
	switch normalized {
	case "you", "me", "myself", "我", "你", "您", "自己", "本人":
		return true
	default:
		return strings.HasPrefix(normalized, "you (") && strings.HasSuffix(normalized, ")")
	}
}

func resolveRuntimeFile(path string) string {
	for _, candidate := range runtimePathCandidates(path) {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

func existingRuntimePath(path string) string {
	return resolveRuntimeFile(path)
}

func resolveRuntimeDir(path string) string {
	for _, candidate := range runtimePathCandidates(path) {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return strings.TrimSpace(path)
}

func runtimePathCandidates(path string) []string {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	if filepath.IsAbs(path) {
		return []string{path}
	}
	return []string{path, filepath.Join("meet-runner", path)}
}

func captionSegmentsFromMeetPageTextHead(text string) []postmeeting.TranscriptSegmentInput {
	lines := normalizedCaptionLines(text)
	if len(lines) == 0 {
		return nil
	}
	marker := -1
	for index, line := range lines {
		if strings.EqualFold(line, "groups") {
			marker = index
			break
		}
	}
	if marker < 0 || marker+1 >= len(lines) {
		return nil
	}
	speaker := "unknown"
	start := marker + 1
	if parsed := aggregateCaptionSpeaker(lines[start]); parsed != "" {
		speaker = parsed
		start++
	}
	candidates := make([]string, 0, len(lines)-start)
	for _, line := range lines[start:] {
		if line == "" || captionUIText(line) || aggregateCaptionLine(line) || likelyCaptionParticipantName(line) {
			continue
		}
		if len([]rune(line)) < 8 || !strings.ContainsAny(line, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789一二三四五六七八九十的是了吗我你他她它们我们") {
			continue
		}
		candidates = append(candidates, line)
	}
	if len(candidates) == 0 {
		return nil
	}
	return []postmeeting.TranscriptSegmentInput{{
		Speaker: speaker,
		Text:    strings.Join(candidates, " "),
		Source:  "meet_page_text_caption_fallback",
	}}
}

func normalizedCaptionLines(text string) []string {
	raw := strings.Split(strings.ReplaceAll(text, "\u00a0", " "), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func captionUIText(text string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(text), " "))
	if normalized == "" || len([]rune(normalized)) <= 2 {
		return true
	}
	uiPhrases := []string{
		"language", "english", "closed_caption", "live captions", "format_size", "font size",
		"circle", "font color", "settings", "open caption settings", "groups", "gemini",
		"take notes with gemini", "pen_spark", "adaptive_audio_mic", "domain_disabled",
		"press down arrow", "external participants joined", "your audio is merged with nearby devices",
		"meeting tools", "more options", "leave call", "turn on microphone", "turn off microphone",
		"turn on camera", "turn off camera",
	}
	for _, phrase := range uiPhrases {
		if normalized == phrase || strings.HasPrefix(normalized, phrase) {
			return true
		}
	}
	return false
}

func aggregateCaptionSpeaker(text string) string {
	normalized := strings.Join(strings.Fields(text), " ")
	for _, sep := range []string{" & ", " and "} {
		if before, after, ok := strings.Cut(normalized, sep); ok && strings.Contains(strings.ToLower(after), "others") {
			return strings.TrimSpace(before)
		}
	}
	if before, after, ok := strings.Cut(normalized, "等"); ok && strings.Contains(after, "人") {
		return strings.TrimSpace(before)
	}
	if before, after, ok := strings.Cut(normalized, "与"); ok && strings.Contains(after, "其他") {
		return strings.TrimSpace(before)
	}
	return ""
}

func aggregateCaptionLine(text string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(text), " "))
	return strings.Contains(normalized, " others") || strings.Contains(normalized, "等") && strings.Contains(normalized, "人") || strings.Contains(normalized, "其他")
}

func likelyCaptionParticipantName(text string) bool {
	if captionUIText(text) || aggregateCaptionLine(text) {
		return false
	}
	runes := []rune(text)
	if len(runes) < 2 || len(runes) > 64 {
		return false
	}
	if strings.Contains(text, "://") || strings.ContainsAny(text, ".?!,，。？！") {
		return false
	}
	for _, r := range runes {
		if r == ' ' || r == '-' || r == '_' || r == '\'' || r == '.' {
			continue
		}
		if r >= '0' && r <= '9' {
			continue
		}
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= 0x4e00 && r <= 0x9fff {
			continue
		}
		return false
	}
	return true
}

func meetdSummaryFromPostMeeting(summary postmeeting.Summary) *MeetdSummaryData {
	actions := make([]MeetdActionItem, 0, len(summary.ActionItems))
	for _, item := range summary.ActionItems {
		actions = append(actions, MeetdActionItem{Description: item})
	}
	return &MeetdSummaryData{
		Title:       firstNonEmpty(summary.Title, "Meeting summary"),
		Attendees:   summary.Participants,
		KeyPoints:   summary.Highlights,
		ActionItems: actions,
		Decisions:   summary.Decisions,
	}
}

func mapFromAny(value any) map[string]any {
	result := map[string]any{}
	if decodeAny(value, &result) {
		return result
	}
	return nil
}

func decodeAny(value any, target any) bool {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) == 0 || string(raw) == "null" {
		return false
	}
	return json.Unmarshal(raw, target) == nil
}

func stringFromMap(values map[string]any, key string) string {
	if len(values) == 0 {
		return ""
	}
	raw, _ := values[key].(string)
	return strings.TrimSpace(raw)
}

func meetingIDString(id int64) string {
	return strconv.FormatInt(id, 10)
}

func parseSessionTime(value string, fallback time.Time) time.Time {
	if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value)); err == nil {
		return parsed
	}
	return fallback
}
