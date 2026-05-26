package meetingagent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultJoinMonitorInterval = 10 * time.Second

const defaultJoinMonitorAloneTimeout = 30 * time.Second

var joinMonitorIntervalOverrideNanos atomic.Int64

var joinMonitorAloneTimeoutOverrideNanos atomic.Int64

func (s *Service) monitorJoinSession(ctx context.Context, sessionID string) {
	ticker := time.NewTicker(currentJoinMonitorInterval())
	defer ticker.Stop()
	emptyRoomAutoStop := !joinMonitorEmptyRoomAutoStopDisabled()
	seenJoined := false
	var aloneSince time.Time
	lastDigestCaptionCount := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		session, err := s.GetSession(ctx, sessionID)
		if err != nil || session == nil || isTerminalSessionStatus(session.Status) {
			return
		}
		status, err := s.meetRunner.StatusSession(ctx, meetrunner.StatusSessionInput{SessionID: sessionID})
		if err != nil {
			s.logger.Warn("join monitor status failed", "session_id", sessionID, "error", err)
			if runnerSessionUnavailable(err) {
				_ = s.finalizeStaleJoin(ctx, *session, err)
				return
			}
			continue
		}
		if runtimeMeetPageStatus(status.Active) == joinSessionStatusString(joinSessionStatusRemoved) {
			_ = s.sessionFromRuntimeStatus(ctx, *session, status)
			return
		}
		state := runtimeJoinState(status.Active)
		if state.Stale {
			_ = s.finalizeStaleJoin(ctx, *session, errMeetRunnerPageClosed)
			return
		}
		if state.Joined {
			seenJoined = true
			if state.ParticipantCount > 0 {
				session.ParticipantCount = state.ParticipantCount
			}
			if state.Alone && emptyRoomAutoStop {
				if aloneSince.IsZero() {
					aloneSince = time.Now()
					s.logger.Info("join monitor detected empty room", "session_id", sessionID, "participant_count", state.ParticipantCount)
				}
				if time.Since(aloneSince) >= currentJoinMonitorAloneTimeout() {
					_, _ = s.StopJoin(ctx, StopJoinRequest{SessionID: sessionID, Reason: "empty_room"})
					return
				}
			} else {
				aloneSince = time.Time{}
			}
			_, _ = s.UpsertSession(ctx, SessionUpsertInput{
				ID:               session.ID,
				MeetingID:        session.MeetingID,
				MeetingURL:       session.MeetingURL,
				Status:           joinSessionStatusString(joinSessionStatusJoined),
				Title:            session.Title,
				ParticipantCount: state.ParticipantCount,
				StartedAt:        session.StartedAt,
				Metadata:         session.Metadata,
			})
			s.maybeNotifyJoinDigestWebhook(ctx, *session, status, &lastDigestCaptionCount)
			continue
		}
		if state.Failed {
			_, _ = s.StopJoin(ctx, StopJoinRequest{SessionID: sessionID, Reason: firstNonEmpty(state.Reason, "join_failed")})
			return
		}
		if seenJoined && state.Left {
			_, _ = s.StopJoin(ctx, StopJoinRequest{SessionID: sessionID, Reason: "meeting_ended"})
			return
		}
	}
}

func (s *Service) maybeNotifyJoinDigestWebhook(ctx context.Context, session SessionRecord, status meetrunner.StatusSessionResult, lastCount *int) {
	slackChannel, slackThread := joinSlackRef(session)
	if slackChannel == "" || slackThread == "" || s.meetdWebhookURL == "" {
		return
	}
	active := mapFromAny(status.Active)
	captions := mapFromAny(active["captions"])
	count := intFromAny(captions["count"])
	if count <= 0 || (lastCount != nil && count <= *lastCount) {
		return
	}
	transcript := strings.TrimSpace(joinDigestTranscriptFromRuntimeCaptions(captions))
	if transcript == "" {
		return
	}
	meeting := syntheticMeetdMeeting(session, slackChannel, slackThread)
	if persisted, err := s.upsertSyntheticMeetdMeeting(ctx, meeting, "active", "", ""); err == nil && persisted != nil {
		meeting = *persisted
	} else if err != nil {
		s.logger.Warn("persist active join meeting failed", "session_id", session.ID, "error", err)
	}
	if s.NotifyMeetdDigestWebhook(ctx, meeting, transcript, "") && lastCount != nil {
		*lastCount = count
	}
}

