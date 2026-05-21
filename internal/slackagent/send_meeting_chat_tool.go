package slackagent

import (
	"context"
	"fmt"
	"strings"
)

const sendMeetingChatMissingTextReason = "missing_message_text"
const sendMeetingChatMissingMeetingReason = "missing_meeting_id"

type sendMeetingChatResponse struct {
	Success bool   `json:"success"`
	OK      bool   `json:"ok,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (s *Service) executeSendMeetingChatTool(ctx context.Context, args map[string]any) SlackToolCallResponse {
	const name = "send_meeting_chat"

	text := strings.TrimSpace(firstNonEmpty(stringFromAny(args["text"]), stringFromAny(args["message"])))
	if text == "" {
		return slackToolError(name, sendMeetingChatMissingTextReason)
	}
	meetingID := firstNonZeroInt64(
		int64FromAny(args["meeting_id"]),
		int64FromAny(args["meetingId"]),
		int64FromAny(args["remote_meeting_id"]),
		int64FromAny(args["remoteMeetingId"]),
	)
	if meetingID == 0 {
		return slackToolError(name, sendMeetingChatMissingMeetingReason)
	}

	var result sendMeetingChatResponse
	if err := s.postMeetingAgentJSON(ctx, fmt.Sprintf("/meetings/%d/chat", meetingID), map[string]any{"text": text}, &result); err != nil {
		return slackToolError(name, "meeting_chat_send_failed:"+err.Error())
	}
	if !result.Success && !result.OK {
		return slackToolError(name, firstNonEmpty(result.Error, "meeting_chat_send_failed"))
	}
	return slackToolOK(name, map[string]any{
		"meeting_id": meetingID,
		"text":       text,
		"success":    true,
	})
}
