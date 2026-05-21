package meetingagent

import (
	"context"
	"errors"
	"strings"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

var errMeetdNoActiveJoiner = errors.New("no active joiner for this meeting")

type meetdChatSender interface {
	SendMeetChat(ctx context.Context, input meetrunner.MeetChatInput) (meetrunner.MeetChatResult, error)
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
	result, err := sender.SendMeetChat(ctx, meetrunner.MeetChatInput{SessionID: sessionID, Text: text})
	if err != nil {
		return false, err
	}
	return result.OK || result.Success, nil
}
