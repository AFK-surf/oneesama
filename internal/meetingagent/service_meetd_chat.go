package meetingagent

import (
	"context"
	"errors"
	"strings"
)

var errMeetdNoActiveJoiner = errors.New("no active joiner for this meeting")

type meetdChatSender interface {
	SendMeetChat(ctx context.Context, sessionID string, text string) (bool, error)
}

func (s *Service) SendMeetdChat(ctx context.Context, meetingID int64, text string) (bool, error) {
	meeting, err := s.GetMeetdMeeting(ctx, meetingID)
	if err != nil {
		return false, err
	}
	if meeting == nil {
		return false, errMeetdNoActiveJoiner
	}
	sessionID := strings.TrimSpace(meeting.SessionID)
	if sessionID == "" {
		return false, errMeetdNoActiveJoiner
	}
	sender, ok := s.meetRunner.(meetdChatSender)
	if !ok {
		return false, errMeetdNoActiveJoiner
	}
	return sender.SendMeetChat(ctx, sessionID, text)
}
