package slackagent

import (
	"context"
	"strconv"
	"strings"
)

// notify_meeting_slack safety upgrade (P1 from the consolidated
// backlog, item #103 from the 5/13 audit, Peng 5/19 directive):
// the meeting copilot's `notify_meeting_slack` tool used to take
// channel / thread_ts / text directly from the model's tool args
// and post wherever the model said. That meant:
//
//   - a hallucinated channel id would still ship a real message
//   - a stale thread_ts could land in a random thread
//   - cross-workspace mis-routing was indistinguishable from a
//     real meeting notification
//
// The fix: the tool now resolves the target thread from durable
// meeting state instead of model args. The model still passes a
// `meeting_id` (or one of its aliases) so the tool can look up the
// linked Slack thread that the meeting was originally anchored to.
// Model-supplied `channel` / `thread_ts` are accepted ONLY as
// confirmation of the resolved values; if they disagree with the
// stored thread record, the tool refuses to post and the audit
// trail flags `target_mismatch`.
//
// If `meeting_id` is missing OR the meeting has no linked thread
// record, the tool refuses to post and returns a structured error.
// "Trust the model's free-form channel/thread" is intentionally no
// longer a code path.

const notifyMeetingSlackMissingThreadReason = "meeting_thread_lookup_missing"
const notifyMeetingSlackTargetMismatchReason = "meeting_thread_target_mismatch"
const notifyMeetingSlackMissingTextReason = "missing_message_text"

func (s *Service) executeNotifyMeetingSlackTool(ctx context.Context, args map[string]any) SlackToolCallResponse {
	const name = "notify_meeting_slack"

	text := strings.TrimSpace(firstNonEmpty(stringFromAny(args["text"]), stringFromAny(args["message"])))
	if text == "" {
		return slackToolError(name, notifyMeetingSlackMissingTextReason)
	}

	// Try every common spelling of the meeting id arg. `int64FromAny`
	// (triage_helpers.go) already handles string / int / float /
	// json.Number forms, so we don't need a separate numeric path.
	meetingID := firstNonZeroInt64(
		int64FromAny(args["meeting_id"]),
		int64FromAny(args["meetingId"]),
		int64FromAny(args["remote_meeting_id"]),
		int64FromAny(args["remoteMeetingId"]),
	)
	if meetingID == 0 {
		return slackToolError(name, "missing_meeting_id")
	}

	if s == nil || s.meetingWebhooks == nil {
		return slackToolError(name, "meeting_thread_store_unavailable")
	}

	record, err := s.meetingWebhooks.GetThreadByRemoteID(ctx, meetingID)
	if err != nil {
		return slackToolError(name, "meeting_thread_lookup_failed:"+err.Error())
	}
	if record == nil || strings.TrimSpace(record.SlackChannelID) == "" {
		return slackToolError(name, notifyMeetingSlackMissingThreadReason)
	}

	// Optional model confirmation: if the model passed channel /
	// thread_ts, they must match the stored record. Disagreement is
	// almost always a hallucination — refuse rather than overwrite
	// the stored anchor or trust the model.
	if modelChannel := strings.TrimSpace(firstNonEmpty(stringFromAny(args["channel"]), stringFromAny(args["channel_id"]))); modelChannel != "" && !strings.EqualFold(modelChannel, record.SlackChannelID) {
		return slackToolError(name, notifyMeetingSlackTargetMismatchReason+":channel")
	}
	if modelThread := strings.TrimSpace(firstNonEmpty(stringFromAny(args["thread_ts"]), stringFromAny(args["threadTs"]))); modelThread != "" && modelThread != record.SlackThreadTS {
		return slackToolError(name, notifyMeetingSlackTargetMismatchReason+":thread")
	}

	result := s.deliverSlackPublicNotification(ctx, slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceMeetingWebhook,
		Surface:   slackPublicNotificationSurfaceMeetingNotice,
		ChannelID: record.SlackChannelID,
		ThreadTS:  record.SlackThreadTS,
		Text:      text,
		DedupKey:  "notify-meeting-slack:" + strconv.FormatInt(record.RemoteMeetingID, 10),
	}).Post
	return slackToolOK(name, result)
}

// firstNonZeroInt64 returns the first non-zero value, matching the
// firstNonEmpty pattern used elsewhere in this package. Used to walk
// the alternate spellings of `meeting_id` the model might emit.
func firstNonZeroInt64(values ...int64) int64 {
	for _, v := range values {
		if v != 0 {
			return v
		}
	}
	return 0
}