func (s *Service) NotifyMeetdDigestWebhook(ctx context.Context, meeting MeetdMeetingRecord, transcript string, chatTranscript string) bool {
	if s.meetdWebhookURL == "" || strings.TrimSpace(transcript) == "" && strings.TrimSpace(chatTranscript) == "" {
		return false
	}
	payload := buildMeetdWebhookPayload("meeting.digest", meeting, nil)
	payload.Transcript = transcript
	payload.ChatTranscript = chatTranscript
	err := sendMeetdWebhook(ctx, s.meetdWebhookURL, s.meetdWebhookSecret, payload)
	if err != nil {
		s.logger.Warn("meetd digest webhook failed", "meeting_id", meeting.ID, "error", err)
		_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "failed", err.Error(), 5, payload.Event)
		return false
	}
	_ = s.UpdateMeetdWebhookState(context.WithoutCancel(ctx), meeting.ID, "delivered", "", 0, payload.Event)
	return true
}

func joinDigestTranscriptFromRuntimeCaptions(captions map[string]any) string {
	paths := mapFromAny(captions["paths"])
	if path := stringFromMap(paths, "json"); path != "" {
		if transcript := joinDigestTranscriptFromCaptionJSONFile(path); transcript != "" {
			return transcript
		}
	}
	if transcript := joinDigestTranscriptFromCaptionItems(captionItemsFromAny(captions["tail"])); transcript != "" {
		return transcript
	}
	if transcript := joinDigestTranscriptFromCaptionItems(captionItemsFromAny(captions["latest"])); transcript != "" {
		return transcript
	}
	return ""
}

func joinDigestTranscriptFromCaptionJSONFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var payload struct {
		Captions []map[string]any `json:"captions"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	captions := payload.Captions
	if len(captions) > 80 {
		captions = captions[len(captions)-80:]
	}
	return joinDigestTranscriptFromCaptionItems(captions)
}

func captionItemsFromAny(value any) []map[string]any {
	if value == nil {
		return nil
	}
	if items, ok := value.([]map[string]any); ok {
		return items
	}
	var single map[string]any
	if decodeAny(value, &single) && len(single) > 0 {
		return []map[string]any{single}
	}
	var many []map[string]any
	if decodeAny(value, &many) {
		return many
	}
	return nil
}

func joinDigestTranscriptFromCaptionItems(items []map[string]any) string {
	var lines []string
	for _, item := range items {
		text := strings.TrimSpace(firstNonEmpty(
			stringFromMap(item, "text"),
			stringFromMap(item, "caption"),
			stringFromMap(item, "message"),
		))
		if text == "" {
			continue
		}
		speaker := firstNonEmpty(
			stringFromMap(item, "speaker"),
			stringFromMap(item, "user"),
			stringFromMap(item, "name"),
			"Speaker",
		)
		ts := firstNonEmpty(stringFromMap(item, "timestamp"), stringFromMap(item, "ts"))
		if ts != "" {
			lines = append(lines, fmt.Sprintf("[%s] %s: %s", ts, speaker, text))
		} else {
			lines = append(lines, fmt.Sprintf("%s: %s", speaker, text))
		}
	}
	return strings.Join(lines, "\n")
}

func currentJoinMonitorInterval() time.Duration {
	if value := joinMonitorIntervalOverrideNanos.Load(); value > 0 {
		return time.Duration(value)
	}
	return defaultJoinMonitorInterval
}

func currentJoinMonitorAloneTimeout() time.Duration {
	if value := joinMonitorAloneTimeoutOverrideNanos.Load(); value > 0 {
		return time.Duration(value)
	}
	return defaultJoinMonitorAloneTimeout
}

func joinMonitorEmptyRoomAutoStopDisabled() bool {
	return parseEnvBool("ONEESAMA_DISABLE_EMPTY_ROOM_AUTO_STOP") || parseEnvBool("MAB_DISABLE_EMPTY_ROOM_AUTO_STOP")
}

func parseEnvBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

type runtimeJoinSnapshot struct {
	Joined           bool
	Left             bool
	Failed           bool
	Stale            bool
	Alone            bool
	Reason           string
	ParticipantCount int
}

func runtimeJoinState(active any) runtimeJoinSnapshot {
	fields := mapFromAny(active)
	if len(fields) == 0 {
		return runtimeJoinSnapshot{Left: true, Reason: "no_active_join"}
	}
	meetPage := mapFromAny(fields["meetPage"])
	count := runtimeParticipantCount(meetPage)
	switch {
	case runtimeMeetPageUnavailable(meetPage):
		return runtimeJoinSnapshot{Stale: true, Reason: "meet_runner_page_closed"}
	case runtimeRemovedFromMeeting(meetPage):
		return runtimeJoinSnapshot{Left: true, Reason: "removed_from_meeting"}
	case runtimeJoinedEvidence(fields, meetPage, count):
		return runtimeJoinSnapshot{
			Joined:           true,
			Alone:            count > 0 && count <= 1,
			Reason:           reasonIf(count > 0 && count <= 1, "empty_room"),
			ParticipantCount: count,
		}
	case boolField(meetPage, "waitingForAdmit"), boolField(meetPage, "preJoin"), boolField(meetPage, "signIn"):
		return runtimeJoinSnapshot{}
	case boolField(meetPage, "cannotJoin"):
		return runtimeJoinSnapshot{Failed: true, Reason: "cannot_join"}
	default:
		text := strings.ToLower(stringFromMap(meetPage, "textHead"))
		if strings.Contains(text, "left the meeting") || strings.Contains(text, "return to home screen") {
			return runtimeJoinSnapshot{Left: true, Reason: "meeting_ended"}
		}
		return runtimeJoinSnapshot{}
	}
}

func runtimeJoinedEvidence(fields map[string]any, meetPage map[string]any, participantCount int) bool {
	if boolField(meetPage, "inMeeting") || participantCount > 0 {
		return true
	}
	captions := mapFromAny(fields["captions"])
	return intFromAny(captions["count"]) > 0
}

func runtimeParticipantCount(meetPage map[string]any) int {
	if len(meetPage) == 0 {
		return 0
	}
	for _, count := range participantCountsFromButtons(meetPage["buttons"]) {
		if count > 0 {
			return count
		}
	}
	for _, key := range []string{"participantCount", "participant_count", "participantsCount", "participants_count"} {
		if count := intFromAny(meetPage[key]); count > 0 {
			return count
		}
	}
	return participantCountFromText(stringFromMap(meetPage, "textHead"))
}

func participantCountsFromButtons(value any) []int {
	var buttons []map[string]any
	if !decodeAny(value, &buttons) {
		return nil
	}
	var counts []int
	for _, button := range buttons {
		label := strings.TrimSpace(fmt.Sprint(button["label"]))
		if label == "" {
			continue
		}
		count, err := strconv.Atoi(label)
		if err != nil || count <= 0 {
			continue
		}
		rect := mapFromAny(button["rect"])
		y := intFromAny(rect["y"])
		if len(rect) > 0 && y > 120 {
			continue
		}
		counts = append(counts, count)
	}
	return counts
}

func participantCountFromText(text string) int {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || len(line) > 3 {
			continue
		}
		count, err := strconv.Atoi(line)
		if err == nil && count > 0 {
			return count
		}
	}
	return 0
}

func intFromAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		count, _ := strconv.Atoi(strings.TrimSpace(typed))
		return count
	default:
		return 0
	}
}

func reasonIf(condition bool, reason string) string {
	if condition {
		return reason
	}
	return ""
}
