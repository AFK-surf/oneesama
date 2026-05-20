package meetingagent

import (
	"context"
	"fmt"
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
	seenJoined := false
	var aloneSince time.Time
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
		state := runtimeJoinState(status.Active)
		if state.Joined {
			seenJoined = true
			if state.ParticipantCount > 0 {
				session.ParticipantCount = state.ParticipantCount
			}
			if state.Alone {
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

type runtimeJoinSnapshot struct {
	Joined           bool
	Left             bool
	Failed           bool
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
	switch {
	case boolField(meetPage, "cannotJoin"):
		return runtimeJoinSnapshot{Failed: true, Reason: "cannot_join"}
	case boolField(meetPage, "waitingForAdmit"), boolField(meetPage, "preJoin"), boolField(meetPage, "signIn"):
		return runtimeJoinSnapshot{}
	case boolField(meetPage, "inMeeting"):
		count := runtimeParticipantCount(meetPage)
		return runtimeJoinSnapshot{
			Joined:           true,
			Alone:            count > 0 && count <= 1,
			Reason:           reasonIf(count > 0 && count <= 1, "empty_room"),
			ParticipantCount: count,
		}
	default:
		text := strings.ToLower(stringFromMap(meetPage, "textHead"))
		if strings.Contains(text, "left the meeting") || strings.Contains(text, "return to home screen") {
			return runtimeJoinSnapshot{Left: true, Reason: "meeting_ended"}
		}
		return runtimeJoinSnapshot{}
	}
}

func runtimeParticipantCount(meetPage map[string]any) int {
	if len(meetPage) == 0 {
		return 0
	}
	for _, key := range []string{"participantCount", "participant_count", "participantsCount", "participants_count"} {
		if count := intFromAny(meetPage[key]); count > 0 {
			return count
		}
	}
	for _, count := range participantCountsFromButtons(meetPage["buttons"]) {
		if count > 0 {
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
